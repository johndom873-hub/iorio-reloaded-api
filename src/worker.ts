import "dotenv/config";
import { Client as PgClient } from "pg";
import { EventName, OptionType, OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { Contract, ComboLeg, Execution, Order as IbkrOrder } from "@stoqey/ib";
import { db } from "./db/connection.js";
import { environment } from "./config/env.js";
import { persistentIbkrConnection } from "./ibkr/persistentConnection.js";
import { resolveContractId } from "./ibkr/resolveContractId.js";
import { buildLegContract, computeNetLimitPrice, type OrderLegPayload, type OrderRequestPayload } from "./ibkr/orderPayload.js";
import { parseIbkrExecutionTime } from "./ibkr/parseIbkrExecutionTime.js";
import { fetchIbkrHeldPositions, type IbkrHeldPosition } from "./ibkr/fetchIbkrHeldPositions.js";

/**
 * The persistent worker process — see PROGRESS.md's "IBKR is the source of
 * truth" decision (2026-08-24) and the plan at
 * ~/.claude/plans/purring-tumbling-lemur.md for the full design.
 *
 * Owns the one long-lived IBKR connection in this app. Does two jobs:
 *  1. Places orders queued by the web dyno (order_requests table, picked up
 *     via Postgres LISTEN/NOTIFY) and tracks their status.
 *  2. Continuously reconciles IBKR's own reported positions/executions into
 *     positions/position_legs/trades, so those tables are always a mirror
 *     of IBKR, never an independently-maintained ledger.
 *
 * The web dyno never writes positions/position_legs/trades directly anymore
 * — only this process does, and only from data IBKR itself reported.
 */

const orderRequestsChannel = "order_requests_channel";
const reconciliationIntervalMs = 60_000;
const positionReqId = 1;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Resolves every leg's conId (reusing a pre-resolved one where the payload already has it). */
async function resolveLegContractIds(
  ib: ReturnType<typeof persistentIbkrConnection.getIb>,
  legs: OrderLegPayload[],
): Promise<(number | null)[]> {
  if (!ib) return legs.map(() => null);
  let reqId = 70_000;
  const results: (number | null)[] = [];
  for (const leg of legs) {
    if (leg.ibkrContractId) {
      results.push(leg.ibkrContractId);
      continue;
    }
    results.push(await resolveContractId(ib, buildLegContract(leg), reqId++));
  }
  return results;
}

/**
 * Builds the IBKR Contract + Order for an order_requests row. A single leg
 * is a plain limit order; multiple legs become one atomic BAG combo order
 * (approved 2026-08-24 specifically to avoid a naked-exposure window — see
 * the plan doc's "Order atomicity" decision). This is the most
 * safety-critical piece of the whole redesign and needs real paper-account
 * verification (plan doc's verification step 3) before being trusted.
 */
async function buildOrder(payload: OrderRequestPayload): Promise<{ contract: Contract; order: IbkrOrder } | null> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return null;

  const conIds = await resolveLegContractIds(ib, payload.legs);
  if (conIds.some((conId) => conId === null)) return null;

  if (payload.legs.length === 1) {
    const leg = payload.legs[0]!;
    const contract = { ...buildLegContract(leg), conId: conIds[0]! };
    const order: IbkrOrder = {
      action: leg.action,
      orderType: OrderType.LMT,
      lmtPrice: leg.unitPrice,
      totalQuantity: leg.quantity,
      tif: TimeInForce.DAY,
      transmit: true,
    };
    return { contract, order };
  }

  // Real bug found 2026-08-24 closing a real 3-contract covered call: using
  // each leg's raw quantity as its ratio (300 shares : 3 contracts) isn't a
  // valid IBKR combo ratio — IBKR rejected it outright ("error 321: Invalid
  // leg ratio"). It only happened to work before because every order tested
  // so far was exactly 1 contract (100 shares : 1 contract, already in
  // lowest terms). IBKR combo ratios must be reduced to their smallest
  // integer terms, with totalQuantity carrying the reduced-out common
  // factor (the number of combo "units") — not always 1.
  const legRatioGcd = payload.legs.map((leg) => leg.quantity).reduce((a, b) => gcd(a, b));
  const comboLegs: ComboLeg[] = payload.legs.map((leg, index) => ({
    conId: conIds[index]!,
    ratio: leg.quantity / legRatioGcd,
    action: leg.action,
    exchange: "SMART",
  }));
  const contract: Contract = {
    symbol: payload.symbol,
    secType: SecType.BAG,
    currency: "USD",
    exchange: "SMART",
    comboLegs,
  };
  // Convention for combo/BAG orders: the top-level order action is BUY, and
  // each ComboLeg's own action + reduced ratio (set above) is what actually
  // encodes which legs are bought vs. sold and in what proportion.
  // totalQuantity is the number of combo "units" — legRatioGcd, not always 1.
  const order: IbkrOrder = {
    action: OrderAction.BUY,
    orderType: OrderType.LMT,
    lmtPrice: computeNetLimitPrice(payload.legs),
    totalQuantity: legRatioGcd,
    tif: TimeInForce.DAY,
    transmit: true,
  };
  return { contract, order };
}

