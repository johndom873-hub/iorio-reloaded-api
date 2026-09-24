import { OptionType, SecType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { IbkrHeldPosition } from "./ibkrGatewayFetchHeldPositions.js";
import { fetchPositionById, type PositionLegRow } from "../lib/positionQueries.js";
import { formatPositionExpiredMessage } from "../lib/formatPositionExpiredMessage.js";
import { publishNotification } from "../lib/notificationChannel.js";
import { readExpirySettlementMode, runExpirySettlementAudit, summarizeExpirySettlement } from "../lib/expirySettlementAudit.js";
import { classifyOptionLegRetirement, type OptionLegRetirementEvidence } from "../lib/optionLegRetirement.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// What this module needs from the worker process itself. Injected so the pass can run against a
// database without the worker's IBKR connection, execution buffer or Telegram plumbing (the
// scenario tests, and any local replay of synthetic IBKR holdings).
export interface ReconciliationDependencies {
  notifyTelegram: (message: string) => Promise<void>;
  /** Writes the opening trades recordExecution buffered for a conId before its leg existed. */
  drainPendingOpeningExecutions: (conId: string, newLegId: string) => Promise<void>;
}

/** Closes a leftover-stock position whose shares are now covered by a newly sold call. */
export const closeReasonStockRolledIntoCoveredCall = "stock_rolled_into_covered_call";

// A covered call whose short call was bought back is usually mid-roll: the new call's fill lands
// seconds later (lot-by-lot rolls have been observed spanning ~4s). Handing its shares to a
// leftover-stock position in that window would create a position that the very next pass has to
// hand straight back. A call retired by a trade therefore only counts as settled once it is this
// old; a call retired by expiry settles immediately.
const tradeRetirementSettleGraceMs = 10 * 60_000;

let dependencies: ReconciliationDependencies;
let currentPassId = 0;
let heldStockSharesBySymbol = new Map<string, number>();
let legsHandedOffThisPass = 0;

// Right-after-expiry correction (approved 2026-09-22, replaces waiting up to a day for the nightly
// expiry_settlement_audit). Reuses that audit unchanged: the expiry-day bar already exists by the time
// IBKR stops reporting the option, so the objective in-the-money test works immediately. Never lets a
// failure break reconciliation.
async function correctExpirySettlementsNow(passId: number): Promise<void> {
  try {
    const mode = readExpirySettlementMode();
    const result = await runExpirySettlementAudit(mode);
    const { changes, skipped, notify } = summarizeExpirySettlement(mode, result);
    for (const action of result.actions) console.log(`Reconciliation #${passId}: expiry settlement [${mode}] ${action.kind}: ${action.description}`);
    console.log(`Reconciliation #${passId}: expiry settlement (${mode}): ${result.legsExamined} expired short leg(s) examined, ${changes.length} correction(s), ${skipped.length} skipped.`);
    if (notify) await dependencies.notifyTelegram(notify);
  } catch (error) {
    console.error(`Reconciliation #${passId}: expiry settlement correction failed: ${error instanceof Error ? error.message : error}`);
  }
}

async function logPlatformAnomaly(
  anomalyType: string,
  detail: string,
  ids: { positionId?: string; orderRequestId?: string } = {},
): Promise<void> {
  await db("platform_anomalies").insert({
    anomaly_type: anomalyType,
    position_id: ids.positionId ?? null,
    order_request_id: ids.orderRequestId ?? null,
    detail,
  });
}

// Stock-only leftover (no calls sold against it at all) traces back to
// exactly one of two known causes: a covered call's short call expired
// worthless (its own close_reason already recorded that), or a
// cash-secured put got assigned (same). Looked up by the most recently
// closed covered_call/cash_secured_put position on this ticker — if
// neither matches, this is a genuinely unexplained appearance of stock and
// gets logged as a platform anomaly rather than silently labeled.
async function determineLeftoverStockReason(symbol: string): Promise<string> {
  const ticker = await db("tickers").where({ symbol }).first();
  if (!ticker) return "unknown";

  // The covered call that just lost its call to expiry may still be open at
  // this point (it hands its shares over, and closes, only after this reason
  // is computed), so the "most recently closed position" lookup below cannot
  // see it yet. Detect it from the leg itself: a short call on an open
  // position that is past expiry (or already swept closed) with no closing
  // trade.
  const expiredCallLeg = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": ticker.id, "p.status": "open", "pl.leg_type": "option", "pl.option_type": "call", "pl.side": "short" })
    .andWhere((builder) =>
      builder.whereNotNull("pl.exit_at").orWhereRaw("pl.expiry_date <= (now() at time zone 'America/New_York')::date"),
    )
    .whereNotExists(db("trades as t").whereRaw("t.position_leg_id = pl.id").where("t.is_closing_trade", true))
    .first("pl.id");
  if (expiredCallLeg) return "cc_expired_leftover_stock";

  const recentClosed = await db("positions")
    .where({ ticker_id: ticker.id })
    .whereIn("strategy_key", ["covered_call", "cash_secured_put"])
    .whereNotNull("closed_at")
    .orderBy("closed_at", "desc")
    .first();

  if (recentClosed?.strategy_key === "covered_call" && recentClosed.close_reason === "expired_worthless") {
    return "cc_expired_leftover_stock";
  }
  if (recentClosed?.strategy_key === "cash_secured_put" && recentClosed.close_reason === "assigned") {
    return "csp_assigned_stock";
  }
  return "unknown";
}

// Determines why a position closed, for the events feed and for
// notifyPositionExpired — computed once here instead of re-derived by
// every future reader. "assigned" means the shares really changed hands:
// a covered call is assigned iff its stock leg left via a real fill (a
// closing trade, or an exit price that differs from its entry — a stock
// leg closed at exactly its entry price is a handoff to a successor
// position, see handOffOpenStockLegs, not a sale); a cash-secured put is
// assigned iff IBKR now holds shares of the symbol that no open stock leg
// accounts for — read from this pass's own held report, so it holds on the
// very pass that closes the put, before the leftover-stock position exists.
async function determineCloseReason(positionId: string): Promise<string> {
  const position = await fetchPositionById(positionId);
  if (!position) return "unknown";

  const stockLegs = position.legs.filter((leg: PositionLegRow) => leg.legType === "stock");
  if (position.strategyKey === "covered_call") {
    const stockClosingTrade =
      stockLegs.length > 0
        ? await db("trades")
            .whereIn(
              "position_leg_id",
              stockLegs.map((leg: PositionLegRow) => leg.id),
            )
            .where({ is_closing_trade: true })
            .first()
        : undefined;
    const stockExitedAtDifferentPrice = stockLegs.some(
      (leg: PositionLegRow) => leg.exitPrice !== null && Number(leg.exitPrice) !== Number(leg.entryPrice),
    );
    if (stockClosingTrade || stockExitedAtDifferentPrice) return "assigned";
  } else if (position.strategyKey === "cash_secured_put") {
    const ticker = await db("tickers").where({ symbol: position.symbol }).first();
    if (ticker) {
      const trackedOpenSharesRow = await db("position_legs as pl")
        .join("positions as p", "p.id", "pl.position_id")
        .where({ "p.ticker_id": ticker.id, "pl.leg_type": "stock", "pl.side": "long" })
        .whereNull("pl.exit_at")
        .sum({ total: "pl.quantity" })
        .first();
      const trackedOpenShares = Number(trackedOpenSharesRow?.total ?? 0);
      if ((heldStockSharesBySymbol.get(position.symbol) ?? 0) > trackedOpenShares) return "assigned";

      // Held report lagging behind the assignment: the shares showed up on an
      // earlier pass and already have a leg.
      const recentStockLeg = await db("position_legs as pl")
        .join("positions as p", "p.id", "pl.position_id")
        .where({ "p.ticker_id": ticker.id, "pl.leg_type": "stock" })
        .andWhere("pl.entry_at", ">=", db.raw("now() - interval '5 minutes'"))
        .first();
      if (recentStockLeg) return "assigned";
    }
  }

  const closingTrade = await db("trades as t")
    .join("position_legs as pl", "pl.id", "t.position_leg_id")
    .where({ "pl.position_id": positionId, "t.is_closing_trade": true })
    .first();
  if (closingTrade) {
    const orderRequest = await db("order_requests").where({ related_position_id: positionId, status: "filled" }).first();
    return orderRequest ? "closed_via_app" : "closed_via_external_trade";
  }

  const hasExpiredOptionLeg = position.legs.some(
    (leg: PositionLegRow) => leg.legType === "option" && leg.exitAt !== null,
  );
  if (hasExpiredOptionLeg) return "expired_worthless";

  return "unknown";
}

// The single place a position row flips to closed. close_reason is fixed
// here once; the expiry notification fires only when the caller knows an
// option leg of this position expired without a trade (never for a manual
// close through the app, which has its own confirmation UI and toast).
async function finalizeClosedPosition(
  positionId: string,
  options: { notifyExpired: boolean; closeReasonOverride?: string },
): Promise<string> {
  await db("positions").where({ id: positionId }).update({ status: "closed", closed_at: db.fn.now() });
  const closeReason = options.closeReasonOverride ?? (await determineCloseReason(positionId));
  await db("positions").where({ id: positionId }).update({ close_reason: closeReason });
  if (closeReason === "unknown" || closeReason === "closed_via_external_trade") {
    await logPlatformAnomaly(
      closeReason === "unknown" ? "unexplained_position_close" : "position_closed_outside_app",
      `Position ${positionId} closed with reason "${closeReason}"`,
      { positionId },
    );
  }
  if (options.notifyExpired) {
    await notifyPositionExpired(positionId, closeReason).catch((error) =>
      console.error(`Expiry notification failed for position ${positionId}: ${error}`),
    );
  }
  return closeReason;
}

interface OptionLegRetirementRow extends OptionLegRetirementEvidence {
  id: string;
}

async function loadOptionLegRetirementEvidence(positionId: string): Promise<OptionLegRetirementRow[]> {
  return db("position_legs as pl")
    .where({ "pl.position_id": positionId, "pl.leg_type": "option" })
    .select(
      "pl.id",
      "pl.exit_at as exitAt",
      db.raw('pl.expiry_date::text AS "expiryDate"'),
      db.raw('EXISTS (SELECT 1 FROM trades t WHERE t.position_leg_id = pl.id AND t.is_closing_trade) AS "hasClosingTrade"'),
    );
}

type StructureChangeVerdict = "confirmed" | "still_open" | "ambiguous" | "roll_in_progress";

// Whether a position whose held legs no longer fit its label has REALLY changed
// structure. A close + open cannot be undone, so it needs positive evidence
// (see optionLegRetirement.ts): a call that vanished before expiry with no
// closing trade is an IBKR held-report gap, and a call bought back moments ago
// is a roll whose new call has not been reported yet.
async function judgeStructureChange(optionLegs: OptionLegRetirementRow[]): Promise<StructureChangeVerdict> {
  const retirement = classifyOptionLegRetirement(optionLegs, easternIsoDate());
  if (retirement !== "settled") return retirement;
  const rollInProgress = optionLegs.some(
    (leg) => leg.hasClosingTrade && leg.exitAt !== null && Date.now() - new Date(leg.exitAt).getTime() < tradeRetirementSettleGraceMs,
  );
  return rollInProgress ? "roll_in_progress" : "confirmed";
}

// Transfers a position's open stock legs to a successor position: each leg is
// closed at its own entry price (the shares were never sold, so its realized
// P&L is genuinely zero — the same handoff convention the expiry-settlement
// audit and the cycle engine already read as "shares moved, not disposed"),
// and the caller re-creates the leg on the successor at that same price so
// the cost basis carries across unchanged. Returns the entry price per conId
// for exactly that.
async function handOffOpenStockLegs(positionId: string, symbol: string, toDescription: string): Promise<Map<string, number>> {
  const openStockLegs = await db("position_legs").where({ position_id: positionId, leg_type: "stock" }).whereNull("exit_at");
  const entryPriceByConId = new Map<string, number>();
  for (const leg of openStockLegs) {
    await db("position_legs").where({ id: leg.id }).update({ exit_at: db.fn.now(), exit_price: leg.entry_price });
    entryPriceByConId.set(String(leg.ibkr_contract_id), Number(leg.entry_price));
    legsHandedOffThisPass += 1;
    console.log(
      `Reconciliation #${currentPassId}: ${symbol} — handed off stock leg ${leg.id} (${leg.quantity} sh @ ${leg.entry_price}) from position ${positionId} ${toDescription}.`,
    );
  }
  return entryPriceByConId;
}

/**
 * Reconciles IBKR's actual current holdings into positions/position_legs —
 * the core of "the interface matches IBKR exactly." Pairing heuristic
 * (approved 2026-08-24, revised 2026-08-25, 2026-08-27, 2026-09-24): group by
 * underlying symbol. Each distinct short call contract (its own conId — a
 * different strike/expiry is a different contract) pairs with its own
 * proportional slice of the stock (quantity * 100) into its own covered_call
 * position — every position opened through this app is exactly 1 option +
 * 100 shares/contract, so multiple short calls on one symbol are always
 * separate bets, never one blended position (see PROGRESS.md, prompted by a
 * real MU position that had wrongly merged two different strikes under the
 * old symbol-only grouping).
 *
 * Short puts are handled unconditionally, independent of any covered-call
 * pairing on the same symbol — a covered call and a cash-secured put can
 * legitimately coexist on one underlying (e.g. a wheel), and a put must
 * never be silently stranded when its sibling stock/call legs get split off
 * into their own covered_call position by upsertSplitCoveredCallPosition
 * below. Real bug found 2026-08-27 on a real prod AAOI position: after a
 * covered call was rolled, the old shared position kept the still-open
 * short put but was left permanently mislabeled "unstructured" because the
 * put was never revisited once the call/stock pairing claimed the
 * isCoveredCall branch for that symbol.
 *
 * Anything left over that isn't a short put and doesn't cleanly pair as a
 * covered call (including any stock beyond what the sold calls need — see
 * upsertLeftoverStockPosition) is surfaced as strategy_key "unstructured"
 * rather than hidden.
 *
 * A position's strategy_key is fixed at creation (2026-09-24). When a
 * symbol's holdings stop fitting the position that owns them — a covered
 * call whose call expired now holds bare stock; bare leftover stock now has
 * a call sold against it — the position is closed and its shares are handed
 * to a new position with the right label (handOffOpenStockLegs), so every
 * step of a wheel is its own row with its own open/close, instead of one row
 * being relabelled in place and its history overwritten. The handoff fires
 * only on positive evidence that the change is real (judgeStructureChange).
 */
export async function reconcileHeldPositions(held: IbkrHeldPosition[], passId: number, deps: ReconciliationDependencies): Promise<void> {
  dependencies = deps;
  currentPassId = passId;
  legsHandedOffThisPass = 0;

  // Computed once up front so upsertSplitCoveredCallPosition can also use it
  // this same pass -- see its own comment for why.
  const heldConIds = new Set(held.map((p) => p.contract.conId).filter((id): id is number => id !== undefined));

  const bySymbol = new Map<string, IbkrHeldPosition[]>();
  for (const position of held) {
    const symbol = position.contract.symbol ?? "UNKNOWN";
    const existing = bySymbol.get(symbol) ?? [];
    existing.push(position);
    bySymbol.set(symbol, existing);
  }
  heldStockSharesBySymbol = new Map(
    [...bySymbol].map(([symbol, positionsForSymbol]) => [
      symbol,
      positionsForSymbol.filter((p) => p.contract.secType === SecType.STK && p.quantity > 0).reduce((sum, p) => sum + p.quantity, 0),
    ]),
  );

  // Legs IBKR no longer holds are closed BEFORE the structure pass, so that
  // pass sees each position's true remaining legs: a covered call whose short
  // call just expired is, by then, a position holding only stock — exactly
  // the shape that must hand its shares to a leftover-stock position.
  const closedLegCount = await closeLegsNoLongerHeld(heldConIds, passId);
  await syncHeldStructures(bySymbol, heldConIds, passId);
  await closeOrphanedOpenPositions(passId);

  // Legs closed this pass may include an option that finished in the money and was just recorded as
  // "worthless" (plus its stock leg at zero P&L). Correct it now instead of waiting for the nightly
  // audit. Runs on any closure, not just expired options, because the stock leg can close a pass later
  // than the option. Idempotent; the nightly job stays as the safety net.
  if (closedLegCount + legsHandedOffThisPass > 0) await correctExpirySettlementsNow(passId);
}

// Anything tracked as open in our DB but no longer reported by IBKR at
// all — the closing side of "a leg is only ever closed by reconciliation"
// (see recordExecution in the worker for why a single closing execution
// can't decide this on its own: a partial close previously flipped an
// entire multi-lot leg to closed and hid the still-open remainder).
// exit_price comes from the most recent closing trade already recorded for
// this leg by recordExecution, if any.
//
// An option leg past its own expiry with no closing trade is the
// "expired worthless" (or exercised/assigned, which also never generates
// a trade for the option side itself) case, not an unknown close — bug
// found 2026-08-27: this used to fall back to exit_price=null here too,
// which silently dropped the leg out of realizedPnl's SUM (it requires
// exit_price IS NOT NULL) and reported $0 P&L for every expired short
// option instead of the full premium collected. Only a genuinely
// ambiguous close (no trade, not past expiry — e.g. closed directly in
// TWS, or before this worker was deployed) still falls back to null.
async function closeLegsNoLongerHeld(heldConIds: Set<number>, passId: number): Promise<number> {
  const openLegs = await db("position_legs")
    .whereNull("exit_at")
    .whereNotNull("ibkr_contract_id")
    .select("*", db.raw("(leg_type = 'option' AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE) AS is_expired_option"));

  const legsNoLongerHeld = openLegs.filter((leg) => !heldConIds.has(Number(leg.ibkr_contract_id)));
  console.log(
    `Reconciliation #${passId}: ${openLegs.length} open leg(s) tracked in DB, ${legsNoLongerHeld.length} no longer reported by IBKR (will be closed this pass).`,
  );

  const positionIdsWithExpiredLeg = new Set<string>();
  let closedLegCount = 0;
  for (const leg of legsNoLongerHeld) {
    closedLegCount += 1;

    const lastClosingTrade = await db("trades")
      .where({ position_leg_id: leg.id, is_closing_trade: true })
      .orderBy("executed_at", "desc")
      .first();

    const expiredWithoutTrade = !lastClosingTrade && leg.is_expired_option;
    if (expiredWithoutTrade) positionIdsWithExpiredLeg.add(leg.position_id);

    // A covered call's stock leg is never actually sold just because its
    // short call expired worthless -- the shares are simply carried
    // forward (to a fresh covered call, or an unstructured leftover
    // position). IBKR's held-positions report has been observed to have a
    // gap right around that option's own expiry/settlement, which used to
    // make this stock leg fall into the same "no trade, ambiguous" branch
    // as a genuinely-unknown close and null out this covered call's whole
    // realized P&L (bug found 2026-09-08, iorio dashboard's Latest Events
    // widget). Recorded as "closed at its own entry price" instead --
    // correctly zero P&L for a leg that was never disposed of -- whenever
    // no real closing trade exists and a sibling option leg on the same
    // position has already expired.
    let isRetainedCoveredCallStock = false;
    if (leg.leg_type === "stock" && !lastClosingTrade) {
      const expiredSiblingOptionLeg = await db("position_legs")
        .where({ position_id: leg.position_id, leg_type: "option" })
        .whereNotNull("expiry_date")
        .andWhere("expiry_date", "<=", db.raw("CURRENT_DATE"))
        .first();
      isRetainedCoveredCallStock = expiredSiblingOptionLeg !== undefined;
    }

    await db("position_legs")
      .where({ id: leg.id })
      .update({
        exit_price: lastClosingTrade?.price ?? (expiredWithoutTrade ? 0 : isRetainedCoveredCallStock ? leg.entry_price : null),
        exit_at: lastClosingTrade?.executed_at ?? db.fn.now(),
      });
    console.log(
      `Reconciliation #${passId}: closed leg ${leg.id} (position ${leg.position_id}, conId ${leg.ibkr_contract_id}) — ${lastClosingTrade ? `matched closing trade @ ${lastClosingTrade.price}` : expiredWithoutTrade ? "expired worthless, no trade" : isRetainedCoveredCallStock ? "stock retained past sibling option's expiry, no trade -- closed at entry price" : "no trade, not past expiry (ambiguous close)"}.`,
    );

    const remainingOpenLegs = await db("position_legs").where({ position_id: leg.position_id }).whereNull("exit_at");
    if (remainingOpenLegs.length === 0) {
      await finalizeClosedPosition(leg.position_id, { notifyExpired: positionIdsWithExpiredLeg.has(leg.position_id) });
    }
  }
  return closedLegCount;
}

async function syncHeldStructures(bySymbol: Map<string, IbkrHeldPosition[]>, heldConIds: Set<number>, passId: number): Promise<void> {
  for (const [symbol, positionsForSymbol] of bySymbol) {
    const stockLeg = positionsForSymbol.find((p) => p.contract.secType === SecType.STK && p.quantity > 0);
    const shortCallLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Call && p.quantity < 0,
    );
    const shortPutLegs = positionsForSymbol.filter(
      (p) => p.contract.secType === SecType.OPT && p.contract.right === OptionType.Put && p.quantity < 0,
    );

    // One position per distinct short put contract (mirrors
    // upsertSplitCoveredCallPosition's covered-call fix below) -- sorted for
    // a stable, deterministic split across reconciliation runs.
    const sortedPutLegs = [...shortPutLegs].sort((a, b) => (a.contract.conId ?? 0) - (b.contract.conId ?? 0));
    for (const putLeg of sortedPutLegs) {
      await upsertSplitCashSecuredPutPosition(symbol, putLeg);
    }

    const totalShortCallShares = shortCallLegs.reduce((sum, leg) => sum + Math.abs(leg.quantity) * 100, 0);
    const isCoveredCall = stockLeg && shortCallLegs.length > 0 && totalShortCallShares <= stockLeg.quantity;

    console.log(
      `Reconciliation #${passId}: ${symbol} — stockQty=${stockLeg?.quantity ?? "none"}, shortCallLegs=${shortCallLegs.length} (totalShortCallShares=${totalShortCallShares}), shortPutLegs=${shortPutLegs.length}, isCoveredCall=${isCoveredCall}` +
        (isCoveredCall ? `, leftoverShares=${stockLeg!.quantity - totalShortCallShares}` : ""),
    );

    if (isCoveredCall) {
      // Sorted for a stable, deterministic split across reconciliation runs
      // (every 60s) -- otherwise which conId's stock slice goes where could
      // reshuffle from one pass to the next with no real change underneath.
      const sortedCallLegs = [...shortCallLegs].sort((a, b) => (a.contract.conId ?? 0) - (b.contract.conId ?? 0));
      for (const callLeg of sortedCallLegs) {
        await upsertSplitCoveredCallPosition(symbol, stockLeg, callLeg, Math.abs(callLeg.quantity) * 100, heldConIds);
      }
      // Should never happen -- every position this app opens is exactly 1
      // option + 100 shares/contract, so leftover stock beyond what the
      // sold calls need means something went wrong (a bug, or a manual
      // trade outside the app). Surfaced as its own flagged position
      // rather than silently absorbed into one of the covered calls above.
      await upsertLeftoverStockPosition(symbol, stockLeg, stockLeg.quantity - totalShortCallShares);
    } else {
      const nonPutLegs = positionsForSymbol.filter((p) => !shortPutLegs.includes(p));
      if (nonPutLegs.length > 0) {
        // Doesn't cleanly pair — surfaced, not hidden (approved 2026-08-24).
        // Stock-only leftover has two known causes (see
        // determineLeftoverStockReason); any short call present alongside it
        // is a naked/uncovered call, which nothing in this app should ever
        // produce — always an unknown-cause anomaly.
        const hasCallLeg = nonPutLegs.some((p) => p.contract.secType === SecType.OPT);
        const reason = hasCallLeg ? "unknown" : await determineLeftoverStockReason(symbol);
        const synced = await upsertUnstructuredPosition(
          symbol,
          nonPutLegs.map((leg) => ({ held: leg, side: leg.quantity > 0 ? ("long" as const) : ("short" as const) })),
          reason,
        );
        if (synced && reason === "unknown") {
          await logPlatformAnomaly(
            hasCallLeg ? "naked_call_detected" : "unexplained_leftover_stock",
            `${symbol}: reconciliation flagged unstructured with no known cause`,
          );
        }
      }
    }
  }
}

