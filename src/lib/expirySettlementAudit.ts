import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { requireEnvironmentVariable } from "../config/env.js";

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
//     When the assigned shares merged with shares already held (a covered call that
//     expired with its shares retained, then a put assigned) IBKR reports ONE leg at the
//     blended cost, so the target is the blended cost with the put priced at the strike
//     (see expectBlendedAssignmentEntries); approved 2026-10-01.
// A leg with settlement_audit_acknowledged_at set is left out entirely (reviewed by hand).

export type ExpirySettlementMode = "dry_run" | "apply";

export interface ExpirySettlementAction {
  kind: "call_away_stock_exit" | "put_assigned_stock_entry" | "close_reason" | "option_exit_price" | "skipped" | "marginal_call";
  symbol: string;
  description: string;
  /** The position whose expired short leg this action concerns — lets a caller (the worker's
   * right-after-expiry notification) correlate a "marginal_call" back to the specific closed
   * position it's about, without parsing the description text. */
  positionId: string;
  /** For a "skipped" or "marginal_call" item: which leg it is, and what needs a person. `description` is the two joined, for logs. */
  headline?: string;
  detail?: string;
  /** A "skipped" item that is a normal waiting state (an assigned stock chain that is still open), not something anyone must fix: it never fails the nightly run. */
  informational?: boolean;
  /** Realized P&L this correction adds, when it can be stated. */
  pnlDelta?: number;
}