/**
 * Cancels an order already submitted to IBKR (route: POST
 * /orders/:id/cancel, which flips status to "cancel_requested" and NOTIFYs
 * this same channel). Only this process holds the persistent IBKR
 * connection, so only it can call ib.cancelOrder() — the existing
 * orderStatus listener (see setupOrderTrackingListeners) flips the row to
 * "cancelled" once IBKR confirms, same as every other terminal status.
 */
async function processCancelRequest(orderRequestId: string): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "cancel_requested" }).first();
  if (!orderRequest) return; // already processed (cancelled/filled) or not actually requested

  if (!orderRequest.ibkr_order_id) {
    // Shouldn't happen — cancel_requested is only reachable from
    // submitted/partially_filled, both of which have an ibkr_order_id — but
    // fail safe rather than leaving the row stuck.
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "error", error_message: "cancel_requested with no ibkr_order_id.", updated_at: db.fn.now() });
    return;
  }

  ib.cancelOrder(orderRequest.ibkr_order_id);
}

async function processOrderRequest(orderRequestId: string): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const orderRequest = await db("order_requests").where({ id: orderRequestId, status: "confirmed" }).first();
  if (!orderRequest) return; // already processed, cancelled, or not actually confirmed

  const payload = orderRequest.payload as OrderRequestPayload;
  try {
    const built = await buildOrder(payload);
    if (!built) {
      await db("order_requests")
        .where({ id: orderRequestId })
        .update({ status: "error", error_message: "Could not resolve one or more contract ids.", updated_at: db.fn.now() });
      return;
    }

    const ibkrOrderId = persistentIbkrConnection.getNextOrderId();
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({ status: "submitted", ibkr_order_id: ibkrOrderId, updated_at: db.fn.now() });

    ib.placeOrder(ibkrOrderId, built.contract, built.order);
  } catch (error) {
    await db("order_requests")
      .where({ id: orderRequestId })
      .update({
        status: "error",
        error_message: error instanceof Error ? error.message : String(error),
        updated_at: db.fn.now(),
      });
  }
}

/**
 * The web dyno NOTIFYs the same channel for both a fresh confirm and a
 * cancel request, distinguished by the row's current status — dispatches to
 * whichever this row actually needs.
 */
async function handleOrderRequestNotification(orderRequestId: string, knownStatus?: string): Promise<void> {
  const status = knownStatus ?? (await db("order_requests").where({ id: orderRequestId }).first())?.status;
  if (status === "cancel_requested") {
    await processCancelRequest(orderRequestId);
  } else {
    await processOrderRequest(orderRequestId);
  }
}

