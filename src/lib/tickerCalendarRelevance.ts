// Pure (no DB import): calendarCaptureOutcome.ts uses it too. Callers read tradingview_ticker + sector from tickers.

/** tickers.sector holds IBKR's literal "ETF" for every ETF (resolveSector in fetchNewTickerData.ts falls back to its stockType). */
export function isEtfSector(sector: string | null | undefined): boolean {
  return sector === "ETF";
}

export interface TickerCalendarProfile {
  /** False for an ETF: it reports no earnings, and its ex-dividend dates are not checked either (Marcelo 2026-10-10). */
  calendarChecksApply: boolean;
  /**
   * Whether the ticker's earnings dates are known. Needs a TradingView symbol (the calendar capture's key); without one the
   * dates are unknown, not clear. Always true for an ETF, which has none to know.
   */
  earningsCalendarResolved: boolean;
}

export function tickerCalendarProfile(row: { tradingview_ticker: string | null; sector: string | null } | undefined): TickerCalendarProfile {
  const isEtf = isEtfSector(row?.sector);
  return { calendarChecksApply: !isEtf, earningsCalendarResolved: isEtf || !!row?.tradingview_ticker };
}
