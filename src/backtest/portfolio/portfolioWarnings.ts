import { lotDollarsAt } from "../analysis/analysisSuitabilityRule.js";

// The portfolio simulator's warnings (W1–W6, approved by Marcelo 2026-11-03): mistakes the data shows before Pluto trades a
// book.
// - W1 the ticker's latest analysis says Vol Farmer v4 doesn't suit it.
// - W2 one lot (100 shares at today's price + $0.50 commission) is over 80% of its pot (allocation × (1 + allowance) ×
//   account). Example: NVDA at $190 in a $22,857 pot: $19,000.50 is 83% of it.
// - W3 one group (worst weeks together) holds over 30% of the book.
// - W4 under 5 years of its own daily bars: the weeks before are modelled from SPY.
// - W5 its analysis backtest saw no fall of SPY of 20% from a peak inside it: its down capture was never measured in a bear
//   market.
// - W6 the allocations don't add up to 100%.

export const lotShareOfPotLimit = 0.8;
export const groupShareLimit = 0.3;
export const ownHistoryYearsMinimum = 5;
export const spyFallSeenMinimum = -0.2;

export type PortfolioWarningCode = "doesnt_suit" | "lot_too_large" | "group_too_large" | "short_history" | "no_bear_market_in_backtest" | "allocations_not_100";

export interface PortfolioWarning {
  code: PortfolioWarningCode;
  symbols: string[];
  text: string;
}

export interface WarningTickerInput {
  symbol: string;
  verdict: string | null;
  potDollars: number;
  priceAsTraded: number | null;
  ownHistoryYears: number;
  backtestWorstSpyFall: number | null;
}

const percentText = (fraction: number, digits = 0) => `${(fraction * 100).toFixed(digits)}%`;
const dollarsText = (dollars: number) => `$${Math.round(dollars).toLocaleString("en-US")}`;
const listText = (symbols: readonly string[]) => (symbols.length <= 1 ? symbols.join("") : `${symbols.slice(0, -1).join(", ")} and ${symbols.at(-1)}`);

export function portfolioWarningsOf(input: { tickers: readonly WarningTickerInput[]; groups: readonly { symbols: string[]; share: number }[]; allocationTotalPct: number }): PortfolioWarning[] {
  const warnings: PortfolioWarning[] = [];
  const doesntSuit = input.tickers.filter((ticker) => ticker.verdict === "doesnt_suit").map((ticker) => ticker.symbol);
  if (doesntSuit.length > 0) warnings.push({ code: "doesnt_suit", symbols: doesntSuit, text: `${listText(doesntSuit)}: Vol Farmer v4 doesn't suit ${doesntSuit.length === 1 ? "it" : "them"} (its analysis)` });
  for (const ticker of input.tickers) {
    if (ticker.priceAsTraded === null || ticker.potDollars <= 0) continue;
    const lot = lotDollarsAt(ticker.priceAsTraded);
    if (lot > lotShareOfPotLimit * ticker.potDollars) warnings.push({ code: "lot_too_large", symbols: [ticker.symbol], text: `${ticker.symbol}: one lot (${dollarsText(lot)}) is ${percentText(lot / ticker.potDollars)} of its ${dollarsText(ticker.potDollars)} pot, over 80%` });
  }
  for (const group of input.groups) {
    if (group.symbols.length > 1 && group.share > groupShareLimit) warnings.push({ code: "group_too_large", symbols: group.symbols, text: `${listText(group.symbols)} fall together and hold ${percentText(group.share)} of the book, over 30%` });
  }
  const shortHistory = input.tickers.filter((ticker) => ticker.ownHistoryYears < ownHistoryYearsMinimum).map((ticker) => ticker.symbol);
  if (shortHistory.length > 0) warnings.push({ code: "short_history", symbols: shortHistory, text: `${listText(shortHistory)}: under 5 years of ${shortHistory.length === 1 ? "its" : "their"} own history; earlier weeks modelled from SPY` });
  const noBearMarket = input.tickers.filter((ticker) => ticker.backtestWorstSpyFall !== null && ticker.backtestWorstSpyFall > spyFallSeenMinimum).map((ticker) => ticker.symbol);
  if (noBearMarket.length > 0) warnings.push({ code: "no_bear_market_in_backtest", symbols: noBearMarket, text: `${listText(noBearMarket)}: ${noBearMarket.length === 1 ? "its" : "their"} backtest saw no SPY fall of 20%, so how much of a fall v4 keeps there is unmeasured` });
  if (Math.abs(input.allocationTotalPct - 100) > 0.005) warnings.push({ code: "allocations_not_100", symbols: [], text: `The allocations add up to ${input.allocationTotalPct.toFixed(2)}%, not 100%` });
  return warnings;
}

/** SPY's worst fall from a peak inside the dates, on daily closes. */
export function worstFallWithin(closes: readonly { tradingDate: string; close: number }[], fromIso: string, toIso: string): number | null {
  let peak: number | null = null;
  let worst = 0;
  for (const { tradingDate, close } of closes) {
    if (tradingDate < fromIso || tradingDate > toIso) continue;
    peak = peak === null ? close : Math.max(peak, close);
    worst = Math.min(worst, close / peak - 1);
  }
  return peak === null ? null : worst;
}
