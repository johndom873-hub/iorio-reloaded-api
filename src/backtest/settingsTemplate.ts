import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { kellyFraction } from "../pluto/postModelGates.js";
import { mapTradingSettingsRow } from "../lib/tradingSettingsStore.js";
import { defaultBacktestPolicySettings, type BacktestSettingRow, type BacktestSettings, type BacktestSettingsTemplate } from "./backtestTypes.js";
import { earningsDateKnownCalendarDaysAhead } from "./engine/backtestTickerInputs.js";
import { readBacktestClaudeCliPath } from "./backtestClaudeCli.js";

// The New session settings table (docs/backtesting/): Pluto's and the trading settings as they are now, which a
// session snapshots and may change for itself only.

/** Pluto's settings, the trading settings without the commission estimator (the flat commission applies) and the Kelly fraction. */
export async function loadCurrentBacktestSettings(connection: Knex = db): Promise<BacktestSettings> {
  const [pluto, tradingRow] = await Promise.all([loadPlutoSettings(connection), connection("trading_settings").first()]);
  if (!tradingRow) throw new Error("No trading_settings row found.");
  return { pluto, trading: mapTradingSettingsRow(tradingRow), kellyFraction, policy: { ...defaultBacktestPolicySettings }, decisionMaker: "rules" };
}

type RowDefinition = Omit<BacktestSettingRow, "now"> & { fixedValue?: number | string };

const percentOfAccount = "% of the account";
const decisionsGroup = "Decisions (stand-in for the AI)" as const;
const windowAndChecksGroup = "Trading window and system checks" as const;

