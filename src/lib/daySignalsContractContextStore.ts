import { db } from "../db/connection.js";
import { loadStoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { calendarDaysUntilExpiry, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry } from "./optionChainCaptureWindow.js";
import type { DayContractRef } from "./daySignalsContractSet.js";
import type { DaySignalExpiryRow } from "./daySignalsStore.js";
import { computeAtmImpliedVolatility, rebaseSlicesToToday } from "./signalsLiveScoring.js";
import { yyyymmddToIso } from "./signalsChain.js";
import { loadOpenShortLegs, loadSlices } from "./signalsStore.js";

/** Everything the Day Signals loop needs to work out one ticker's contract set from its live spot. */
export interface DayTickerContractContext {
  tickerId: string;
  symbol: string;
  snapshotId: string;
  /** Spot the 9:30 capture used; the reference for the first re-rank. */
  snapshotSpotPrice: number | null;
  /** Null when no fitted slice gives one; the loop then keeps that ticker on the captured contracts. */
  atmImpliedVolatility: number | null;
  /** ISO expiry -> the real strike grid, for stored expiries inside the capture's DTE range. */
  strikesByExpiry: Map<string, number[]>;
  heldContracts: DayContractRef[];
  /** The contracts with a stored day quote: what was quoted last cycle. */
  previousContracts: DayContractRef[];
}

/** One context per pooled ticker; DB only. Loaded each cycle: held legs and stored quotes change intraday. */
export async function loadDayTickerContractContexts(pool: DaySignalExpiryRow[], tradingDateIso: string): Promise<Map<string, DayTickerContractContext>> {
  const tickers = new Map<string, DaySignalExpiryRow>();
  for (const row of pool) if (!tickers.has(row.tickerId)) tickers.set(row.tickerId, row);
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