/** Postgres LISTEN/NOTIFY — the web dyno NOTIFYs this channel with the order_requests.id on confirm. */
async function listenForOrderRequests(): Promise<void> {
  const client = new PgClient({
    connectionString: environment.databaseUrl,
    ssl: environment.nodeEnvironment === "production" ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  await client.query(`LISTEN ${orderRequestsChannel}`);
  client.on("notification", (message) => {
    if (message.channel !== orderRequestsChannel || !message.payload) return;
    handleOrderRequestNotification(message.payload).catch((error) => console.error(`Order request processing failed: ${error}`));
  });
  client.on("error", (error) => console.error(`order_requests LISTEN connection error: ${error.message}`));

  // A missed NOTIFY (e.g. a reconnect window) shouldn't leave a confirmed
  // order, or a cancel request, stuck forever — this short poll is the
  // fallback safety net for both.
  setInterval(async () => {
    const stuck = await db("order_requests").whereIn("status", ["confirmed", "cancel_requested"]).select("id", "status");
    for (const row of stuck) await handleOrderRequestNotification(row.id, row.status);
  }, 30_000);
}

function orderStatusToRequestStatus(status: string): string | null {
  if (status === "Filled") return "filled";
  if (status === "Cancelled" || status === "ApiCancelled") return "cancelled";
  if (status === "Submitted" || status === "PreSubmitted") return "submitted";
  return null;
}

function setupOrderTrackingListeners(): void {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  ib.on(EventName.orderStatus, (orderId, status, filled, remaining) => {
    const requestStatus = filled > 0 && remaining > 0 ? "partially_filled" : orderStatusToRequestStatus(status);
    if (!requestStatus) return;
    db("order_requests")
      .where({ ibkr_order_id: orderId })
      .update({ status: requestStatus, updated_at: db.fn.now() })
      .catch((error) => console.error(`Failed to update order_requests for order ${orderId}: ${error}`));
  });

  ib.on(EventName.execDetails, (_reqId, contract, execution) => {
    recordExecution(contract, execution).catch((error) => console.error(`Failed to record execution: ${error}`));
  });

  // Found by real testing (2026-08-24): a rejected/errored order surfaces
  // only as an EventName.error keyed by the order id, not an orderStatus
  // event — without this listener a rejection vanished with zero trace
  // anywhere (order_requests stuck at "submitted" forever, nothing in
  // reqAllOpenOrders, no log line). informational connection-status notices
  // (reqId -1) are excluded, same as connectIbkr.ts's handshake filtering.
  //
  // Also found by testing: not every EventName.error keyed by a real order
  // id is a rejection — code 399 ("Order Message") is IBKR attaching an
  // informational/warning notice to an order that was still accepted (e.g.
  // "will not be placed at the exchange until <next session open>" outside
  // market hours). IBKR's own convention is that the 2100-2169 range is
  // informational "system messages" too. Treating these as fatal would
  // flip a perfectly good queued order to "error".
  ib.on(EventName.error, (error, code, reqId) => {
    if (reqId === -1) return;
    if (code === 399 || (code >= 2100 && code <= 2169)) {
      console.log(`Order ${reqId} informational message: ${code} ${error.message}`);
      return;
    }
    db("order_requests")
      .where({ ibkr_order_id: reqId, status: "submitted" })
      .update({ status: "error", error_message: `IBKR error ${code}: ${error.message}`, updated_at: db.fn.now() })
      .then((updatedRowCount) => {
        if (updatedRowCount > 0) console.error(`Order ${reqId} errored: ${code} ${error.message}`);
      })
      .catch((dbError) => console.error(`Failed to record order error for ${reqId}: ${dbError}`));
  });
}

/**
 * Real bug found 2026-08-24 testing against 3 genuine paper fills: an
 * opening execution (no position_leg exists yet — reconcilePositionsFromIbkr
 * hasn't created it) was silently dropped instead of ever being recorded,
 * leaving the Trade Blotter permanently empty for every opening trade. This
 * buffers that raw execution, keyed by conId, so upsertSyncedPosition can
 * drain it into a real trades row the moment it creates the matching leg —
 * using the actual per-fill execution data (execId, price, quantity), not a
 * synthesized one from IBKR's aggregate avgCost.
 */
const pendingOpeningExecutions = new Map<string, { contract: Contract; execution: Execution }[]>();

async function insertOpeningTradeRow(positionLegId: string, contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId) return;
  await db("trades")
    .insert({
      position_leg_id: positionLegId,
      ibkr_order_id: String(execution.orderId ?? ""),
      ibkr_exec_id: execution.execId,
      side: execution.side === "BOT" ? "buy" : "sell",
      quantity: execution.shares ?? 0,
      price: execution.price ?? 0,
      executed_at: parseIbkrExecutionTime(execution.time) ?? new Date(),
      is_closing_trade: false,
    })
    .onConflict("ibkr_exec_id")
    .ignore();
}

/**
 * Idempotent by construction — trades.ibkr_exec_id is UNIQUE, and each
 * partial fill has its own distinct execId (see @stoqey/ib's Execution type
 * doc comment), so re-processing the same execDetails event (e.g. after a
 * reconnect) is safe: the insert is a no-op on conflict.
 */
async function recordExecution(contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId || !contract.conId) return;

  const existing = await db("trades").where({ ibkr_exec_id: execution.execId }).first();
  if (existing) return;

  const conId = String(contract.conId);
  const leg = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").first();

  if (!leg) {
    // Brand-new position-opening fill (or one placed outside the app
    // entirely) — the leg doesn't exist yet because reconcilePositionsFromIbkr
    // hasn't run since this fill. Buffer it; upsertSyncedPosition drains this
    // once it creates the leg. (Real new-position creation/pairing itself
    // still only happens there, since that pass has the full current-holdings
    // picture needed to pair a stock leg with an option leg correctly.)
    const buffered = pendingOpeningExecutions.get(conId) ?? [];
    buffered.push({ contract, execution });
    pendingOpeningExecutions.set(conId, buffered);
    console.log(`Execution ${execution.execId} for conId ${conId} has no matching open leg yet — buffered for the next reconciliation pass.`);
    return;
  }

  const isClosing = execution.side === "BOT" ? leg.side === "short" : leg.side === "long";
  if (!isClosing) {
    // An add-on fill to an already-tracked leg (e.g. bought more of an
    // existing covered call's stock leg) — not a close, but still a real
    // execution the Trade Blotter should show. The leg's own `quantity`
    // doesn't get updated here (see upsertSyncedPosition for why) —
    // trigger reconciliation now so that sync reflects promptly rather
    // than waiting for the periodic 60s pass.
    await insertOpeningTradeRow(leg.id, contract, execution);
    reconcilePositionsFromIbkr().catch((error) => console.error(`Post-execution reconciliation failed: ${error}`));
    return;
  }

  // Record the trade only — do NOT flip position_legs.exit_at/exit_price
  // here. Real bug found 2026-08-25 on a same-day HOOD test position: a
  // single closing execution may only be a *partial* close (a 1-lot
  // closing fill on a 3-lot leg previously marked the WHOLE leg closed,
  // hiding the still-open 2-lot remainder — IBKR itself still held it).
  // reconcilePositionsFromIbkr is now the sole place a leg gets closed,
  // gated on IBKR reporting zero remaining holding for this conId — the
  // only unambiguous "genuinely fully closed" signal, regardless of how
  // many partial fills got there. Trigger it now so closing still reflects
  // near-instantly rather than waiting for the periodic 60s pass.
  await db("trades").insert({
    position_leg_id: leg.id,
    ibkr_order_id: String(execution.orderId ?? ""),
    ibkr_exec_id: execution.execId,
    side: execution.side === "BOT" ? "buy" : "sell",
    quantity: execution.shares ?? 0,
    price: execution.price ?? 0,
    executed_at: parseIbkrExecutionTime(execution.time) ?? new Date(),
    is_closing_trade: true,
  });

  reconcilePositionsFromIbkr().catch((error) => console.error(`Post-execution reconciliation failed: ${error}`));
}