// Defensive self-heal, not tied to this pass's own leg-closing above:
// catches any status='open' position with zero open legs left,
// regardless of how it got that way. Normally the closing pass closes a
// leg and its now-empty position together in one step -- but a leg
// closed by any other means (a one-off manual SQL fix, a future bug)
// bypasses that and strands the position open forever with nothing left
// to show or close. Found 2026-09-11 firsthand: manually closing a
// stranded stock leg via SQL (working around a since-fixed roll-timing
// bug) left its position showing on the Positions screen with a blank
// Structure column and no Close button.
async function closeOrphanedOpenPositions(passId: number): Promise<void> {
  const openPositionsWithNoLegs = await db("positions as p")
    .where("p.status", "open")
    .whereNotExists(db("position_legs as pl").whereRaw("pl.position_id = p.id").whereNull("pl.exit_at"))
    .select("p.id");
  for (const { id: positionId } of openPositionsWithNoLegs) {
    await finalizeClosedPosition(positionId, { notifyExpired: false });
    console.log(`Reconciliation #${passId}: closed orphaned position ${positionId} (zero open legs, status was still 'open').`);
  }
}

// Fires only for a position that closed via the "option past expiry, no
// closing trade" path — a manual close through the app already has its
// own confirmation UI (and its own "Filled" order toast), so it doesn't
// need a Telegram ping or a second toast too. Sends both the Telegram
// message and the in-app toast notification (routes/notifications.ts's SSE
// stream) off the same message text, so they never drift apart.
async function notifyPositionExpired(positionId: string, closeReason: string): Promise<void> {
  const position = await fetchPositionById(positionId);
  if (!position) return;
  if (position.strategyKey !== "covered_call" && position.strategyKey !== "cash_secured_put") return;

  const realizedPnl = Number(position.realizedPnl);
  const capitalAtRisk = position.capitalAtRisk === null ? null : Number(position.capitalAtRisk);
  const realizedPnlPercent = capitalAtRisk && capitalAtRisk !== 0 ? (realizedPnl / capitalAtRisk) * 100 : null;
  const assigned = closeReason === "assigned";

  const message = formatPositionExpiredMessage({
    symbol: position.symbol,
    strategyKey: position.strategyKey as "covered_call" | "cash_secured_put",
    legs: position.legs.map((leg: PositionLegRow) => ({
      legType: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice === null ? null : Number(leg.strikePrice),
    })),
    realizedPnl,
    realizedPnlPercent,
    assigned,
  });
  await dependencies.notifyTelegram(message);
  await publishNotification({ type: "position_closed", positionId: position.id, symbol: position.symbol, message });
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

// Insert-or-update for a single position_legs row against one IBKR-held
// contract. Shared by upsertUnstructuredPosition (looks up an existing leg
// by conId alone, which stays safe there since that path never splits one
// conId across multiple positions) and upsertSplitCoveredCallPosition/
// upsertLeftoverStockPosition below (which pass scopeLookupToPosition=true,
// since a covered call's *stock* conId can be shared across several sibling
// positions and needs position_id in the lookup to disambiguate which slice
// belongs to which). entryPriceOverride is for a leg re-created after a
// handoff (see handOffOpenStockLegs): the shares' cost basis carries over
// from the closed predecessor leg instead of being read fresh from IBKR.
async function upsertPositionLeg(
  positionId: string,
  held: IbkrHeldPosition,
  side: "long" | "short",
  quantityOverride?: number,
  scopeLookupToPosition = false,
  entryPriceOverride?: number,
): Promise<void> {
  const conId = String(held.contract.conId);
  const contract = held.contract;
  // avgCost from IBKR's `position` event: for stock, cost per share; for
  // options, per @stoqey/ib's convention this already includes the
  // multiplier (total $ per contract, not per-share) — NEEDS VERIFICATION
  // against a real paper position before this is trusted (plan doc's
  // verification step 3). Flagging rather than asserting confidently.
  // `||`, not `??` — IBKR reports a stock contract's multiplier as "" (see
  // the comment a few lines below), and while that's been confirmed for
  // stock legs specifically, this codebase has hit the same "empty string,
  // not undefined" shape from IBKR for enough different fields (strike,
  // expiry, multiplier) that an option leg reporting "" here too can't be
  // ruled out — `?? 100` wouldn't catch it (`"" ?? 100` is `""`, not 100),
  // silently producing `avgCost / 0` = Infinity.
  const ibkrEntryPrice = contract.secType === SecType.STK ? held.avgCost : held.avgCost / (contract.multiplier || 100);
  const entryPrice = entryPriceOverride ?? ibkrEntryPrice;
  const trueQuantity = quantityOverride ?? Math.abs(held.quantity);

  const lookupQuery = db("position_legs").where({ ibkr_contract_id: conId }).whereNull("exit_at");
  if (scopeLookupToPosition) lookupQuery.where({ position_id: positionId });
  const existing = await lookupQuery.first();

  if (existing) {
    // Sync to IBKR's current truth on every pass, not just at creation.
    // Real bug found 2026-08-25 on a real MU position: two separate
    // 100-share opening orders for the same contract, 5 min apart, left
    // `quantity` stuck at 100 (whatever it was when this leg was first
    // created) even though `trades` correctly recorded both fills.
    // IBKR's `position` event always reports the CURRENT total holding +
    // blended average cost for this conId, never an increment, so it's
    // always safe to overwrite while the leg is still open.
    if (Number(existing.quantity) !== trueQuantity || Number(existing.entry_price) !== ibkrEntryPrice) {
      await db("position_legs").where({ id: existing.id }).update({ quantity: trueQuantity, entry_price: ibkrEntryPrice });
    }
    return;
  }

  const [newLeg] = await db("position_legs")
    .insert({
      position_id: positionId,
      leg_type: contract.secType === SecType.STK ? "stock" : "option",
      side,
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
  // leg existed — one trades row per real fill, not a single synthesized
  // one, so partial fills still show individually in the Trade Blotter.
  // Note: if two sibling covered-call positions both create their stock leg
  // from the same never-before-seen conId in the same pass, whichever runs
  // first drains the whole buffer — an extremely unlikely race (this app
  // only ever opens 1 option + 100 shares at a time; splitting only matters
  // for pre-existing multi-strike data), not fully solved here.
  await dependencies.drainPendingOpeningExecutions(conId, newLeg!.id);
}

// Held legs that don't pair into a covered call or a cash-secured put
// (bare leftover stock, or a naked call). Returns false when nothing was
// written because the legs still belong to a position whose structure
// change is not yet confirmed (see judgeStructureChange).
async function upsertUnstructuredPosition(
  symbol: string,
  legs: { held: IbkrHeldPosition; side: "long" | "short" }[],
  unstructuredReason: string,
): Promise<boolean> {
  const conIds = legs.map((leg) => String(leg.held.contract.conId));
  const existingLegs = await db("position_legs").whereIn("ibkr_contract_id", conIds).whereNull("exit_at");
  const existingPositionIds = [...new Set(existingLegs.map((leg) => leg.position_id as string))];
  const existingPositions = existingPositionIds.length > 0 ? await db("positions").whereIn("id", existingPositionIds) : [];

  let positionId = existingPositions.find((position) => position.strategy_key === "unstructured")?.id as string | undefined;

  // Held legs still owned by a position of ANOTHER strategy: that position's
  // structure changed underneath it (typically a covered call whose call is
  // gone, leaving bare stock). Its label is fixed, so the shares are handed to
  // a leftover-stock position — but only once the change is confirmed; an
  // IBKR held-report gap or a roll still filling leaves it untouched this pass.
  const foreignPositions = existingPositions.filter((position) => position.strategy_key !== "unstructured");
  const verdicts = new Map<string, { verdict: StructureChangeVerdict; optionLegs: OptionLegRetirementRow[] }>();
  for (const foreign of foreignPositions) {
    const optionLegs = await loadOptionLegRetirementEvidence(foreign.id);
    const verdict = await judgeStructureChange(optionLegs);
    if (verdict !== "confirmed") {
      console.log(
        `Reconciliation #${currentPassId}: ${symbol} — position ${foreign.id} (${foreign.strategy_key}) still owns held leg(s) but its structure change is ${verdict}; leaving it alone this pass.`,
      );
      return false;
    }
    verdicts.set(foreign.id, { verdict, optionLegs });
  }

  const handoffEntryPriceByConId = new Map<string, number>();
  for (const foreign of foreignPositions) {
    const { optionLegs } = verdicts.get(foreign.id)!;
    const handedOff = await handOffOpenStockLegs(foreign.id, symbol, "to a leftover-stock position");
    for (const [conId, entryPrice] of handedOff) handoffEntryPriceByConId.set(conId, entryPrice);
    const remainingOpenLegs = await db("position_legs").where({ position_id: foreign.id }).whereNull("exit_at");
    if (remainingOpenLegs.length === 0) {
      const expiredWithoutTrade = optionLegs.some((leg) => leg.exitAt !== null && !leg.hasClosingTrade);
      await finalizeClosedPosition(foreign.id, { notifyExpired: expiredWithoutTrade });
    }
  }

  if (!positionId) {
    const ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcileHeldPositions: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return false;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "open", unstructured_reason: unstructuredReason })
      .returning(["id"]);
    positionId = newPosition.id;
    await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
  } else {
    // The reason is fixed at creation like the label, with one exception:
    // "unknown" is the absence of an explanation, not an explanation, so a
    // later pass that can name the cause is allowed to fill it in.
    const existingPosition = existingPositions.find((position) => position.id === positionId)!;
    if (existingPosition.unstructured_reason === "unknown" && unstructuredReason !== "unknown") {
      await db("positions").where({ id: positionId }).update({ unstructured_reason: unstructuredReason });
    }
  }
  // Retried on every pass, not just at creation (found 2026-08-28): a real
  // race with the order's own fill-status callback — reconciliation can
  // detect and create the position from IBKR's held-positions report before
  // that order's order_requests row has actually flipped to "filled", so a
  // creation-time-only call sometimes found nothing to link and never got
  // a second chance. Safe to call repeatedly — the query only ever matches
  // an alert with resulting_position_id still NULL.
  await backfillAlertResultingPositionId(symbol, positionId!);

  for (const leg of legs) {
    const conId = String(leg.held.contract.conId);
    await upsertPositionLeg(positionId!, leg.held, leg.side, undefined, false, handoffEntryPriceByConId.get(conId));
  }
  return true;
}

// One covered-call position per distinct short call contract (added
// 2026-08-25 — see reconcileHeldPositions's header comment for why). Found
// via the call leg's own conId, which is always globally unique to exactly
// one position under this design — unlike the stock leg's conId, which can
// now be shared across several sibling positions and needs
// scopeLookupToPosition=true to disambiguate.
async function upsertSplitCoveredCallPosition(
  symbol: string,
  stockLeg: IbkrHeldPosition,
  callLeg: IbkrHeldPosition,
  sharesForThisLeg: number,
  heldConIds: Set<number>,
): Promise<void> {
  const callConId = String(callLeg.contract.conId);
  const existingCallLeg = await db("position_legs").where({ ibkr_contract_id: callConId }).whereNull("exit_at").first();
  console.log(
    `upsertSplitCoveredCallPosition(${symbol}): callConId=${callConId}, sharesForThisLeg=${sharesForThisLeg}, existingCallLeg=${existingCallLeg ? `${existingCallLeg.id} (position ${existingCallLeg.position_id})` : "none — will create a new position"}.`,
  );

  let positionId = existingCallLeg?.position_id as string | undefined;

  // One-time migration for pre-existing merged positions (the exact MU bug
  // this fix is for): if this call leg's position still has ANOTHER open
  // option leg on it (a different conId), the old symbol-only grouping
  // bundled two distinct covered calls together — split this leg out into
  // its own new position rather than reusing the shared one. Re-checked
  // fresh on every call so processing each sibling call leg in turn
  // (syncHeldStructures's sorted loop) correctly peels them apart one at
  // a time instead of only fixing the first.
  if (positionId) {
    const siblingOptionLegs = await db("position_legs")
      .where({ position_id: positionId, leg_type: "option" })
      .whereNot({ ibkr_contract_id: callConId })
      .whereNull("exit_at");
    if (siblingOptionLegs.length > 0) {
      const oldPosition = await db("positions").where({ id: positionId }).first();
      // opened_at explicitly set from this call leg's own entry_at, not left
      // to its CURRENT_TIMESTAMP default -- the old merged position's
      // opened_at reflects whichever leg it was originally created for
      // (possibly the sibling being left behind, not this one), and this
      // leg was genuinely opened whenever it was actually entered, not
      // "just now" (bug found 2026-09-09 alongside the same-shaped CSP
      // split below: the split-off position's Opened column showed "today").
      const [newPosition] = await db("positions")
        .insert({ strategy_key: "covered_call", ticker_id: oldPosition!.ticker_id, status: "open", opened_at: existingCallLeg!.entry_at })
        .returning(["id"]);
      await db("position_legs").where({ id: existingCallLeg!.id }).update({ position_id: newPosition.id });
      positionId = newPosition.id;
      await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
    }
  }

  if (!positionId) {
    const ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcileHeldPositions: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "covered_call", ticker_id: ticker.id, status: "open" })
      .returning(["id"]);
    positionId = newPosition.id;
    await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
  } else {
    // A call leg is only ever created on a covered_call position, so this can
    // only be pre-2026-09-24 data. Labels are immutable now: report, don't relabel.
    const owner = await db("positions").where({ id: positionId }).first("strategy_key");
    if (owner?.strategy_key !== "covered_call") {
      console.warn(`upsertSplitCoveredCallPosition(${symbol}): call leg ${existingCallLeg!.id} sits on position ${positionId} labelled ${owner?.strategy_key} — left as-is.`);
    }
  }
  // Retried on every pass, not just at creation — see upsertUnstructuredPosition's
  // matching comment for why (2026-08-28).
  await backfillAlertResultingPositionId(symbol, positionId!);

  await upsertPositionLeg(positionId!, callLeg, "short");

  // A newly sold call always lands here via the "no positionId found" branch
  // above, since a never-before-seen conId can't match existingCallLeg -- so
  // this position is brand new and has no stock leg of its own yet. The stock
  // itself never changed hands: it's the same real shares the OLD position
  // was holding -- the covered call being rolled away from, or a leftover-
  // stock position the shares were sitting in. Without this, upsertPositionLeg
  // below (scoped to THIS new position_id) can never find that old stock leg,
  // so it just inserts a second one -- and the old leg is never closed either,
  // since its conId is still held by IBKR (just now covered by a different
  // call), which is the only thing the closing pass checks. Net effect before
  // this fix: a silent, permanent double-count of every rolled covered call's
  // shares (found 2026-09-10 via reconciliation drift alerts on AMAT/SPCX).
  //
  // The old leg is handed off, not moved (2026-09-24): closed at its own entry
  // price and re-created here at that price, so the old position keeps a
  // complete leg history and its row can close as its own event. Run every
  // pass, not just while this position has no stock leg of its own -- a
  // lot-by-lot roll fill (IBKR fills the buy-back and the new sell as separate
  // partial executions instead of one atomic swap) can have this position
  // already own a stock leg (sized to whatever fraction of the new call was
  // filled a pass or two ago) by the time the OLD call's very last lot finally
  // clears and disappears from `held` entirely. At that point the old
  // position's stock leg is stale and orphaned exactly as below, and its
  // shares are already counted here, so it is only closed, at entry, not
  // re-created. Real bug found 2026-09-11 on a real prod HOOD roll that filled
  // in three separate 1-lot pairs over ~4 seconds.
  const stockConId = String(stockLeg.contract.conId);
  const ownStockLeg = await db("position_legs")
    .where({ ibkr_contract_id: stockConId, leg_type: "stock", position_id: positionId })
    .whereNull("exit_at")
    .first();
  const staleCandidates = await db("position_legs")
    .where({ ibkr_contract_id: stockConId, leg_type: "stock" })
    .whereNull("exit_at")
    .whereNot({ position_id: positionId });
  let handoffEntryPrice: number | undefined;
  for (const candidate of staleCandidates) {
    const siblingOptionLegs = await db("position_legs")
      .where({ position_id: candidate.position_id, leg_type: "option" })
      .whereNull("exit_at");
    // Only touch it if that position's own option leg(s) are no longer
    // held at all -- i.e. that position is mid-roll and about to be
    // closed by this same pass anyway. A still-held sibling option leg
    // means this is a genuine second concurrent covered call against the
    // same stock (a real split, not a roll), and its stock leg must be
    // left alone.
    const siblingStillLive = siblingOptionLegs.some((leg) => heldConIds.has(Number(leg.ibkr_contract_id)));
    if (siblingStillLive) continue;

    const sourcePosition = await db("positions").where({ id: candidate.position_id }).first();
    const handedOff = await handOffOpenStockLegs(candidate.position_id, symbol, `to covered call position ${positionId}`);
    if (!ownStockLeg && handoffEntryPrice === undefined) handoffEntryPrice = handedOff.get(stockConId);

    const remainingOpenLegs = await db("position_legs").where({ position_id: candidate.position_id }).whereNull("exit_at");
    if (remainingOpenLegs.length === 0) {
      await finalizeClosedPosition(candidate.position_id, {
        notifyExpired: false,
        closeReasonOverride: sourcePosition?.strategy_key === "unstructured" ? closeReasonStockRolledIntoCoveredCall : undefined,
      });
    }
  }

  await upsertPositionLeg(positionId!, stockLeg, "long", sharesForThisLeg, true, handoffEntryPrice);
}

