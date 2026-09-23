import { db } from "../db/connection.js";

// IBKR caps market-data lines at 100 per TWS username, shared across every
// connection on that login (verified against IBKR's docs 2026-09-21) — not
// per connection, which fetchOptionChain.ts's live chain and the nightly
// capture job (captureOptionQuoteBatch.ts) each used to assume independently.
// Budgeted at 90, not 100, to leave headroom for TWS itself and the
// small one-shot lookups (single pricing snapshots, the health check's SPY
// probe) that aren't worth coordinating here — see PROGRESS.md.
export const totalMarketDataLineBudget = 90;

export interface LineReservationResult {
  ok: boolean;
  /** Lines free against the budget at the moment of a failed reservation — for a clearer error message, not a promise they'll still be free on retry. */
  availableLines: number;
}

/**
 * Reserves `lines` market-data lines under `holder` for `ttlSeconds`, failing
 * if the account-wide total (across every process sharing this DB, i.e. the
 * web dyno and any Heroku Scheduler one-off job) would exceed the budget.
 * Re-reserving the same holder replaces its previous reservation (size and
 * expiry) rather than adding to it.
 */
export async function reserveMarketDataLines(holder: string, lines: number, ttlSeconds: number): Promise<LineReservationResult> {
  return db.transaction(async (trx) => {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    // Postgres doesn't allow FOR UPDATE on an aggregate, so an advisory
    // transaction lock serializes concurrent reserve() calls instead — held
    // only until this transaction commits/rolls back, so a rejected
    // reservation never blocks the next caller.
    await trx.raw("SELECT pg_advisory_xact_lock(hashtext('ibkr_market_data_line_reservations'))");
    const { rows } = await trx.raw(
      `SELECT COALESCE(SUM(lines), 0)::int AS in_use FROM ibkr_market_data_line_reservations WHERE expires_at > now() AND holder != ?`,
      [holder],
    );
    const inUse: number = rows[0].in_use;
    const availableLines = totalMarketDataLineBudget - inUse;
    if (lines > availableLines) return { ok: false, availableLines };

    await trx("ibkr_market_data_line_reservations")
      .insert({ holder, lines, expires_at: expiresAt })
      .onConflict("holder")
      .merge();
    return { ok: true, availableLines };
  });
}

/** Extends an existing reservation's expiry — for a long-lived holder (the Ticker Detail modal's live chain) kept alive by a heartbeat. No-op if the reservation already expired; the next reserve() call will re-establish it. */
export async function renewMarketDataLineReservation(holder: string, ttlSeconds: number): Promise<void> {
  await db("ibkr_market_data_line_reservations")
    .where({ holder })
    .update({ expires_at: new Date(Date.now() + ttlSeconds * 1000) });
}

export async function releaseMarketDataLines(holder: string): Promise<void> {
  await db("ibkr_market_data_line_reservations").where({ holder }).del();
}