/**
 * Pulls IBKR's actual current holdings and reconciles them into
 * positions/position_legs — the core of "the interface matches IBKR
 * exactly." Pairing heuristic (approved 2026-08-24): group by underlying
 * symbol; long stock + short call on the same symbol pairs into
 * covered_call (respecting the same coverage-must-not-exceed-stock rule as
 * validateCoveredCallCoverage); a lone short put pairs into
 * cash_secured_put; anything left over is surfaced as strategy_key
 * "unstructured" rather than hidden.
 */
async function reconcilePositionsFromIbkr(): Promise<void> {
  const ib = persistentIbkrConnection.getIb();
  if (!ib) return;

  const held = await fetchIbkrHeldPositions(ib);

  const bySymbol = new Map<string, IbkrHeldPosition[]>();
  for (const position of held) {
    const symbol = position.contract.symbol ?? "UNKNOWN";
    const existing = bySymbol.get(symbol) ?? [];
    existing.push(position);
    bySymbol.set(symbol, existing);
  }

  for (const [symbol, positionsForSymbol] of bySymbol) {
    const stockLeg = positionsForSymbol.find((p) => p.contract.secType === SecType.STK && p.quantity > 0);
    const shortCallLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Call && p.quantity < 0,
    );
    const shortPutLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Put && p.quantity < 0,
    );

    const totalShortCallShares = shortCallLegs.reduce((sum, leg) => sum + Math.abs(leg.quantity) * 100, 0);
    const isCoveredCall = stockLeg && shortCallLegs.length > 0 && totalShortCallShares <= stockLeg.quantity;

    if (isCoveredCall) {
      await upsertSyncedPosition(symbol, "covered_call", [
        { held: stockLeg, side: "long" },
        ...shortCallLegs.map((leg) => ({ held: leg, side: "short" as const })),
      ]);
    } else if (!stockLeg && shortCallLegs.length === 0 && shortPutLegs.length > 0) {
      await upsertSyncedPosition(
        symbol,
        "cash_secured_put",
        shortPutLegs.map((leg) => ({ held: leg, side: "short" as const })),
      );
    } else {
      // Doesn't cleanly pair — surfaced, not hidden (approved 2026-08-24).
      await upsertSyncedPosition(
        symbol,
        "unstructured",
        positionsForSymbol.map((leg) => ({ held: leg, side: leg.quantity > 0 ? ("long" as const) : ("short" as const) })),
      );
    }
  }

  // Anything tracked as open in our DB but no longer reported by IBKR at
  // all — this is the sole place a leg is ever marked closed (see
  // recordExecution above for why a single closing execution can't decide
  // this on its own: a partial close previously flipped an entire
  // multi-lot leg to closed and hid the still-open remainder). exit_price
  // comes from the most recent closing trade already recorded for this
  // leg by recordExecution, if any — falls back to "now"/null for a close
  // that happened before this worker ever saw the fill (e.g. placed
  // directly in TWS, or before the worker was deployed).
  const heldConIds = new Set(held.map((p) => p.contract.conId).filter((id): id is number => id !== undefined));
  const openLegs = await db("position_legs").whereNull("exit_at").whereNotNull("ibkr_contract_id");
  for (const leg of openLegs) {
    if (heldConIds.has(Number(leg.ibkr_contract_id))) continue;

    const lastClosingTrade = await db("trades")
      .where({ position_leg_id: leg.id, is_closing_trade: true })
      .orderBy("executed_at", "desc")
      .first();

    await db("position_legs")
      .where({ id: leg.id })
      .update({ exit_price: lastClosingTrade?.price ?? null, exit_at: lastClosingTrade?.executed_at ?? db.fn.now() });

    const remainingOpenLegs = await db("position_legs").where({ position_id: leg.position_id }).whereNull("exit_at");
    if (remainingOpenLegs.length === 0) {
      await db("positions").where({ id: leg.position_id }).update({ status: "closed", closed_at: db.fn.now() });
    }
  }
}

