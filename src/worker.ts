import "dotenv/config";
import { Client as PgClient } from "pg";
import { EventName, OptionType, OrderAction, OrderType, SecType, TimeInForce } from "@stoqey/ib";
import type { Contract, ComboLeg, Execution, Order as IbkrOrder } from "@stoqey/ib";
import { db } from "./db/connection.js";
import { environment } from "./config/env.js";
import { persistentIbkrConnection } from "./ibkr/persistentConnection.js";
import { resolveContractId } from "./ibkr/resolveContractId.js";
import { buildLegContract, computeNetLimitPrice, type OrderLegPayload, type OrderRequestPayload } from "./ibkr/orderPayload.js";

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

  const comboLegs: ComboLeg[] = payload.legs.map((leg, index) => ({
    conId: conIds[index]!,
    ratio: leg.quantity,
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
  // each ComboLeg's own action + ratio (set above) is what actually encodes
  // which legs are bought vs. sold and in what proportion. totalQuantity is
  // the number of combo "units" (1 = exactly the leg ratios specified).
  const order: IbkrOrder = {
    action: OrderAction.BUY,
    orderType: OrderType.LMT,
    lmtPrice: computeNetLimitPrice(payload.legs),
    totalQuantity: 1,
    tif: TimeInForce.DAY,
    transmit: true,
  };
  return { contract, order };
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
    processOrderRequest(message.payload).catch((error) => console.error(`Order request processing failed: ${error}`));
  });
  client.on("error", (error) => console.error(`order_requests LISTEN connection error: ${error.message}`));

  // A missed NOTIFY (e.g. a reconnect window) shouldn't leave a confirmed
  // order stuck forever — this short poll is the fallback safety net.
  setInterval(async () => {
    const stuck = await db("order_requests").where({ status: "confirmed" }).select("id");
    for (const row of stuck) await processOrderRequest(row.id);
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
 * Idempotent by construction — trades.ibkr_exec_id is UNIQUE, and each
 * partial fill has its own distinct execId (see @stoqey/ib's Execution type
 * doc comment), so re-processing the same execDetails event (e.g. after a
 * reconnect) is safe: the insert is a no-op on conflict.
 */
async function recordExecution(contract: Contract, execution: Execution): Promise<void> {
  if (!execution.execId || !contract.conId) return;

  const existing = await db("trades").where({ ibkr_exec_id: execution.execId }).first();
  if (existing) return;

  const leg = await db("position_legs").where({ ibkr_contract_id: String(contract.conId) }).whereNull("exit_at").first();
  const isClosing = execution.side === "BOT" ? leg?.side === "short" : leg?.side === "long";

  if (leg) {
    if (isClosing) {
      await db("position_legs")
        .where({ id: leg.id })
        .update({ exit_price: execution.price, exit_at: execution.time ? new Date(execution.time) : new Date() });
      await db("trades").insert({
        position_leg_id: leg.id,
        ibkr_order_id: String(execution.orderId ?? ""),
        ibkr_exec_id: execution.execId,
        side: execution.side === "BOT" ? "buy" : "sell",
        quantity: execution.shares ?? 0,
        price: execution.price ?? 0,
        executed_at: execution.time ? new Date(execution.time) : new Date(),
        is_closing_trade: true,
      });

      const remainingOpenLegs = await db("position_legs").where({ position_id: leg.position_id }).whereNull("exit_at");
      if (remainingOpenLegs.length === 0) {
        await db("positions").where({ id: leg.position_id }).update({ status: "closed", closed_at: db.fn.now() });
      }
      return;
    }
  }

  // No matching open leg — this is either a brand-new position-opening fill
  // (from an order this worker just placed, or one placed outside the app
  // entirely) or an add-to-an-existing-holding fill. Full new-position
  // creation/pairing from a bare execution (matching it to an
  // order_requests row for strategyKey context, or falling back to
  // "unstructured" per the pairing-heuristic decision) is handled by
  // reconcilePositionsFromIbkr's periodic reqPositions() pass rather than
  // here, since that pass has the full current-holdings picture needed to
  // pair a stock leg with an option leg correctly — this handler's job is
  // just to record the raw execution/trade row idempotently.
  console.log(`Execution ${execution.execId} for conId ${contract.conId} has no matching open leg — awaiting next reconciliation pass.`);
}

interface IbkrHeldPosition {
  contract: Contract;
  quantity: number;
  avgCost: number;
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

  const held = await new Promise<IbkrHeldPosition[]>((resolve) => {
    const rows: IbkrHeldPosition[] = [];
    const onPosition = (_account: string, contract: Contract, pos: number, avgCost?: number) => {
      if (pos !== 0) rows.push({ contract, quantity: pos, avgCost: avgCost ?? 0 });
    };
    const onEnd = () => {
      ib.off(EventName.position, onPosition);
      ib.off(EventName.positionEnd, onEnd);
      resolve(rows);
    };
    ib.on(EventName.position, onPosition);
    ib.once(EventName.positionEnd, onEnd);
    ib.reqPositions();
  });

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
  // all (fully closed) — mark it closed. Per-leg exit_price ideally comes
  // from execDetails (recordExecution above); this is the backstop for
  // when a close happened before this worker was running to see the fill.
  const heldConIds = new Set(held.map((p) => p.contract.conId).filter((id): id is number => id !== undefined));
  const openLegs = await db("position_legs").whereNull("exit_at").whereNotNull("ibkr_contract_id");
  for (const leg of openLegs) {
    if (!heldConIds.has(Number(leg.ibkr_contract_id))) {
      await db("position_legs").where({ id: leg.id }).update({ exit_at: db.fn.now() });
      const remainingOpenLegs = await db("position_legs").where({ position_id: leg.position_id }).whereNull("exit_at");
      if (remainingOpenLegs.length === 0) {
        await db("positions").where({ id: leg.position_id }).update({ status: "closed", closed_at: db.fn.now() });
      }
    }
  }
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
  } else {
    await db("positions").where({ id: positionId }).update({ strategy_key: strategyKey });
  }

  for (const leg of legs) {
    const conId = String(leg.held.contract.conId);
    const existing = await db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at").first();
    if (existing) continue; // already tracked, nothing to insert

    const contract = leg.held.contract;
    // avgCost from IBKR's `position` event: for stock, cost per share; for
    // options, per @stoqey/ib's convention this already includes the
    // multiplier (total $ per contract, not per-share) — NEEDS VERIFICATION
    // against a real paper position before this is trusted (plan doc's
    // verification step 3). Flagging rather than asserting confidently.
    const entryPrice = contract.secType === SecType.STK ? leg.held.avgCost : leg.held.avgCost / (contract.multiplier ?? 100);

    await db("position_legs").insert({
      position_id: positionId,
      leg_type: contract.secType === SecType.STK ? "stock" : "option",
      side: leg.side,
      quantity: Math.abs(leg.held.quantity),
      option_type: contract.right === OptionType.Call ? "call" : contract.right === OptionType.Put ? "put" : null,
      strike_price: contract.strike ?? null,
      expiry_date: contract.lastTradeDateOrContractMonth ?? null,
      multiplier: contract.multiplier ?? 1,
      ibkr_contract_id: conId,
      entry_price: entryPrice,
      entry_at: db.fn.now(),
    });
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
