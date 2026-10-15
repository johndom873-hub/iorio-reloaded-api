import type { SymbolFileQuote } from "../engine/backtestSymbolFile.js";
import { median } from "./analysisPriceFigures.js";

// The Analyse window's earnings and correlation figures (formulas approved 2026-10-15): F12 the move around a report, the
// implied move (D31), and F13 correlation and beta on daily log returns.

export interface AnalysisReport {
  date: string;
  /** ln(close of the session after the report ÷ close of the session before it); null without those closes. */
  move: number | null;
  /** (at-the-money Call mid + Put mid) ÷ the 10:00 price, first expiry after the report, at the session before it. */
  impliedMove: number | null;
  /** The straddle behind the implied move, for the screen's worked example. */
  straddle: { quoteDate: string; expiry: string; strike: number; callMid: number; putMid: number; price: number } | null;
}

/**
 * F12: D = the first session on or after the report date; move = ln(C(D+1) ÷ C(D−1)): two sessions, as the data does not
 * say whether a report came before the open or after the close.
 */
export function reportMove(closes: readonly { tradingDate: string; close: number }[], reportDate: string): number | null {
  const index = closes.findIndex((bar) => bar.tradingDate >= reportDate);
  if (index < 1 || index + 1 >= closes.length) return null;
  return Math.log(closes[index + 1]!.close / closes[index - 1]!.close);
}

/** The report day's session and the next one: the two sessions a jump on a report falls on. */
export function reportSessionDates(closes: readonly { tradingDate: string }[], reportDates: readonly string[]): Set<string> {
  const dates = new Set<string>();
  for (const reportDate of reportDates) {
    const index = closes.findIndex((bar) => bar.tradingDate >= reportDate);
    if (index < 0) continue;
    dates.add(closes[index]!.tradingDate);
    if (index + 1 < closes.length) dates.add(closes[index + 1]!.tradingDate);
  }
  return dates;
}

/**
 * D31: the at-the-money straddle (the strike whose Call and Put mids are closest) on the first expiry after the report
 * date, at the 10:00 quote of `quoteDate` (the session before the report), ÷ the 10:00 price as traded.
 */
export function impliedReportMove(quotes: readonly SymbolFileQuote[], quoteDate: string, reportDate: string, price: number): AnalysisReport["straddle"] & { impliedMove: number } | null {
  const usable = (quote: SymbolFileQuote) => quote.bid !== null && quote.ask !== null && quote.ask > 0 && quote.ask >= quote.bid;
  const expiries = [...new Set(quotes.filter((quote) => quote.expiry > reportDate && usable(quote)).map((quote) => quote.expiry))].sort();
  for (const expiry of expiries) {
    const mids = new Map<number, { call?: number; put?: number }>();
    for (const quote of quotes) {
      if (quote.expiry !== expiry || !usable(quote)) continue;
      const entry = mids.get(quote.strike) ?? {};
      entry[quote.right === "C" ? "call" : "put"] = (Math.max(quote.bid!, 0) + quote.ask!) / 2;
      mids.set(quote.strike, entry);
    }
    let best: { strike: number; callMid: number; putMid: number } | null = null;
    for (const [strike, { call, put }] of mids) {
      if (call === undefined || put === undefined) continue;
      if (best === null || Math.abs(call - put) < Math.abs(best.callMid - best.putMid)) best = { strike, callMid: call, putMid: put };
    }
    if (best) return { quoteDate, expiry, strike: best.strike, callMid: best.callMid, putMid: best.putMid, price, impliedMove: (best.callMid + best.putMid) / price };
  }
  return null;
}

export interface AnalysisEarningsSummary {
  reports: AnalysisReport[];
  medianAbsMove: number | null;
  largest: { date: string; move: number } | null;
  medianImpliedMove: number | null;
  /** Reports whose |move| was beyond the implied move, of those with both. */
  beyondImplied: number;
  withImplied: number;
  next: { date: string; afterClose: boolean | null } | null;
}

export function summarizeEarnings(reports: readonly AnalysisReport[], next: AnalysisEarningsSummary["next"]): AnalysisEarningsSummary {
  const moved = reports.filter((report): report is AnalysisReport & { move: number } => report.move !== null);
  const both = moved.filter((report) => report.impliedMove !== null);
  const largest = moved.reduce<{ date: string; move: number } | null>((best, report) => (best === null || Math.abs(report.move) > Math.abs(best.move) ? { date: report.date, move: report.move } : best), null);
  return {
    reports: [...reports],
    medianAbsMove: median(moved.map((report) => Math.abs(report.move))),
    largest,
    medianImpliedMove: median(both.map((report) => report.impliedMove!)),
    beyondImplied: both.filter((report) => Math.abs(report.move) > report.impliedMove!).length,
    withImplied: both.length,
    next,
  };
}

export interface AnalysisCorrelationRow {
  symbol: string;
  /** Trading days of returns the window holds: 252 (1Y) or 504 (2Y). */
  window: 252 | 504;
  n: number;
  correlation: number | null;
  /** Against SPY only. */
  beta: number | null;
}

const logReturnsByDate = (closes: readonly { tradingDate: string; close: number }[]) => {
  const returns = new Map<string, number>();
  for (let index = 1; index < closes.length; index++) if (closes[index]!.close > 0 && closes[index - 1]!.close > 0) returns.set(closes[index]!.tradingDate, Math.log(closes[index]!.close / closes[index - 1]!.close));
  return returns;
};

/**
 * F13: daily log returns on the dates both traded, the last 252 (1Y) and 504 (2Y) of them; correlation =
 * cov ÷ √(var × var) (sample, n − 1); beta to SPY = cov ÷ var(SPY).
 */
export function correlationRows(target: readonly { tradingDate: string; close: number }[], others: Record<string, readonly { tradingDate: string; close: number }[]>, benchmark = "SPY"): AnalysisCorrelationRow[] {
  const targetReturns = logReturnsByDate(target);
  const rows: AnalysisCorrelationRow[] = [];
  for (const [symbol, closes] of Object.entries(others)) {
    const otherReturns = logReturnsByDate(closes);
    const common = [...targetReturns.keys()].filter((date) => otherReturns.has(date)).sort();
    for (const window of [252, 504] as const) {
      const dates = common.slice(-window);
      const n = dates.length;
      if (n < 30) {
        rows.push({ symbol, window, n, correlation: null, beta: null });
        continue;
      }
      const a = dates.map((date) => targetReturns.get(date)!);
      const b = dates.map((date) => otherReturns.get(date)!);
      const meanA = a.reduce((sum, value) => sum + value, 0) / n;
      const meanB = b.reduce((sum, value) => sum + value, 0) / n;
      let cov = 0;
      let varA = 0;
      let varB = 0;
      for (let index = 0; index < n; index++) {
        cov += (a[index]! - meanA) * (b[index]! - meanB);
        varA += (a[index]! - meanA) ** 2;
        varB += (b[index]! - meanB) ** 2;
      }
      rows.push({ symbol, window, n, correlation: cov / Math.sqrt(varA * varB), beta: symbol === benchmark ? cov / varB : null });
    }
  }
  return rows;
}