/** Groups and order as the New session table shows them. "fixed." rows are model constants, shown but not editable. */
export const backtestSettingRowDefinitions: readonly RowDefinition[] = [
  { path: "pluto.capitalBudgetPct", group: "Capital and sizing", label: "Capital budget", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.orderSizePctOfBudget", group: "Capital and sizing", label: "Order size", unit: "percent", editable: true, note: "% of the capital budget" },
  { path: "pluto.maxTickerExposurePct", group: "Capital and sizing", label: "Max per ticker", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.maxSectorExposurePct", group: "Capital and sizing", label: "Max per sector", unit: "percent", editable: true, note: "% of the account; 100 = no cap; a symbol's sector is the one on its ticker" },
  { path: "pluto.maxOpenPositions", group: "Capital and sizing", label: "Max open positions", unit: "integer", editable: true, note: null },
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
  { path: "fixed.earningsDateKnownCalendarDaysAhead", group: "Candidate quality", label: "Earnings dates known 30 days ahead", unit: "days", editable: false, note: "a report's date is seen from 30 calendar days before it: expiries spanning it are skipped, and Pluto's closes before earnings apply, only from then", fixedValue: earningsDateKnownCalendarDaysAhead },

  { path: "trading.spreadCostChargedPct", group: "Model", label: "Spread cost share", unit: "percent", editable: true, note: "how much of the half-spread a fill gives up" },
  { path: "pluto.maxSliceRmseVp", group: "Model", label: "Max slice fit error", unit: "number", editable: true, note: "volatility points: worst surface fit error trusted for the expiry" },
  { path: "pluto.minSlicePointCount", group: "Model", label: "Min slice points", unit: "integer", editable: true, note: "fewest quotes the expiry's fit must rest on" },
  { path: "pluto.maxMidVsSurfaceIvVp", group: "Model", label: "Max mid vs surface IV", unit: "number", editable: true, note: "volatility points: largest gap between the mid's IV and the surface" },
  { path: "pluto.maxIvShiftVp", group: "Model", label: "Max IV shift", unit: "number", editable: true, note: "volatility points: how far an expiry's quotes at a look may sit from the 10:00 surface; 0 at the 10:00 look and on days without intraday quotes" },
  { path: "fixed.forecastWindowDays", group: "Model", label: "Forecast window", unit: "days", editable: false, note: null, fixedValue: 21 },
  { path: "fixed.gradeCutPoints", group: "Model", label: "Grade cut points", unit: "percent", editable: false, note: null, fixedValue: "20 / 10 / 0%" },

  { path: "pluto.windowStartEt", group: windowAndChecksGroup, label: "Looks from", unit: "time", editable: false, note: "ET; a look every 30 minutes where the data files hold quotes (10:00 to 15:30)" },
  { path: "pluto.windowEndEt", group: windowAndChecksGroup, label: "Looks until", unit: "time", editable: false, note: "ET; never later than 30 minutes before the close (12:30 on a 13:00 day)" },
  { path: "pluto.maxActionsPerSession", group: windowAndChecksGroup, label: "Max orders per day", unit: "integer", editable: true, note: "across every symbol and every look of the day, automatic closes included" },
  { path: "pluto.tickerCooldownMinutes", group: windowAndChecksGroup, label: "Ticker cooldown after a fill", unit: "integer", editable: true, note: "minutes; 60 = no new open or roll on the ticker at the next look, allowed again at the one after" },
  { path: "pluto.dailyLossBreakerPct", group: windowAndChecksGroup, label: "Daily-loss breaker", unit: "percent", editable: true, note: "the account down this much from the previous close at a look: nothing more is done that day" },
  { path: "pluto.spyStressBreakerPct", group: windowAndChecksGroup, label: "Market stress", unit: "percent", editable: true, note: "SPY down this much on the day at a look: no new opens at that look; rolls and closes stay" },

  {
    path: "decisionMaker",
    group: decisionsGroup,
    label: "Decision maker",
    unit: "choice",
    editable: true,
    note: "who makes the choices the AI model makes live. The rules: each pass looks at closes, then rolls, then opens, and an open is Pluto's own top pick. The AI model: Claude through the subscription, asked as live Pluto asks it, with the symbols and dates masked; the rules below do not apply",
    choices: [
      { value: "rules", label: "Rules (below)" },
      { value: "llm", label: "The AI model" },
    ],
  },
  {
    path: "policy.roll",
    group: decisionsGroup,
    label: "Roll or hold",
    unit: "choice",
    editable: true,
    note: "the best eligible roll by net roll $; never while the ticker cools down after a fill",
    choices: [
      { value: "flagged_legs", label: "Roll a leg near expiry, at assignment risk or decayed" },
      { value: "any_eligible", label: "Roll whenever a roll is eligible" },
      { value: "never", label: "Never roll" },
    ],
  },
  {
    path: "policy.buyback",
    group: decisionsGroup,
    label: "Buyback when holding no longer pays",
    unit: "choice",
    editable: true,
    note: "Pluto offers it only at a profit, when the put's hold value is below its closing cost",
    choices: [
      { value: "when_offered", label: "Buy back" },
      { value: "never", label: "Never" },
    ],
  },
  {
    path: "policy.sharesInProfit",
    group: decisionsGroup,
    label: "Shares in profit above the floor",
    unit: "choice",
    editable: true,
    note: "round lots; a call must clear the cycle break-even rule",
    choices: [
      { value: "call_else_sell", label: "Sell a call on them, else sell the shares" },
      { value: "always_sell", label: "Always sell the shares" },
      { value: "always_keep", label: "Keep them (calls only)" },
    ],
  },
  {
    path: "policy.eventClose",
    group: decisionsGroup,
    label: "Close before a macro event",
    unit: "choice",
    editable: true,
    note: "Pluto offers it from 5 sessions before a Fed decision, CPI, the jobs report, GDP or a federal election, only at a profit",
    choices: [
      { value: "stress_vs_remaining", label: "When the event's stress loss is at least what is left to earn" },
      { value: "never", label: "Never" },
      { value: "always", label: "Always" },
    ],
  },
  {
    path: "policy.afterBlockedChoice",
    group: decisionsGroup,
    label: "After a choice Pluto's checks refuse",
    unit: "choice",
    editable: true,
    note: "choosing again tries the next candidate at the same look; a refusal for lack of room ends the opens for that look where there is none: on the ticker (its exposure limits, its cooldown) or on every ticker (budget, cash reserve, open-positions cap); rolls and closes are still tried. Every refused choice is kept in the session's actions with the check that refused it",
    choices: [
      { value: "try_next", label: "Choose again, but no more opens where the account has no room" },
      { value: "stop", label: "Stop for this look" },
    ],
  },
];

/** Pluto behaviour a session does not replay, for the note under the table. */
export const backtestNotReplayed: readonly string[] = [
  "With the rules as decision maker, the AI model's own choice. With the AI model: the quote burst before a call, an order kept working while the round goes on, and the rounds a settings change or a person starts.",
  "What happens between two looks: Pluto looks every 30 minutes, on the quotes of that instant, not at every Day Signals update.",
  "The edge-margin drift check and the live-quote check before an order: a look re-scores on its own quotes.",
  "Orders in flight: a session's order fills when it is placed.",
  "A human's hand: the daily-loss breaker is taken as reset before the next open, and the market-stress override is never used.",
  "A symbol's looks after 10:00 on the days its data file has no intraday quotes.",
  "Early assignment and dividends.",
];

/** Paths a session may override. */
export const editableBacktestSettingPaths: ReadonlySet<string> = new Set(backtestSettingRowDefinitions.filter((row) => row.editable).map((row) => row.path));

/** The value a row's path addresses inside the settings ("pluto.minDte", "trading.deltaTargetMin", "kellyFraction", "policy.roll", "decisionMaker"). */
export function readBacktestSettingValue(settings: BacktestSettings, settingPath: string): number | string {
  if (settingPath === "kellyFraction") return settings.kellyFraction;
  if (settingPath === "decisionMaker") return settings.decisionMaker ?? "rules";
  const [section, field] = settingPath.split(".") as [string, string];
  if (section === "policy") return ({ ...defaultBacktestPolicySettings, ...settings.policy } as unknown as Record<string, string>)[field]!;
  if (section === "pluto") return (settings.pluto as unknown as Record<string, number | string>)[field]!;
  if (section === "trading") return (settings.trading as unknown as Record<string, number | string>)[field]!;
  throw new Error(`Not a settings path: ${settingPath}`);
}

/** The AI model as decision maker cannot be picked while BACKTEST_CLAUDE_CLI_PATH is unset. */
export const claudeCliUnavailableReason = "BACKTEST_CLAUDE_CLI_PATH is not set in the API's .env";

export function buildBacktestSettingRows(settings: BacktestSettings, decisionMakers: { claudeCliAvailable: boolean }): BacktestSettingRow[] {
  return backtestSettingRowDefinitions.map(({ fixedValue, ...row }) => ({
    ...row,
    ...(row.path === "decisionMaker" && row.choices && !decisionMakers.claudeCliAvailable
      ? { choices: row.choices.map((choice) => (choice.value === "llm" ? { ...choice, unavailableReason: claudeCliUnavailableReason } : choice)) }
      : {}),
    now: fixedValue ?? readBacktestSettingValue(settings, row.path),
  }));
}

export async function loadBacktestSettingsTemplate(connection: Knex = db): Promise<BacktestSettingsTemplate> {
  const settings = await loadCurrentBacktestSettings(connection);
  return { settings, rows: buildBacktestSettingRows(settings, { claudeCliAvailable: readBacktestClaudeCliPath() !== null }), notReplayed: [...backtestNotReplayed] };
}
