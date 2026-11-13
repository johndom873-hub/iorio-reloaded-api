import { fullDailyHistoryStartDate } from "../ibkr/historicalDataDuration.js";

// Tickers whose business changed (Marcelo 2026-11-04): from the change the ticker is a new company, and no analysis reads
// anything of it from before: prices, implied volatility, option days. BacktestSymbolFile and loadDailyBarsOf leave the
// earlier days out, so the lab, the analysis and the portfolio simulator start the ticker there, as at a listing. The data
// files keep everything as IBKR and ThetaData give it (the refresh compares the file's bars with IBKR's).
// Since 2026-11-13 the app reads the same dates (Price Performance's Drawdown, the ticker chart), and every ticker's history
// starts in 2006 at the earliest (historyStartDateOf): IBKR's bars leave splits before about 2006 unadjusted.

export interface TickerBusinessChange {
  symbol: string;
  /** The first session of the current business. */
  currentBusinessFrom: string;
  /** What the ticker's prices were before, as shown beside its history. */
  before: string;
}

export const tickerBusinessChanges: readonly TickerBusinessChange[] = [
  { symbol: "ASTS", currentBusinessFrom: "2021-04-07", before: "New Providence Acquisition, a SPAC" },
  { symbol: "BMNR", currentBusinessFrom: "2025-06-30", before: "a small bitcoin miner, before it held Ether" },
  { symbol: "COHR", currentBusinessFrom: "2022-07-01", before: "II-VI, before it bought Coherent and took its name" },
  { symbol: "GRAB", currentBusinessFrom: "2021-12-02", before: "Altimeter Growth, a SPAC" },
  { symbol: "HIMS", currentBusinessFrom: "2021-01-21", before: "Oaktree Acquisition, a SPAC" },
  { symbol: "IBRX", currentBusinessFrom: "2021-03-10", before: "NantKwest, before its merger with ImmunityBio" },
  { symbol: "IONQ", currentBusinessFrom: "2021-10-01", before: "dMY Technology III, a SPAC" },
  { symbol: "MSTR", currentBusinessFrom: "2020-08-11", before: "a software company, before it held bitcoin" },
  { symbol: "NBIS", currentBusinessFrom: "2024-10-21", before: "Yandex" },
  { symbol: "RKLB", currentBusinessFrom: "2021-08-25", before: "Vector Acquisition, a SPAC" },
  { symbol: "SHAZ", currentBusinessFrom: "2026-02-18", before: "Roth CH Holding, a shell with no trades" },
  { symbol: "SOFI", currentBusinessFrom: "2021-06-01", before: "Social Capital Hedosophia V (IPOE), a SPAC" },
];

const changeBySymbol = new Map(tickerBusinessChanges.map((change) => [change.symbol, change]));

/** The ticker's business change; null when it has none. */
export function tickerBusinessChangeOf(symbol: string): TickerBusinessChange | null {
  return changeBySymbol.get(symbol) ?? null;
}

/** The first date any analysis reads of the ticker: its current business's first session; null when it has no change. */
export function currentBusinessFromOf(symbol: string): string | null {
  return changeBySymbol.get(symbol)?.currentBusinessFrom ?? null;
}

/**
 * The first date anything reads of the ticker's daily history: its current business's first session, and never before
 * 2006 (fullDailyHistoryStartDate: INTC's 2:1 split of 2000-07-31 still reads as a 48% fall in IBKR's bars).
 */
export function historyStartDateOf(symbol: string): string {
  const currentBusinessFrom = currentBusinessFromOf(symbol);
  return currentBusinessFrom !== null && currentBusinessFrom > fullDailyHistoryStartDate ? currentBusinessFrom : fullDailyHistoryStartDate;
}

/** The rows on or after `fromIso` (all of them when it is null). */
export function rowsFrom<Row extends { tradingDate: string }>(rows: readonly Row[], fromIso: string | null): Row[] {
  return fromIso === null ? [...rows] : rows.filter((row) => row.tradingDate >= fromIso);
}

/** The option data's first weeks: options starting then were listed before it began. */
const optionDataStartDate = "2020-01-31";
const possibleBusinessChangeGapDays = 60;

/**
 * When a newly downloaded ticker may have been another company before (a SPAC, a merger, a relisting): its options start
 * more than 60 days after its stock prices, after the option data's own start. A person decides and adds it to
 * tickerBusinessChanges; null when the dates show nothing or it is already there.
 */
export function possibleBusinessChangeNotice(symbol: string, firstDailyBarDate: string, firstOptionDay: string): string | null {
  if (changeBySymbol.has(symbol) || firstOptionDay <= optionDataStartDate) return null;
  const gapDays = Math.round((Date.parse(`${firstOptionDay}T00:00:00Z`) - Date.parse(`${firstDailyBarDate}T00:00:00Z`)) / 86_400_000);
  if (gapDays <= possibleBusinessChangeGapDays) return null;
  return `${symbol}: its options start ${firstOptionDay}, ${gapDays} days after its stock prices (${firstDailyBarDate}). Was it another company before (a SPAC, a merger, a relisting)? If so, add it to tickerBusinessChanges (src/lib/tickerBusinessChanges.ts) so no analysis reads the earlier prices.`;
}
