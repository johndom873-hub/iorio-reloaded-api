import { splitFactorOn, type SplitSchedule } from "../engine/splitFactors.js";
import type { BacktestSymbolFile } from "../engine/backtestSymbolFile.js";
import type { FileIntradayPrices } from "../backtestFileStockBars.js";
import type { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import type { SameDayCallScanDay } from "./analysisSameDayCalls.js";

// What each scanned expiry day reads besides its quotes, as the engine reads it (runBacktestSession.ts): the 10:00 price as
// traded (the close of IBKR's 09:30 bar, split-adjusted, × the day's split factor), the T-bill rate of the day before, and
// the previous complete file day (its volume sets the limit).

const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const isoOfExpiry = (expiry: string) => (/^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}` : expiry.slice(0, 10));

/** The expiry days among `dates` (S2's, F1's, F5's): the days whose 10:00 quotes list a Call expiring that day. */
export function expiryDaysAmong(file: BacktestSymbolFile, dates: readonly string[]): Set<string> {
  return new Set(dates.filter((date) => file.loadCallExpiries(date).some((expiry) => isoOfExpiry(expiry) === date)));
}

/** The 10:00 price as traded; null without the 09:30 bar or a split factor. */
export function tenOclockPriceAsTraded(dateIso: string, intradayPrices: FileIntradayPrices, schedule: SplitSchedule | null): number | null {
  const adjusted = intradayPrices.priceAt(dateIso, "10:00");
  const factor = schedule === null ? 1 : splitFactorOn(schedule, dateIso);
  return adjusted === null || factor === null ? null : adjusted * factor;
}

/** The scan's inputs for `scannedDays` (each a complete file day), with `completeDays` (ascending) giving each one's previous day. */
export function buildSameDayCallScanDays(input: { completeDays: readonly string[]; scannedDays: readonly string[]; intradayPrices: FileIntradayPrices; schedule: SplitSchedule | null; rates: TreasuryBillRates }): SameDayCallScanDay[] {
  const indexOf = new Map(input.completeDays.map((date, index) => [date, index]));
  return input.scannedDays.map((date) => {
    const index = indexOf.get(date) ?? -1;
    return {
      date,
      previousDate: index > 0 ? input.completeDays[index - 1]! : null,
      spot: tenOclockPriceAsTraded(date, input.intradayPrices, input.schedule),
      riskFreeRate: (input.rates.ratePercentOnOrBefore(addCalendarDays(date, -1)) ?? 0) / 100,
    };
  });
}