/**
 * Fills in trade_alerts.resulting_position_id for a brand-new position
 * (known gap flagged 2026-08-24: a `roll` already knows related_position_id
 * at confirm time, but a new_trade alert's position doesn't exist until
 * this reconciliation pass creates it — nothing wrote the link back until
 * now). Matches on symbol + still-unlinked alert rather than a contract id,
 * since the order_requests payload for a brand-new open never has a conId
 * (it isn't resolved until the worker places the order) — safe because this
 * only matches request_types that never set related_position_id (an
 * open_covered_call/open_cash_secured_put, never a roll/close), and only
 * order_requests that came from a trade alert in the first place (a
 * manually-entered new position has no source_alert_id, so nothing to link).
 */
async function backfillAlertResultingPositionId(symbol: string, positionId: string): Promise<void> {
  const orderRequest = await db("order_requests as orq")
    .join("trade_alerts as ta", "ta.id", "orq.source_alert_id")
    .whereIn("orq.request_type", ["open_covered_call", "open_cash_secured_put"])
    .whereIn("orq.status", ["filled", "partially_filled"])
    .whereRaw("orq.payload->>'symbol' = ?", [symbol])
    .whereNull("ta.resulting_position_id")
    .orderBy("orq.created_at", "asc")
    .first({ alertId: "ta.id" });
  if (!orderRequest) return;

  await db("trade_alerts").where({ id: orderRequest.alertId }).update({ resulting_position_id: positionId });
}

