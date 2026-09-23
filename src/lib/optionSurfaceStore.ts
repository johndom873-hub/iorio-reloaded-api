import { db } from "../db/connection.js";
import { fitSurfaceForSnapshot, type FittedExpiry, type SurfaceFitOutcome } from "./optionSurfaceFitting.js";

// DB side of the nightly surface fit: reads each ticker's snapshot header and
// quotes for a trading date, fits every expiry (optionSurfaceFitting.ts) and
// replaces that snapshot's rows in option_surface_fits. Derived data only.

export interface SurfaceFitRunEvent {
  symbol: string;
  outcome: "fitted" | "skipped" | "error";
  detail: string;
}

export interface SurfaceFitRunResult {
  tradingDate: string;
  snapshotsConsidered: number;
  tickersFitted: number;
  tickersSkipped: number;
  tickersFailed: number;
  expiriesOk: number;
  expiriesFlagged: number;
}

interface SnapshotHeaderRow {
  snapshotId: string;
  symbol: string;
  spotPrice: string | null;
  riskFreeRatePercent: string | null;
  nextExDividendDate: string | null;
  nextExDividendAmount: string | null;
  pastExDividendDate: string | null;
  pastExDividendAmount: string | null;
}

const toNumberOrNull = (value: string | number | null | undefined): number | null => (value === null || value === undefined ? null : Number(value));

function buildInsertRows(snapshotId: string, expiries: FittedExpiry[]): Record<string, unknown>[] {
  return expiries.map(({ expiry, yearsToExpiry, forwardPrice, slice, dropped, calendarChecks, calendarViolations }) => ({
    snapshot_id: snapshotId,
    expiry,
    years_to_expiry: yearsToExpiry,
    forward_price: forwardPrice,
    status: slice.status,
    point_count: slice.pointCount,
    dropped_counts: JSON.stringify(dropped),
    rmse_volatility: slice.rmseVolatility,
    min_butterfly_density: slice.minimumButterflyDensity,
    k_min: slice.kMin,
    k_max: slice.kMax,
    param_a: slice.parameters?.a ?? null,
    param_b: slice.parameters?.b ?? null,
    param_rho: slice.parameters?.rho ?? null,
    param_m: slice.parameters?.m ?? null,
    param_sigma: slice.parameters?.sigma ?? null,
    calendar_checks: calendarChecks,
    calendar_violations: calendarViolations,
  }));
}

/** Replaces the snapshot's fits in one transaction, so a re-fit is never half-saved. */
export async function saveSurfaceFits(snapshotId: string, expiries: FittedExpiry[]): Promise<void> {
  await db.transaction(async (transaction) => {
    await transaction("option_surface_fits").where({ snapshot_id: snapshotId }).delete();
    const rows = buildInsertRows(snapshotId, expiries);
    if (rows.length > 0) await transaction("option_surface_fits").insert(rows);
  });
}

async function loadHeaders(tradingDate: string, symbols?: string[]): Promise<SnapshotHeaderRow[]> {
  const hasSymbolFilter = symbols !== undefined && symbols.length > 0;
  const { rows } = await db.raw(
    `
    SELECT
      h.id AS "snapshotId",
      t.symbol,
      h.underlying_price AS "spotPrice",
      h.risk_free_rate_percent AS "riskFreeRatePercent",
      h.next_ex_dividend_date::text AS "nextExDividendDate",
      h.next_ex_dividend_amount AS "nextExDividendAmount",
      p."pastExDividendDate",
      p."pastExDividendAmount"
    FROM option_chain_snapshots h
    JOIN tickers t ON t.id = h.ticker_id
    LEFT JOIN LATERAL (
      SELECT event_date::text AS "pastExDividendDate", amount AS "pastExDividendAmount"
      FROM ticker_calendar_events c
      WHERE c.ticker_id = h.ticker_id AND c.event_type = 'ex_dividend' AND c.event_date < ?::date
      ORDER BY c.event_date DESC
      LIMIT 1
    ) p ON true
    WHERE h.trading_date::text = ? AND h.status IN ('complete', 'partial') ${hasSymbolFilter ? "AND t.symbol = ANY(?)" : ""}
    ORDER BY t.symbol
    `,
    hasSymbolFilter ? [tradingDate, tradingDate, symbols] : [tradingDate, tradingDate],
  );
  return rows;
}

async function loadQuotes(snapshotId: string) {
  const rows: { expiry: string; strike: string; right: "C" | "P"; bid: string | null; ask: string | null }[] = await db("option_quote_snapshots")
    .where({ snapshot_id: snapshotId })
    .select(db.raw("expiry::text as expiry"), "strike", db.raw("option_right as \"right\""), "bid", "ask");
  return rows.map((row) => ({ expiry: row.expiry, strike: Number(row.strike), right: row.right, bid: toNumberOrNull(row.bid), ask: toNumberOrNull(row.ask) }));
}

function describeOutcome(outcome: SurfaceFitOutcome): string {
  if (outcome.kind === "skipped") return `skipped: ${outcome.reason}`;
  const ok = outcome.expiries.filter((expiry) => expiry.slice.status === "ok").length;
  return `${ok}/${outcome.expiries.length} expiries ok`;
}

/** Fits and stores the surface for every complete/partial snapshot of a trading date (optionally only some symbols). */
export async function fitAndStoreSurfacesForDate(tradingDate: string, onEvent: (event: SurfaceFitRunEvent) => void = () => {}, symbols?: string[]): Promise<SurfaceFitRunResult> {
  const headers = await loadHeaders(tradingDate, symbols);
  const result: SurfaceFitRunResult = { tradingDate, snapshotsConsidered: headers.length, tickersFitted: 0, tickersSkipped: 0, tickersFailed: 0, expiriesOk: 0, expiriesFlagged: 0 };
  for (const header of headers) {
    try {
      const outcome = fitSurfaceForSnapshot({
        tradingDate,
        spotPrice: toNumberOrNull(header.spotPrice),
        riskFreeRatePercent: toNumberOrNull(header.riskFreeRatePercent),
        nextExDividendDate: header.nextExDividendDate,
        nextExDividendAmount: toNumberOrNull(header.nextExDividendAmount),
        pastExDividendDate: header.pastExDividendDate,
        pastExDividendAmount: toNumberOrNull(header.pastExDividendAmount),
        quotes: await loadQuotes(header.snapshotId),
      });
      if (outcome.kind === "skipped") {
        result.tickersSkipped++;
        onEvent({ symbol: header.symbol, outcome: "skipped", detail: describeOutcome(outcome) });
        continue;
      }
      await saveSurfaceFits(header.snapshotId, outcome.expiries);
      result.tickersFitted++;
      for (const expiry of outcome.expiries) {
        if (expiry.slice.status === "ok" && expiry.calendarViolations === 0) result.expiriesOk++;
        else result.expiriesFlagged++;
      }
      onEvent({ symbol: header.symbol, outcome: "fitted", detail: describeOutcome(outcome) });
    } catch (error) {
      result.tickersFailed++;
      onEvent({ symbol: header.symbol, outcome: "error", detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
