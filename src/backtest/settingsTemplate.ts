import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { kellyFraction } from "../pluto/postModelGates.js";
import { mapTradingSettingsRow } from "../lib/tradingSettingsStore.js";
import type { BacktestSettingRow, BacktestSettings, BacktestSettingsTemplate } from "./backtestTypes.js";

// The New session settings table (docs/backtesting/): Pluto's and the trading settings as they are now, which a
// session snapshots and may change for itself only.

/** Pluto's settings, the trading settings without the commission estimator (the flat commission applies) and the Kelly fraction. */
export async function loadCurrentBacktestSettings(connection: Knex = db): Promise<BacktestSettings> {
  const [pluto, tradingRow] = await Promise.all([loadPlutoSettings(connection), connection("trading_settings").first()]);
  if (!tradingRow) throw new Error("No trading_settings row found.");
  return { pluto, trading: mapTradingSettingsRow(tradingRow), kellyFraction };
}

type RowDefinition = Omit<BacktestSettingRow, "now"> & { fixedValue?: number | string };

const percentOfAccount = "% of the account";

/** Groups and order as the New session table shows them. "fixed." rows are model constants, shown but not editable. */
export const backtestSettingRowDefinitions: readonly RowDefinition[] = [
  { path: "pluto.capitalBudgetPct", group: "Capital and sizing", label: "Capital budget", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.orderSizePctOfBudget", group: "Capital and sizing", label: "Order size", unit: "percent", editable: true, note: "% of the capital budget" },
  { path: "pluto.maxTickerExposurePct", group: "Capital and sizing", label: "Max per ticker", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.maxOpenPositions", group: "Capital and sizing", label: "Max open positions", unit: "integer", editable: true, note: null },
  { path: "pluto.maxActionsPerSession", group: "Capital and sizing", label: "Max orders per day", unit: "integer", editable: false, note: "one look a day at 10:00 on one symbol: at most one order a day" },
  { path: "pluto.minCashReservePct", group: "Capital and sizing", label: "Min cash reserve", unit: "percent", editable: true, note: null },
  { path: "trading.maxPositionPctOfPortfolio", group: "Capital and sizing", label: "Max order size (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "trading.maxConcentrationPerTickerPct", group: "Capital and sizing", label: "Max per ticker (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "trading.minCashReservePct", group: "Capital and sizing", label: "Min cash reserve (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.stressRiskBudgetPct", group: "Capital and sizing", label: "Stress cap per order", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.stressSigmas", group: "Capital and sizing", label: "Stress move", unit: "number", editable: true, note: "σ (standard deviations of the forecast move)" },
  { path: "kellyFraction", group: "Capital and sizing", label: "Kelly fraction", unit: "number", editable: true, note: `Pluto sizes with a fixed ${kellyFraction} of full Kelly` },

  { path: "pluto.minGrade", group: "Candidate quality", label: "Min grade", unit: "grade", editable: true, note: null },
  { path: "pluto.minEdgeYieldPct", group: "Candidate quality", label: "Min Edge Yield", unit: "percent", editable: true, note: null },
  { path: "pluto.maxAbsDelta", group: "Candidate quality", label: "Max |delta|", unit: "number", editable: true, note: null },
  { path: "trading.deltaTargetMin", group: "Candidate quality", label: "Delta band from", unit: "number", editable: true, note: null },
  { path: "trading.deltaTargetMax", group: "Candidate quality", label: "Delta band to", unit: "number", editable: true, note: null },
  { path: "pluto.minDte", group: "Candidate quality", label: "Min days to expiry", unit: "days", editable: true, note: null },
  { path: "pluto.maxDte", group: "Candidate quality", label: "Max days to expiry", unit: "days", editable: true, note: "data files hold up to 45 days" },
  { path: "pluto.minAnnualizedYieldPct", group: "Candidate quality", label: "Min premium yield", unit: "percent", editable: true, note: null },
  { path: "trading.minAnnualizedYieldPct", group: "Candidate quality", label: "Min premium yield (Signals)", unit: "percent", editable: true, note: null },
  { path: "pluto.maxSpreadPct", group: "Candidate quality", label: "Max spread", unit: "percent", editable: true, note: "% of mid" },
  { path: "pluto.minOpenInterest", group: "Candidate quality", label: "Min open interest", unit: "integer", editable: true, note: "the previous day's, as Pluto sees at 10:00" },
  { path: "pluto.minSessionVolume", group: "Candidate quality", label: "Min volume", unit: "integer", editable: true, note: "the previous day's full-day volume: today's at 10:00 is not in the history" },
  { path: "pluto.maxContractsVolumeSharePct", group: "Candidate quality", label: "Max share of contract volume", unit: "percent", editable: true, note: "of the previous day's volume" },
  { path: "pluto.maxDayMoveMultiple", group: "Candidate quality", label: "Max day move", unit: "number", editable: true, note: "× the normal daily move" },

  { path: "trading.spreadCostChargedPct", group: "Model", label: "Spread cost share", unit: "percent", editable: true, note: "how much of the half-spread a fill gives up" },
  { path: "pluto.maxSliceRmseVp", group: "Model", label: "Max slice fit error", unit: "number", editable: true, note: "volatility points: worst surface fit error trusted for the expiry" },
  { path: "pluto.minSlicePointCount", group: "Model", label: "Min slice points", unit: "integer", editable: true, note: "fewest quotes the expiry's fit must rest on" },
  { path: "pluto.maxMidVsSurfaceIvVp", group: "Model", label: "Max mid vs surface IV", unit: "number", editable: true, note: "volatility points: largest gap between the mid's IV and the surface" },
  { path: "pluto.maxIvShiftVp", group: "Model", label: "Max IV shift", unit: "number", editable: false, note: "no intraday quotes in the history: always 0 in a backtest" },
  { path: "fixed.forecastWindowDays", group: "Model", label: "Forecast window", unit: "days", editable: false, note: null, fixedValue: 21 },
  { path: "fixed.gradeCutPoints", group: "Model", label: "Grade cut points", unit: "percent", editable: false, note: null, fixedValue: "30 / 20 / 10%" },
];

/** Pluto behaviour a session does not replay, for the note under the table. */
export const backtestNotReplayed: readonly string[] = [
  "The AI model's own choice: the session trades Pluto's deterministic top pick, the first of its own ranking.",
  "Quote-age and live-quote checks.",
  "The edge-margin drift check.",
  "The daily-loss breaker and market stress (SPY's intraday move).",
  "Orders in flight: a session's order fills when it is placed.",
  "The trading window: one look a day, at 10:00.",
  "Buybacks, rolls and assignment: positions are held to expiry.",
  "Macro-event flags: there is no stored history before 2026-08.",
];

/** Paths a session may override. */
export const editableBacktestSettingPaths: ReadonlySet<string> = new Set(backtestSettingRowDefinitions.filter((row) => row.editable).map((row) => row.path));

/** The value a row's path addresses inside the settings ("pluto.minDte", "trading.deltaTargetMin", "kellyFraction"). */
export function readBacktestSettingValue(settings: BacktestSettings, settingPath: string): number | string {
  if (settingPath === "kellyFraction") return settings.kellyFraction;
  const [section, field] = settingPath.split(".") as [string, string];
  if (section === "pluto") return (settings.pluto as unknown as Record<string, number | string>)[field]!;
  if (section === "trading") return (settings.trading as unknown as Record<string, number | string>)[field]!;
  throw new Error(`Not a settings path: ${settingPath}`);
}

export function buildBacktestSettingRows(settings: BacktestSettings): BacktestSettingRow[] {
  return backtestSettingRowDefinitions.map(({ fixedValue, ...row }) => ({ ...row, now: fixedValue ?? readBacktestSettingValue(settings, row.path) }));
}

export async function loadBacktestSettingsTemplate(connection: Knex = db): Promise<BacktestSettingsTemplate> {
  const settings = await loadCurrentBacktestSettings(connection);
  return { settings, rows: buildBacktestSettingRows(settings), notReplayed: [...backtestNotReplayed] };
}
