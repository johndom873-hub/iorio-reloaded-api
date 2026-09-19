import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Approved 2026-09-19 (see PROGRESS.md, "Expiry-classification audit"): the
// worker calls a short option that vanishes without a closing trade
// "worthless", and closes a covered call's stock leg at exit_price =
// entry_price (zero P&L) or NULL. For an option that actually finished in the
// money that is wrong — the call was assigned (shares called away at the
// strike) or the put was assigned (shares acquired at the strike). Found via
// MU/HOOD/INTC calls and the AAOI put; the ~$6k MU stock gain was missing from
// realized P&L entirely.
//
// This runs nightly on Heroku (after the daily bar capture), not in the
// worker's reconcile loop: the reconcile loop cannot tell "called away" from
// IBKR's known transient held-positions gap at settlement, and daily bars give
// an objective in-the-money test. Judgement: ITM iff the expiry-date daily
// close is beyond the strike by at least marginalThreshold; anything closer is
// reported, never changed.
//
// Corrections (each idempotent — a corrected leg no longer matches its own
// selector):
//   call ITM -> the position's long stock legs that closed within a day of the
//     call, at NULL or exit_price = entry_price, get exit_price = strike (only
//     when their quantity equals the call's share count exactly); position
//     close_reason -> 'assigned'.
//   put ITM  -> close_reason -> 'assigned'; the assigned stock legs (entered
//     within minutes of the put's close at strike - premium, IBKR's
//     premium-adjusted average cost that double counts the put credit) and
//     their transfer successors get entry_price = strike, but ONLY when the
//     chain ends closed — the worker re-syncs an open leg's entry_price to
//     IBKR's average cost every pass, so an open chain is reported, not edited.

export type ExpirySettlementMode = "dry_run" | "apply";

export interface ExpirySettlementAction {
  kind: "call_away_stock_exit" | "put_assigned_stock_entry" | "close_reason" | "skipped";
  symbol: string;
  description: string;
  /** Realized P&L this correction adds, when it can be stated. */
  pnlDelta?: number;
}

export interface ExpirySettlementResult {
  mode: ExpirySettlementMode;
  legsExamined: number;
  actions: ExpirySettlementAction[];
  /** Measured change in total realized P&L (all position legs) caused by the corrections, applied in sequence. */
  realizedPnlDelta: number;
}

const marginalThreshold = 0.05;
const stockCloseWindow = "1 day";
const assignmentEntryWindowMinutes = 10;
const transferWindowSeconds = 120;
const entryToleranceCents = 0.02;
const correctableCloseReasons = [null, "expired_worthless", "closed", "closed_via_app", "unknown"];

interface ExpiredShortOptionLeg {
  id: string;
  positionId: string;
  tickerId: string;
  symbol: string;
  optionType: "call" | "put";
  strike: number;
  quantity: number;
  multiplier: number;
  entryPrice: number;
  exitAt: Date;
  closeReason: string | null;
  positionStatus: string;
  expiryClose: number | null;
  expiryDate: string;
}

