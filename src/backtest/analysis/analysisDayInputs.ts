import { ladderShock } from "../engine/backtestBaselineLadder.js";
import { splitFactorOn, type SplitSchedule } from "../engine/splitFactors.js";
import type { FileIntradayPrices } from "../backtestFileStockBars.js";
import type { TreasuryBillRates } from "../engine/treasuryBillRates.js";
import type { StoredDailyBar } from "../engine/backtestBarHistory.js";
import type { BacktestBaselineSettings } from "../backtestTypes.js";
import { earningsNotYetReported, type BacktestTickerProfile } from "../engine/backtestTickerInputs.js";
import type { ChainScanDayInput } from "./analysisChainScan.js";

// What each scanned day reads besides its quotes, as the engine reads it (runBacktestSession.ts): the 10:00 price as
// traded (the close of IBKR's 09:30 bar, split-adjusted, × the day's split factor), the T-bill rate of the day before, the
// previous complete file day (its volume sets the limit), the shock the rule gives for a cycle starting that day, and the
// earnings dates known that day and not yet reported (the engine's earnings filter).

export type AnalysisShockSettings = Pick<BacktestBaselineSettings, "ladderShock" | "ladderShockPct" | "ladderShockMinPct" | "ladderShockMaxPct" | "ladderShockNoHistoryPct" | "ladderShockLookbackYears">;

const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The 10:00 price as traded; null without the 09:30 bar or a split factor. */
export function tenOclockPriceAsTraded(dateIso: string, intradayPrices: FileIntradayPrices, schedule: SplitSchedule | null): number | null {
  const adjusted = intradayPrices.priceAt(dateIso, "10:00");
  const factor = schedule === null ? 1 : splitFactorOn(schedule, dateIso);
  return adjusted === null || factor === null ? null : adjusted * factor;
}

export function buildChainScanDayInputs(input: {
  /** The file's complete days, ascending. */
  completeDays: readonly string[];
  intradayPrices: FileIntradayPrices;
  /** Null when the symbol has no split schedule (no splits found): factor 1. */
  schedule: SplitSchedule | null;
  rates: TreasuryBillRates;
  /** IBKR's daily bars (split-adjusted), ascending: the shock rule's closes. */
  dailyBars: readonly StoredDailyBar[];
  shockSettings: AnalysisShockSettings;
  /** The ticker's earnings when the lab skips expiries spanning one (and the ticker is not an ETF); null when earnings are ignored. */
  earnings: BacktestTickerProfile["earnings"] | null;
}): ChainScanDayInput[] {
  const closes = input.dailyBars.filter((bar) => bar.close !== null && bar.close > 0).map((bar) => ({ date: bar.tradingDate, close: bar.close! }));
  return input.completeDays.map((date, index) => ({
    date,
    previousDate: index > 0 ? input.completeDays[index - 1]! : null,
    spot: tenOclockPriceAsTraded(date, input.intradayPrices, input.schedule),
    riskFreeRate: (input.rates.ratePercentOnOrBefore(addCalendarDays(date, -1)) ?? 0) / 100,
    shock: ladderShock(input.shockSettings, closes, date),
    earningsDatesIso: input.earnings === null ? null : earningsNotYetReported(input.earnings, date),
  }));
}