// One cash-secured-put position per distinct short put contract — the same
// symbol-only-grouping bug upsertSplitCoveredCallPosition was fixed for
// above (2026-08-25) also applied to CSPs, just undiscovered until now:
// two unrelated CSPs on one ticker (different strikes/expiries, opened
// days apart) collapsed into a single position the moment IBKR reported
// both as held, blending their Structure column and losing the later
// expiry behind the earlier one. Found 2026-09-09 on a real prod MU
// position.
async function upsertSplitCashSecuredPutPosition(symbol: string, putLeg: IbkrHeldPosition): Promise<void> {
  const putConId = String(putLeg.contract.conId);
  const existingPutLeg = await db("position_legs").where({ ibkr_contract_id: putConId }).whereNull("exit_at").first();
  console.log(
    `upsertSplitCashSecuredPutPosition(${symbol}): putConId=${putConId}, existingPutLeg=${existingPutLeg ? `${existingPutLeg.id} (position ${existingPutLeg.position_id})` : "none — will create a new position"}.`,
  );

  let positionId = existingPutLeg?.position_id as string | undefined;

  // One-time migration for pre-existing merged positions (same pattern as
  // upsertSplitCoveredCallPosition): if this put leg's position still has
  // ANOTHER open option leg on it (a different conId), the old symbol-only
  // grouping bundled two distinct CSPs together — split this leg out into
  // its own new position rather than reusing the shared one. Re-checked
  // fresh on every call so processing each sibling put leg in turn
  // (syncHeldStructures's sorted loop) correctly peels them apart one at
  // a time instead of only fixing the first.
  if (positionId) {
    const siblingOptionLegs = await db("position_legs")
      .where({ position_id: positionId, leg_type: "option" })
      .whereNot({ ibkr_contract_id: putConId })
      .whereNull("exit_at");
    if (siblingOptionLegs.length > 0) {
      const oldPosition = await db("positions").where({ id: positionId }).first();
      // opened_at explicitly set from this put leg's own entry_at -- see
      // upsertSplitCoveredCallPosition's matching comment for why (found
      // 2026-09-09 on this exact function's first real split, the MU
      // position from the screenshot that started this fix).
      const [newPosition] = await db("positions")
        .insert({ strategy_key: "cash_secured_put", ticker_id: oldPosition!.ticker_id, status: "open", opened_at: existingPutLeg!.entry_at })
        .returning(["id"]);
      await db("position_legs").where({ id: existingPutLeg!.id }).update({ position_id: newPosition.id });
      positionId = newPosition.id;
      await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
    }
  }

  if (!positionId) {
    const ticker = await db("tickers").where({ symbol }).first();
    if (!ticker) {
      console.warn(`reconcileHeldPositions: no tickers row for ${symbol} — skipping sync until it's added via the Screener.`);
      return;
    }
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "cash_secured_put", ticker_id: ticker.id, status: "open" })
      .returning(["id"]);
    positionId = newPosition.id;
    await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
  } else {
    // A put leg is only ever created on a cash_secured_put position, so this can
    // only be pre-2026-09-24 data. Labels are immutable now: report, don't relabel.
    const owner = await db("positions").where({ id: positionId }).first("strategy_key");
    if (owner?.strategy_key !== "cash_secured_put") {
      console.warn(`upsertSplitCashSecuredPutPosition(${symbol}): put leg ${existingPutLeg!.id} sits on position ${positionId} labelled ${owner?.strategy_key} — left as-is.`);
    }
  }
  // Retried on every pass, not just at creation — see upsertUnstructuredPosition's
  // matching comment for why (2026-08-28).
  await backfillAlertResultingPositionId(symbol, positionId!);

  await upsertPositionLeg(positionId!, putLeg, "short");
}