interface StockLegRow {
  id: string;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  exitAt: Date | null;
  entryAt: Date;
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

async function loadExpiredShortOptionLegs(database: Knex): Promise<ExpiredShortOptionLeg[]> {
  const result = await database.raw(`
    SELECT pl.id, pl.position_id AS "positionId", p.ticker_id AS "tickerId", t.symbol,
           pl.option_type AS "optionType", pl.strike_price::float AS strike, pl.quantity, pl.multiplier,
           pl.entry_price::float AS "entryPrice", pl.exit_at AS "exitAt", p.close_reason AS "closeReason",
           p.status AS "positionStatus", b.close_price::float AS "expiryClose", pl.expiry_date::text AS "expiryDate"
    FROM position_legs pl
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    LEFT JOIN daily_price_bars b ON b.ticker_id = t.id AND b.trading_date = pl.expiry_date
    WHERE pl.leg_type = 'option' AND pl.side = 'short'
      AND pl.expiry_date < (now() AT TIME ZONE 'America/New_York')::date
      AND pl.exit_at IS NOT NULL AND (pl.exit_price = 0 OR pl.exit_price IS NULL)
      AND NOT EXISTS (SELECT 1 FROM trades tr WHERE tr.position_leg_id = pl.id AND tr.is_closing_trade)
    ORDER BY pl.expiry_date, t.symbol, pl.strike_price
  `);
  return result.rows;
}

async function setCloseReasonAssigned(database: Knex, leg: ExpiredShortOptionLeg, mode: ExpirySettlementMode, actions: ExpirySettlementAction[]): Promise<void> {
  if (leg.positionStatus !== "closed" || !correctableCloseReasons.includes(leg.closeReason)) return;
  actions.push({
    kind: "close_reason",
    symbol: leg.symbol,
    description: `${leg.symbol} ${leg.optionType} $${leg.strike} (expiry ${leg.expiryDate}): close_reason ${leg.closeReason ?? "empty"} -> assigned`,
  });
  if (mode === "apply") await database("positions").where({ id: leg.positionId }).update({ close_reason: "assigned" });
}

async function correctCallAway(database: Knex, leg: ExpiredShortOptionLeg, mode: ExpirySettlementMode, actions: ExpirySettlementAction[]): Promise<void> {
  const calledAwayShares = leg.quantity * leg.multiplier;
  const candidates: StockLegRow[] = (
    await database.raw(
      `SELECT id, quantity, entry_price::float AS "entryPrice", exit_price::float AS "exitPrice", exit_at AS "exitAt", entry_at AS "entryAt"
       FROM position_legs
       WHERE position_id = ? AND leg_type = 'stock' AND side = 'long' AND exit_at IS NOT NULL
         AND exit_at BETWEEN ?::timestamptz - interval '${stockCloseWindow}' AND ?::timestamptz + interval '${stockCloseWindow}'
         AND (exit_price IS NULL OR abs(exit_price - entry_price) < 0.0001)`,
      [leg.positionId, leg.exitAt, leg.exitAt],
    )
  ).rows;

  const candidateShares = candidates.reduce((sum, stockLeg) => sum + stockLeg.quantity, 0);
  if (candidates.length === 0) {
    // Either already corrected (exit_price == strike, which the selector excludes) or nothing to fix.
    await setCloseReasonAssigned(database, leg, mode, actions);
    return;
  }
  if (candidateShares !== calledAwayShares) {
    actions.push({
      kind: "skipped",
      symbol: leg.symbol,
      description: `${leg.symbol} call $${leg.strike} ITM at expiry covers ${calledAwayShares} sh but the position's uncorrected stock legs total ${candidateShares} sh — needs manual review`,
    });
    return;
  }

  for (const stockLeg of candidates) {
    const pnlDelta = (leg.strike - stockLeg.entryPrice) * stockLeg.quantity - (stockLeg.exitPrice === null ? 0 : (stockLeg.exitPrice - stockLeg.entryPrice) * stockLeg.quantity);
    actions.push({
      kind: "call_away_stock_exit",
      symbol: leg.symbol,
      description: `${leg.symbol} ${stockLeg.quantity} sh called away at $${leg.strike} (expiry close ${money(leg.expiryClose!)}): stock leg exit ${stockLeg.exitPrice === null ? "empty" : money(stockLeg.exitPrice)} -> ${money(leg.strike)}`,
      pnlDelta,
    });
    if (mode === "apply") await database("position_legs").where({ id: stockLeg.id }).update({ exit_price: leg.strike });
  }
  await setCloseReasonAssigned(database, leg, mode, actions);
}

async function correctPutAssignment(database: Knex, leg: ExpiredShortOptionLeg, mode: ExpirySettlementMode, actions: ExpirySettlementAction[]): Promise<void> {
  await setCloseReasonAssigned(database, leg, mode, actions);

  const assignedShares = leg.quantity * leg.multiplier;
  const expectedPremiumAdjustedEntry = leg.strike - leg.entryPrice;
  const firstLegs: StockLegRow[] = (
    await database.raw(
      `SELECT pl.id, pl.quantity, pl.entry_price::float AS "entryPrice", pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.entry_at AS "entryAt"
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       WHERE p.ticker_id = ? AND pl.leg_type = 'stock' AND pl.side = 'long'
         AND pl.entry_at BETWEEN ?::timestamptz - interval '${assignmentEntryWindowMinutes} minutes' AND ?::timestamptz + interval '${assignmentEntryWindowMinutes} minutes'
         AND (abs(pl.entry_price - ?) <= ? OR abs(pl.entry_price - ?) <= ?)`,
      // Premium-adjusted (uncorrected) OR already at the strike (corrected on an earlier run — stays silent).
      [leg.tickerId, leg.exitAt, leg.exitAt, expectedPremiumAdjustedEntry, entryToleranceCents, leg.strike, entryToleranceCents],
    )
  ).rows;
  if (firstLegs.length === 0) {
    actions.push({
      kind: "skipped",
      symbol: leg.symbol,
      description: `${leg.symbol} put $${leg.strike} ITM at expiry (${money(leg.expiryClose!)}) but no stock leg entered at strike − premium (${money(expectedPremiumAdjustedEntry)}) — assigned shares not tracked as a leg; manual review`,
    });
    return;
  }

  const chain: StockLegRow[] = [...firstLegs];
  for (let cursor = 0; cursor < chain.length; cursor += 1) {
    const current = chain[cursor]!;
    if (current.exitAt === null) continue;
    const successors: StockLegRow[] = (
      await database.raw(
        `SELECT pl.id, pl.quantity, pl.entry_price::float AS "entryPrice", pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.entry_at AS "entryAt"
         FROM position_legs pl JOIN positions p ON p.id = pl.position_id
         WHERE p.ticker_id = ? AND pl.leg_type = 'stock' AND pl.side = 'long' AND pl.id <> ?
           AND abs(extract(epoch FROM pl.entry_at - ?::timestamptz)) <= ${transferWindowSeconds}
           AND abs(pl.entry_price - ?) < 0.0001`,
        [leg.tickerId, current.id, current.exitAt, current.exitPrice ?? current.entryPrice],
      )
    ).rows.filter((candidate: StockLegRow) => !chain.some((existing) => existing.id === candidate.id));
    chain.push(...successors);
  }

  const chainTotalIsAssignedShares = firstLegs.reduce((sum, stockLeg) => sum + stockLeg.quantity, 0) === assignedShares;
  const chainEndsOpen = chain.some((stockLeg) => stockLeg.exitAt === null);
  if (!chainTotalIsAssignedShares || chainEndsOpen) {
    actions.push({
      kind: "skipped",
      symbol: leg.symbol,
      description: chainEndsOpen
        ? `${leg.symbol} put $${leg.strike} assigned: stock chain is still open (worker re-syncs its entry to IBKR average cost) — cost basis handled in the cycle view, not edited`
        : `${leg.symbol} put $${leg.strike} assigned: chain share total does not equal ${assignedShares} — manual review`,
    });
    return;
  }

  for (const stockLeg of chain) {
    if (Math.abs(stockLeg.entryPrice - leg.strike) < 0.0001) continue; // already corrected
    // A leg closed at exit == entry is a strategy handoff (or a retained/called-away leg not yet priced): keep
    // exit == entry so its zero P&L stays zero and the call-away step can still recognise it. A real exit keeps
    // its price, so the stock P&L drops by the premium that used to be baked into the cost.
    const exitEqualsEntry = stockLeg.exitPrice !== null && Math.abs(stockLeg.exitPrice - stockLeg.entryPrice) < 0.0001;
    const hasRealExit = stockLeg.exitPrice !== null && !exitEqualsEntry;
    actions.push({
      kind: "put_assigned_stock_entry",
      symbol: leg.symbol,
      description: `${leg.symbol} assigned stock leg: entry ${money(stockLeg.entryPrice)} -> ${money(leg.strike)} (put strike)${exitEqualsEntry ? ", exit moved with it (handoff)" : ""}`,
      pnlDelta: hasRealExit ? -(leg.strike - stockLeg.entryPrice) * stockLeg.quantity : 0,
    });
    if (mode === "apply") {
      const update: Record<string, number> = { entry_price: leg.strike };
      if (exitEqualsEntry) update.exit_price = leg.strike;
      await database("position_legs").where({ id: stockLeg.id }).update(update);
    }
  }
}

async function realizedPnlTotal(database: Knex): Promise<number> {
  const result = await database.raw(`
    SELECT COALESCE(SUM((exit_price - entry_price) * quantity * multiplier * (CASE WHEN side = 'short' THEN -1 ELSE 1 END)), 0)::float AS total
    FROM position_legs WHERE exit_price IS NOT NULL
  `);
  return Number(result.rows[0].total);
}

async function findAndCorrect(database: Knex): Promise<Omit<ExpirySettlementResult, "mode">> {
  const legs = await loadExpiredShortOptionLegs(database);
  const actions: ExpirySettlementAction[] = [];
  const before = await realizedPnlTotal(database);

  for (const leg of legs) {
    if (leg.expiryClose === null) continue; // no bar for the expiry date (yet) — retried on the next run
    const distanceInTheMoney = leg.optionType === "call" ? leg.expiryClose - leg.strike : leg.strike - leg.expiryClose;
    if (distanceInTheMoney <= 0) continue; // OTM: worthless is right
    if (distanceInTheMoney < marginalThreshold) {
      actions.push({
        kind: "skipped",
        symbol: leg.symbol,
        description: `${leg.symbol} ${leg.optionType} $${leg.strike} finished only ${money(distanceInTheMoney)} in the money (close ${money(leg.expiryClose)}) — too close to call, manual review`,
      });
      continue;
    }
    if (leg.optionType === "call") await correctCallAway(database, leg, "apply", actions);
    else await correctPutAssignment(database, leg, "apply", actions);
  }
  return { legsExamined: legs.length, actions, realizedPnlDelta: (await realizedPnlTotal(database)) - before };
}

class DryRunRollback extends Error {
  constructor(readonly outcome: Omit<ExpirySettlementResult, "mode">) {
    super("dry run rollback");
  }
}

/**
 * dry_run executes the exact same corrections inside a transaction and rolls it
 * back, so what it reports (actions AND the measured realized-P&L change, which
 * depends on the corrections applying in sequence) is identical to what apply
 * would do. apply commits the same transaction.
 */
export async function runExpirySettlementAudit(mode: ExpirySettlementMode, database: Knex = db): Promise<ExpirySettlementResult> {
  if (mode === "apply") {
    const outcome = await database.transaction((transaction) => findAndCorrect(transaction));
    return { mode, ...outcome };
  }
  try {
    await database.transaction(async (transaction) => {
      throw new DryRunRollback(await findAndCorrect(transaction));
    });
  } catch (error) {
    if (error instanceof DryRunRollback) return { mode, ...error.outcome };
    throw error;
  }
  throw new Error("unreachable");
}