export function readExpirySettlementMode(): ExpirySettlementMode {
  const value = requireEnvironmentVariable("EXPIRY_SETTLEMENT_MODE");
  if (value !== "dry_run" && value !== "apply") {
    throw new Error(`EXPIRY_SETTLEMENT_MODE must be "dry_run" or "apply", got: ${value}`);
  }
  return value;
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
  exitPrice: number | null;
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

function legHeadline(leg: ExpiredShortOptionLeg): string {
  return `${leg.symbol} ${leg.optionType} $${leg.strike} (exp ${leg.expiryDate})`;
}

function reviewAction(kind: "skipped" | "marginal_call", leg: ExpiredShortOptionLeg, detail: string, informational?: boolean): ExpirySettlementAction {
  const headline = legHeadline(leg);
  return { kind, symbol: leg.symbol, positionId: leg.positionId, headline, detail, description: `${headline} — ${detail}`, informational };
}

async function loadExpiredShortOptionLegs(database: Knex): Promise<ExpiredShortOptionLeg[]> {
  const result = await database.raw(`
    SELECT pl.id, pl.position_id AS "positionId", p.ticker_id AS "tickerId", t.symbol,
           pl.option_type AS "optionType", pl.strike_price::float AS strike, pl.quantity, pl.multiplier,
           pl.entry_price::float AS "entryPrice", pl.exit_at AS "exitAt", pl.exit_price::float AS "exitPrice", p.close_reason AS "closeReason",
           p.status AS "positionStatus", b.close_price::float AS "expiryClose", pl.expiry_date::text AS "expiryDate"
    FROM position_legs pl
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    LEFT JOIN daily_price_bars b ON b.ticker_id = t.id AND b.trading_date = pl.expiry_date
    WHERE pl.leg_type = 'option' AND pl.side = 'short'
      AND pl.expiry_date < (now() AT TIME ZONE 'America/New_York')::date
      AND pl.exit_at IS NOT NULL AND (pl.exit_price = 0 OR pl.exit_price IS NULL)
      AND pl.settlement_audit_acknowledged_at IS NULL
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
    positionId: leg.positionId,
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
    actions.push(reviewAction("skipped", leg, `ITM at expiry, covers ${calledAwayShares} sh but the position's uncorrected stock legs total ${candidateShares} sh — needs manual review`));
    return;
  }

  for (const stockLeg of candidates) {
    const pnlDelta = (leg.strike - stockLeg.entryPrice) * stockLeg.quantity - (stockLeg.exitPrice === null ? 0 : (stockLeg.exitPrice - stockLeg.entryPrice) * stockLeg.quantity);
    actions.push({
      kind: "call_away_stock_exit",
      symbol: leg.symbol,
      positionId: leg.positionId,
      description: `${leg.symbol} ${stockLeg.quantity} sh called away at $${leg.strike} (expiry close ${money(leg.expiryClose!)}): stock leg exit ${stockLeg.exitPrice === null ? "empty" : money(stockLeg.exitPrice)} -> ${money(leg.strike)}`,
      pnlDelta,
    });
    if (mode === "apply") await database("position_legs").where({ id: stockLeg.id }).update({ exit_price: leg.strike });
  }
  await setCloseReasonAssigned(database, leg, mode, actions);
}

export interface BlendedAssignmentInput {
  strike: number;
  /** Premium received per share on the assigned put. */
  premiumPerShare: number;
  assignedShares: number;
  /** Shares that were already held and merged with the assigned ones, and their average cost. */
  otherShares: number;
  otherSharesEntryPrice: number;
}

/**
 * What IBKR's blended average cost is (the put's premium baked into the assigned shares' cost, which the put leg also keeps
 * as premium, so it counts twice) and what it should be (the assigned shares priced at the strike). Rounded to the 4 decimals
 * entry_price stores.
 */
export function expectBlendedAssignmentEntries(input: BlendedAssignmentInput): { uncorrectedEntry: number; correctedEntry: number } {
  const totalShares = input.assignedShares + input.otherShares;
  const blend = (assignedSharePrice: number) => Number(((input.otherSharesEntryPrice * input.otherShares + assignedSharePrice * input.assignedShares) / totalShares).toFixed(4));
  return { uncorrectedEntry: blend(input.strike - input.premiumPerShare), correctedEntry: blend(input.strike) };
}

/**
 * The single stock leg (or its slices) holding assigned shares merged with shares carried over from a covered call that
 * expired with them retained. Positive evidence only: the legs entered together with the put's close, an earlier leg handed
 * its shares over at its own entry price right before, the share counts add up, and the entry price is exactly the blended cost
 * (still uncorrected) or exactly the corrected one (already fixed). Anything else is not claimed.
 */
async function findBlendedAssignmentLegs(
  database: Knex,
  leg: ExpiredShortOptionLeg,
  assignedShares: number,
): Promise<{ legs: StockLegRow[]; targetEntry: number; totalShares: number; otherShares: number; otherSharesEntryPrice: number } | null> {
  const candidates: StockLegRow[] = (
    await database.raw(
      `SELECT pl.id, pl.quantity, pl.entry_price::float AS "entryPrice", pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.entry_at AS "entryAt"
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       WHERE p.ticker_id = ? AND pl.leg_type = 'stock' AND pl.side = 'long'
         AND pl.entry_at BETWEEN ?::timestamptz - interval '${assignmentEntryWindowMinutes} minutes' AND ?::timestamptz + interval '${assignmentEntryWindowMinutes} minutes'`,
      [leg.tickerId, leg.exitAt, leg.exitAt],
    )
  ).rows;
  if (candidates.length === 0) return null;
  const totalShares = candidates.reduce((sum, candidate) => sum + candidate.quantity, 0);
  const earliestEntryAt = new Date(Math.min(...candidates.map((candidate) => new Date(candidate.entryAt).getTime())));

  const handedOverLegs: StockLegRow[] = (
    await database.raw(
      `SELECT pl.id, pl.quantity, pl.entry_price::float AS "entryPrice", pl.exit_price::float AS "exitPrice", pl.exit_at AS "exitAt", pl.entry_at AS "entryAt"
       FROM position_legs pl JOIN positions p ON p.id = pl.position_id
       WHERE p.ticker_id = ? AND pl.leg_type = 'stock' AND pl.side = 'long' AND pl.exit_at IS NOT NULL
         AND abs(pl.exit_price - pl.entry_price) < 0.0001
         AND abs(extract(epoch FROM pl.exit_at - ?::timestamptz)) <= ${transferWindowSeconds}`,
      [leg.tickerId, earliestEntryAt],
    )
  ).rows.filter((handedOver: StockLegRow) => !candidates.some((candidate) => candidate.id === handedOver.id));
  const otherShares = handedOverLegs.reduce((sum, handedOver) => sum + handedOver.quantity, 0);
  if (otherShares === 0 || totalShares - otherShares !== assignedShares) return null;

  const otherSharesEntryPrice = Number((handedOverLegs.reduce((sum, handedOver) => sum + handedOver.entryPrice * handedOver.quantity, 0) / otherShares).toFixed(4));
  const { uncorrectedEntry, correctedEntry } = expectBlendedAssignmentEntries({ strike: leg.strike, premiumPerShare: leg.entryPrice, assignedShares, otherShares, otherSharesEntryPrice });
  const candidateEntry = Number((candidates.reduce((sum, candidate) => sum + candidate.entryPrice * candidate.quantity, 0) / totalShares).toFixed(4));
  const matchesExpectation = (expected: number) => Math.abs(candidateEntry - expected) <= entryToleranceCents;
  if (!matchesExpectation(uncorrectedEntry) && !matchesExpectation(correctedEntry)) return null;
  return { legs: candidates, targetEntry: correctedEntry, totalShares, otherShares, otherSharesEntryPrice };
}

async function correctPutAssignment(database: Knex, leg: ExpiredShortOptionLeg, mode: ExpirySettlementMode, actions: ExpirySettlementAction[]): Promise<void> {
  await setCloseReasonAssigned(database, leg, mode, actions);

  const assignedShares = leg.quantity * leg.multiplier;
  const expectedPremiumAdjustedEntry = leg.strike - leg.entryPrice;
  let firstLegs: StockLegRow[] = (
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
  // The entry every assigned-share leg in the chain should end up at: the put's strike, or the blended cost when the assigned shares merged
  // with shares already held.
  let targetEntry = leg.strike;
  let expectedChainShares = assignedShares;
  let blendedWith: { otherShares: number; otherSharesEntryPrice: number } | null = null;
  if (firstLegs.length === 0) {
    const blended = await findBlendedAssignmentLegs(database, leg, assignedShares);
    if (blended) {
      firstLegs = blended.legs;
      targetEntry = blended.targetEntry;
      expectedChainShares = blended.totalShares;
      blendedWith = blended;
    }
  }
  if (firstLegs.length === 0) {
    actions.push(
      reviewAction(
        "skipped",
        leg,
        `ITM at expiry (${money(leg.expiryClose!)}) but no stock leg entered at strike − premium (${money(expectedPremiumAdjustedEntry)}) — assigned shares not tracked as a leg; manual review`,
      ),
    );
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

  const chainTotalIsAssignedShares = firstLegs.reduce((sum, stockLeg) => sum + stockLeg.quantity, 0) === expectedChainShares;
  const chainEndsOpen = chain.some((stockLeg) => stockLeg.exitAt === null);
  const chainSkip = classifyAssignedChainSkip(chainTotalIsAssignedShares, chainEndsOpen);
  if (chainSkip !== null) {
    actions.push(
      reviewAction(
        "skipped",
        leg,
        chainSkip === "informational"
          ? "assigned, stock chain is still open (worker re-syncs its entry to IBKR average cost) — cost basis handled in the cycle view, not edited"
          : `assigned, chain share total does not equal ${expectedChainShares}${chainEndsOpen ? " (and the chain is still open)" : ""} — manual review`,
        chainSkip === "informational",
      ),
    );
    return;
  }

  for (const stockLeg of chain) {
    if (Math.abs(stockLeg.entryPrice - targetEntry) < 0.0001) continue; // already corrected
    // A leg closed at exit == entry is a strategy handoff (or a retained/called-away leg not yet priced): keep
    // exit == entry so its zero P&L stays zero and the call-away step can still recognise it. A real exit keeps
    // its price, so the stock P&L drops by the premium that used to be baked into the cost.
    const exitEqualsEntry = stockLeg.exitPrice !== null && Math.abs(stockLeg.exitPrice - stockLeg.entryPrice) < 0.0001;
    const hasRealExit = stockLeg.exitPrice !== null && !exitEqualsEntry;
    actions.push({
      kind: "put_assigned_stock_entry",
      symbol: leg.symbol,
      positionId: leg.positionId,
      description: `${leg.symbol} assigned stock leg: entry ${money(stockLeg.entryPrice)} -> ${money(targetEntry)} (${blendedWith ? `put strike blended with the ${blendedWith.otherShares} sh already held at ${money(blendedWith.otherSharesEntryPrice)}` : "put strike"})${exitEqualsEntry ? ", exit moved with it (handoff)" : ""}`,
      pnlDelta: hasRealExit ? -(targetEntry - stockLeg.entryPrice) * stockLeg.quantity : 0,
    });
    if (mode === "apply") {
      const update: Record<string, number> = { entry_price: targetEntry };
      if (exitEqualsEntry) update.exit_price = targetEntry;
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
    // A short option that ended with no closing trade and no exit price is an expiry/assignment: the premium is
    // fully kept, i.e. exit_price 0. Legs closed by older worker versions (before 2026-08-27) left it NULL, which
    // drops the whole credit out of realized P&L (MU's two 8/26 calls: $1,448.28 missing).
    if (leg.exitPrice === null) {
      actions.push({
        kind: "option_exit_price",
        symbol: leg.symbol,
        positionId: leg.positionId,
        description: `${leg.symbol} short ${leg.optionType} $${leg.strike} (expiry ${leg.expiryDate}): exit price empty -> 0 (premium kept)`,
        pnlDelta: leg.entryPrice * leg.quantity * leg.multiplier,
      });
      await database("position_legs").where({ id: leg.id }).update({ exit_price: 0 });
    }
    if (leg.expiryClose === null) {
      // No bar for the expiry date (yet): retried on the next run, but flagged so a bar that never arrives is not silent.
      actions.push(reviewAction("skipped", leg, "no daily bar for the expiry date, so assignment could not be checked"));
      continue;
    }
    const distanceInTheMoney = leg.optionType === "call" ? leg.expiryClose - leg.strike : leg.strike - leg.expiryClose;
    if (distanceInTheMoney <= 0) continue; // OTM: worthless is right
    if (distanceInTheMoney < marginalThreshold) {
      actions.push(reviewAction("marginal_call", leg, `finished only ${money(distanceInTheMoney)} in the money (close ${money(leg.expiryClose)}) — too close to call, manual review`));
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

/**
 * Splits a result into corrections vs. skipped items and builds the Telegram text
 * (shared by the nightly job and the worker's right-after-expiry run). Skipped items
 * repeat until fixed by hand, so they never trigger a message on their own.
 */
export function summarizeExpirySettlement(mode: ExpirySettlementMode, result: ExpirySettlementResult) {
  const changes = result.actions.filter((action) => action.kind !== "skipped" && action.kind !== "marginal_call");
  const skipped = result.actions.filter((action) => action.kind === "skipped" || action.kind === "marginal_call");
  const pnlDelta = result.realizedPnlDelta;
  const notify =
    changes.length === 0
      ? undefined
      : `Expiry settlement audit (${mode === "apply" ? "APPLIED" : "DRY RUN — nothing changed"}): ${changes.length} correction(s), realized P&L ${pnlDelta >= 0 ? "+" : "-"}$${Math.abs(pnlDelta).toFixed(2)}.\n` +
        changes.map((action) => `• ${action.description}`).join("\n") +
        (skipped.length > 0 ? `\n${skipped.length} item(s) need manual review (see job log).` : "");
  return { changes, skipped, pnlDelta, notify };
}

/**
 * The nightly job alert for the skipped legs that need someone, or undefined when there are none (informational waiting
 * states are ignored): a summary line, then one block per leg (its identity, then what to do). Plain text — Telegram
 * escapes the whole message — and constant between runs while nothing changes, so the throttled alert does not re-send.
 * Free of "): " so it survives Telegram's failure summary.
 */
export function buildExpiryAuditFailureMessage(skipped: ExpirySettlementAction[]): string | undefined {
  const needsAttention = skipped.filter((action) => !action.informational);
  if (needsAttention.length === 0) return undefined;
  const blocks = needsAttention.map((action) => (action.headline && action.detail ? `${action.headline}\n${action.detail}` : action.description));
  return `${needsAttention.length} expired leg(s) need review or could not be audited\n\n${blocks.join("\n\n")}`.replaceAll("): ", ") - ");
}

/**
 * Why an assigned put's stock chain cannot be corrected automatically, or null when it can. A chain that matches the assigned
 * shares but is still open is a normal waiting state ("informational": it never fails the nightly run); a share-total mismatch,
 * open or not, needs someone.
 */
export function classifyAssignedChainSkip(chainTotalIsAssignedShares: boolean, chainEndsOpen: boolean): "informational" | "needs_review" | null {
  if (!chainTotalIsAssignedShares) return "needs_review";
  return chainEndsOpen ? "informational" : null;
}