// Stock beyond what the sold calls for this symbol actually need — should
// never happen (every position this app opens is exactly 1 option + 100
// shares/contract, in lockstep), so this is a data-integrity anomaly, not a
// normal state, and is deliberately kept as its own always-flagged
// "unstructured" position (renders with the existing "Needs Review" badge)
// rather than silently folded into one of the covered-call positions above.
// Matched structurally (this ticker's unstructured stock-only leg), not by
// ibkr_contract_id — the stock's conId is shared with every split
// covered-call position for this symbol too, so a bare conId lookup can't
// tell this one apart from those.
async function upsertLeftoverStockPosition(symbol: string, stockLeg: IbkrHeldPosition, leftoverShares: number): Promise<void> {
  const ticker = await db("tickers").where({ symbol }).first();
  if (!ticker) {
    console.log(`upsertLeftoverStockPosition(${symbol}): no tickers row — skipping.`);
    return;
  }

  const existingLeftoverLeg = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.ticker_id": ticker.id, "p.strategy_key": "unstructured", "pl.leg_type": "stock" })
    .whereNull("pl.exit_at")
    .select("pl.*")
    .first();

  console.log(
    `upsertLeftoverStockPosition(${symbol}): leftoverShares=${leftoverShares}, existingLeftoverLeg=${existingLeftoverLeg ? `${existingLeftoverLeg.id} (position ${existingLeftoverLeg.position_id})` : "none"}.`,
  );

  if (leftoverShares <= 0) {
    // Any shortfall has resolved (e.g. another call got sold against it) —
    // close out a previously-flagged leftover leg rather than leaving a
    // stale warning position visible.
    if (existingLeftoverLeg) {
      // Closed at its own entry price, not left null -- these shares
      // weren't sold, a new call simply now covers all of them, so this
      // leg's own realized P&L is genuinely zero, not unknown (bug found
      // 2026-09-08: this used to leave exit_price null, which fed into
      // realizedPnlFor's "ambiguous exit" guard and silently blanked the
      // whole position's P&L in the dashboard's Latest Events widget).
      await db("position_legs")
        .where({ id: existingLeftoverLeg.id })
        .update({ exit_at: db.fn.now(), exit_price: existingLeftoverLeg.entry_price });
      const remaining = await db("position_legs").where({ position_id: existingLeftoverLeg.position_id }).whereNull("exit_at");
      console.log(
        `upsertLeftoverStockPosition(${symbol}): leftoverShares<=0 — closed leg ${existingLeftoverLeg.id}. ${remaining.length} leg(s) still open on position ${existingLeftoverLeg.position_id}.`,
      );
      if (remaining.length === 0) {
        await finalizeClosedPosition(existingLeftoverLeg.position_id, { notifyExpired: false, closeReasonOverride: closeReasonStockRolledIntoCoveredCall });
        console.log(`upsertLeftoverStockPosition(${symbol}): closed position ${existingLeftoverLeg.position_id} (no legs remain open).`);
      }
    } else {
      console.log(`upsertLeftoverStockPosition(${symbol}): leftoverShares<=0 and nothing to close — no-op.`);
    }
    return;
  }

  let positionId = existingLeftoverLeg?.position_id as string | undefined;
  if (!positionId) {
    const [newPosition] = await db("positions")
      .insert({ strategy_key: "unstructured", ticker_id: ticker.id, status: "open", unstructured_reason: "unknown" })
      .returning(["id"]);
    positionId = newPosition.id;
    await publishNotification({ type: "position_opened", positionId: positionId!, symbol });
    console.log(`upsertLeftoverStockPosition(${symbol}): created new unstructured position ${positionId} for ${leftoverShares} leftover shares.`);
  }
  await upsertPositionLeg(positionId!, stockLeg, "long", leftoverShares, true);
}