async function upsertSyncedPosition(
  symbol: string,
  strategyKey: string,
  legs: { held: IbkrHeldPosition; side: "long" | "short" }[],
): Promise<void> {
  const conIds = legs.map((leg) => String(leg.held.contract.conId));
  const existingLegs = await db("position_legs").whereIn("ibkr_contract_id", conIds).whereNull("exit_at");

  let positionId = existingLegs[0]?.position_id as string | undefined;
  if (!positionId) {
    let ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcilePositionsFromIbkr: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: strategyKey, ticker_id: ticker.id, status: "open" })
      .returning(["id"]);
    positionId = newPosition.id;
    await backfillAlertResultingPositionId(symbol, positionId!);
  } else {
    await db("positions").where({ id: positionId }).update({ strategy_key: strategyKey });
  }

  for (const leg of legs) {
    const conId = String(leg.held.contract.conId);
    const contract = leg.held.contract;
    // avgCost from IBKR's `position` event: for stock, cost per share; for
    // options, per @stoqey/ib's convention this already includes the
    // multiplier (total $ per contract, not per-share) — NEEDS VERIFICATION
    // against a real paper position before this is trusted (plan doc's
    // verification step 3). Flagging rather than asserting confidently.
    const entryPrice = contract.secType === SecType.STK ? leg.held.avgCost : leg.held.avgCost / (contract.multiplier ?? 100);
    const trueQuantity = Math.abs(leg.held.quantity);

    const existing = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").first();
    if (existing) {
      // Sync to IBKR's current truth on every pass, not just at creation.
      // Real bug found 2026-08-25 on a real MU position: two separate
      // 100-share opening orders for the same contract, 5 min apart, left
      // `quantity` stuck at 100 (whatever it was when this leg was first
      // created) even though `trades` correctly recorded both fills.
      // IBKR's `position` event always reports the CURRENT total holding +
      // blended average cost for this conId, never an increment, so it's
      // always safe to overwrite while the leg is still open.
      if (Number(existing.quantity) !== trueQuantity || Number(existing.entry_price) !== entryPrice) {
        await db("position_legs").where({ id: existing.id }).update({ quantity: trueQuantity, entry_price: entryPrice });
      }
      continue;
    }

    const [newLeg] = await db("position_legs")
      .insert({
        position_id: positionId,
        leg_type: contract.secType === SecType.STK ? "stock" : "option",
        side: leg.side,
        quantity: trueQuantity,
        option_type: contract.right === OptionType.Call ? "call" : contract.right === OptionType.Put ? "put" : null,
        // Same story as expiry_date below: IBKR reports strike as 0 (not
        // undefined) for a stock contract, and 0 ?? null still evaluates to 0
        // — stored as a truthy string ("0.0000") by the time it round-trips
        // through Postgres, which could mislead any caller checking
        // `if (leg.strikePrice)` to assume this stock leg is an option.
        strike_price: contract.secType === SecType.STK ? null : (contract.strike ?? null),
        // A stock leg's contract has no expiry — IBKR reports it as "", not
        // undefined/null, for that field. `??` doesn't catch an empty string
        // (same recurring bug class as reqContractDetails elsewhere in this
        // codebase, see PROGRESS.md) — the Postgres `date` column rejected it
        // outright and crashed reconciliation mid-loop before any legs (or
        // subsequent positions in the same pass) could be written.
        expiry_date: contract.lastTradeDateOrContractMonth || null,
        // Third instance of the same bug: IBKR reports a stock contract's
        // multiplier as "" (falsy but not nullish), not the conceptually
        // correct 1 — found 2026-08-24 when it silently zeroed out a real
        // stock leg's entire contribution to unrealized P&L (positions.ts's
        // formula multiplies every leg's price move by leg.multiplier).
        multiplier: contract.secType === SecType.STK ? 1 : (contract.multiplier ?? 1),
        ibkr_contract_id: conId,
        entry_price: entryPrice,
        entry_at: db.fn.now(),
      })
      .returning(["id"]);

    // Drain any opening execution(s) recordExecution buffered before this
    // leg existed (see pendingOpeningExecutions) — one trades row per real
    // fill, not a single synthesized one, so partial fills still show
    // individually in the Trade Blotter.
    const buffered = pendingOpeningExecutions.get(conId);
    if (buffered) {
      pendingOpeningExecutions.delete(conId);
      for (const { contract: bufferedContract, execution } of buffered) {
        await insertOpeningTradeRow(newLeg!.id, bufferedContract, execution);
      }
    }
  }
}

async function main(): Promise<void> {
  await persistentIbkrConnection.start();
  persistentIbkrConnection.onConnect(() => {
    setupOrderTrackingListeners();
    reconcilePositionsFromIbkr().catch((error) => console.error(`Initial reconciliation failed: ${error}`));
  });

  await listenForOrderRequests();

  setInterval(() => {
    reconcilePositionsFromIbkr().catch((error) => console.error(`Periodic reconciliation failed: ${error}`));
  }, reconciliationIntervalMs);

  console.log("Iorio worker started — persistent IBKR connection, order placement, position sync.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
