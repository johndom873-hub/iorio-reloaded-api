import { db } from "../db/connection.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { calendarDaysUntilExpiry, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry } from "./optionChainCaptureWindow.js";
import type { DayContractRef } from "./daySignalsContractSet.js";
import { computeAtmImpliedVolatility, rebaseSlicesToToday } from "./signalsLiveScoring.js";
import { yyyymmddToIso } from "./signalsChain.js";
import { loadOpenShortLegs, loadSignalsUniverseTickers, loadSlices } from "./signalsStore.js";

/** Everything the Day Signals loop needs to work out one ticker's contract set from its live spot. */
export interface DayTickerContractContext {
  tickerId: string;
  symbol: string;
  snapshotId: string;
  /** Spot the 10:00 capture used; the reference for the first re-rank. */
  snapshotSpotPrice: number | null;
  /** Null when no fitted slice gives one; the loop then keeps that ticker on the captured contracts. */
  atmImpliedVolatility: number | null;
  /** ISO expiry -> the real strike grid, for stored expiries inside the capture's DTE range. */
  strikesByExpiry: Map<string, number[]>;
  heldContracts: DayContractRef[];
  /** The contracts with a stored day quote: what was quoted last cycle. */
  previousContracts: DayContractRef[];
}

/** A ticker the loop tracks the spot of: pooled, or scored at 10:00 but left without a pool. */
export interface DayTrackedTicker {
  tickerId: string;
  symbol: string;
  /** The snapshot the ticker's pool is (or would be) seeded from. */
  snapshotId: string;
}

/** Signals-universe tickers with today's snapshot but no pooled expiry: the 10:00 seed found no positive-Edge candidate at the open's prices, which a later move can change. */
export async function loadDayUnpooledTickers(tradingDateIso: string): Promise<DayTrackedTicker[]> {
  const universe = await loadSignalsUniverseTickers();
  if (universe.length === 0) return [];
  const symbolById = new Map(universe.map((ticker) => [ticker.tickerId, ticker.symbol]));
  const rows: { tickerId: string; snapshotId: string }[] = await db("option_chain_snapshots as s")
    .whereIn("s.ticker_id", [...symbolById.keys()])
    .whereRaw("s.trading_date::text = ?", [tradingDateIso])
    .whereIn("s.status", ["complete", "partial"])
    .whereNotExists(db("day_signal_expiries as e").whereRaw("e.ticker_id = s.ticker_id").whereRaw("e.trading_date::text = ?", [tradingDateIso]).select(db.raw("1")))
    .select("s.ticker_id as tickerId", "s.id as snapshotId");
  return rows.map((row) => ({ tickerId: row.tickerId, symbol: symbolById.get(row.tickerId)!, snapshotId: row.snapshotId }));
}

/** One context per tracked ticker; DB only. Loaded each cycle: held legs and stored quotes change intraday. */
export async function loadDayTickerContractContexts(trackedTickers: DayTrackedTicker[], tradingDateIso: string): Promise<Map<string, DayTickerContractContext>> {
  const tickers = new Map<string, DayTrackedTicker>();
  for (const row of trackedTickers) if (!tickers.has(row.tickerId)) tickers.set(row.tickerId, row);
  const contexts = await Promise.all(
    [...tickers.values()].map(async (row): Promise<DayTickerContractContext> => {
      const [chain, snapshot, slices, legs, previousRows] = await Promise.all([
        loadStoredOptionChain(row.tickerId),
        db("option_chain_snapshots").where({ id: row.snapshotId }).first("underlying_price"),
        loadSlices(row.snapshotId),
        loadOpenShortLegs(row.tickerId),
        db("day_signal_quotes").where({ ticker_id: row.tickerId }).whereRaw("trading_date::text = ?", [tradingDateIso]).select(db.raw("expiry::text as expiry"), "strike", db.raw('option_right as "right"')),
      ]);
      const strikesByExpiry = new Map<string, number[]>();
      for (const [expiry, strikes] of chain.strikesByExpiry) {
        const dte = calendarDaysUntilExpiry(tradingDateIso, expiry);
        if (dte >= captureMinimumDaysToExpiry && dte <= captureMaximumDaysToExpiry) strikesByExpiry.set(yyyymmddToIso(expiry), strikes);
      }
      return {
        tickerId: row.tickerId,
        symbol: row.symbol,
        snapshotId: row.snapshotId,
        snapshotSpotPrice: snapshot?.underlying_price === null || snapshot?.underlying_price === undefined ? null : Number(snapshot.underlying_price),
        atmImpliedVolatility: computeAtmImpliedVolatility(rebaseSlicesToToday(slices, tradingDateIso)),
        strikesByExpiry,
        heldContracts: legs.map((leg) => ({ expiry: leg.expiry, strike: leg.strike, right: leg.right })),
        previousContracts: previousRows.map((quote: { expiry: string; strike: string; right: "C" | "P" }) => ({ expiry: quote.expiry, strike: Number(quote.strike), right: quote.right })),
      };
    }),
  );
  return new Map(contexts.map((context) => [context.tickerId, context]));
}
