import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { kellyFraction } from "../pluto/postModelGates.js";
import { mapTradingSettingsRow } from "../lib/tradingSettingsStore.js";
import { defaultBacktestBaselineSettings, defaultBacktestModelSettings, defaultBacktestPolicySettings, type BacktestSettingRow, type BacktestSettings, type BacktestSettingsTemplate } from "./backtestTypes.js";
import { earningsDateKnownCalendarDaysAhead } from "./engine/backtestTickerInputs.js";
import { readBacktestClaudeCliPath } from "./backtestClaudeCli.js";

// The New session settings table (docs/backtesting/): Pluto's and the trading settings as they are now, which a
// session snapshots and may change for itself only.

/** Pluto's settings, the trading settings without the commission estimator (the flat commission applies) and the Kelly fraction. */
export async function loadCurrentBacktestSettings(connection: Knex = db): Promise<BacktestSettings> {
  const [pluto, tradingRow] = await Promise.all([loadPlutoSettings(connection), connection("trading_settings").first()]);
  if (!tradingRow) throw new Error("No trading_settings row found.");
  const trading = mapTradingSettingsRow(tradingRow);
  return { pluto, trading, kellyFraction, policy: { ...defaultBacktestPolicySettings }, decisionMaker: "rules", model: { ...defaultBacktestModelSettings, spreadCostChargedPct: trading.spreadCostChargedPct }, baseline: { ...defaultBacktestBaselineSettings } };
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
      { value: "baseline", label: "Baseline wheel (no Pluto rules, no Signals)" },
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
    note: "round lots, when no call on them clears Pluto's rules (code sells such a call first, as live)",
    choices: [
      { value: "call_else_sell", label: "Sell the shares when no call can be sent now" },
      { value: "always_sell", label: "Always sell the shares" },
      { value: "always_keep", label: "Keep them" },
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

  {
    path: "baseline.entry",
    group: "Baseline wheel",
    label: "Entry with free cash",
    unit: "choice",
    editable: true,
    note: "only with the baseline wheel as decision maker. At every look free round lots get the call with the highest premium yield, free cash the entry with the highest premium yield; everything is held to expiry",
    choices: [
      { value: "put", label: "Cash-Secured Put" },
      { value: "buy_write", label: "Covered Call (100 shares bought and one call sold on them)" },
    ],
  },
  { path: "baseline.minAbsDelta", group: "Baseline wheel", label: "|delta| from", unit: "number", editable: true, note: "from each quote's own implied volatility" },
  { path: "baseline.maxAbsDelta", group: "Baseline wheel", label: "|delta| to", unit: "number", editable: true, note: null },
  { path: "baseline.minDte", group: "Baseline wheel", label: "Days to expiry from", unit: "days", editable: true, note: "0 = options expiring on the look's day" },
  { path: "baseline.maxDte", group: "Baseline wheel", label: "Days to expiry to", unit: "days", editable: true, note: "data files hold up to 45 days" },
  { path: "baseline.maxSpreadPctOfMid", group: "Baseline wheel", label: "Spread at most", unit: "percent", editable: true, note: "(ask − bid) ÷ mid; contracts quoted wider are left out" },
  {
    path: "baseline.callStrike",
    group: "Baseline wheel",
    label: "Calls on held shares",
    unit: "choice",
    editable: true,
    note: "cost: what the cycle's shares cost per share; break-even: that cost less the cycle's premium (Pluto's measure)",
    choices: [
      { value: "delta_range", label: "Any strike in the delta range" },
      { value: "above_share_cost", label: "Strike at or above the shares' cost" },
      { value: "above_break_even", label: "Strike at or above the break-even" },
      { value: "above_latest_entry", label: "Strike at or above the latest share purchase price" },
      { value: "above_average_cost", label: "Strike at or above the average price paid for the shares held" },
      { value: "above_average_cost_else_break_even", label: "At or above the average price paid; lots still uncovered at or above the break-even" },
      { value: "none", label: "No calls (the shares are held uncovered)" },
    ],
  },
  {
    path: "baseline.entryCallStrike",
    group: "Baseline wheel",
    label: "The call of a new Covered Call",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "any", label: "Any strike in the delta range" },
      { value: "above_purchase_price", label: "Strike at or above the price paid for its shares" },
      { value: "above_average_after_purchase", label: "Strike at or above the average price of the shares held, these included" },
    ],
  },
  {
    path: "baseline.entryWhenSharesUncovered",
    group: "Baseline wheel",
    label: "New Covered Calls while held shares have no call",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "wait", label: "Wait until every held lot has a call" },
      { value: "buy", label: "Buy: the new Covered Call buys every share its call covers" },
    ],
  },
  { path: "baseline.maxSharesPctOfAccount", group: "Baseline wheel", label: "Shares at most", unit: "percent", editable: true, note: "of the account value, the shares held at the 10:00 price: new Covered Calls stop there; 100 = no cap" },
  { path: "baseline.minCallYieldPct", group: "Baseline wheel", label: "Calls only above a premium yield of", unit: "percent", editable: true, note: "annualized, on held shares and new Covered Calls alike; 0 = any" },
  {
    path: "baseline.putsWhenNoCall",
    group: "Baseline wheel",
    label: "Puts when no call is sold",
    unit: "choice",
    editable: true,
    note: "one put at a time: the highest premium yield, strike at most the average price held",
    choices: [
      { value: "off", label: "None" },
      { value: "dte_budget", label: "One put, its exposure a % of the account per day to expiry" },
      { value: "reserve_ladder", label: "A ladder on a cash reserve: the more of it committed, the lower the strike" },
    ],
  },
  { path: "baseline.putBudgetPctPerDte", group: "Baseline wheel", label: "Put exposure per day to expiry", unit: "percent", editable: true, note: "of the account value: 1% on $200,000 lets a 4-day put take $8,000" },
  { path: "baseline.ladderSharesPct", group: "Baseline wheel", label: "Ladder: shares at most", unit: "percent", editable: true, note: "of the account value the cycle started with, at cost; the rest is the puts' reserve" },
  { path: "baseline.ladderRungs", group: "Baseline wheel", label: "Ladder: rungs", unit: "integer", editable: true, note: "each put's collateral at most the reserve ÷ rungs" },
  {
    path: "baseline.ladderShock",
    group: "Baseline wheel",
    label: "Ladder: stock shock",
    unit: "choice",
    editable: true,
    note: "the fall from the highest price since the cycle started at which the reserve is fully committed",
    choices: [
      { value: "history", label: "The stock's Max drawdown in the years before the cycle, within the range below" },
      { value: "fixed", label: "Fixed, below" },
    ],
  },
  { path: "baseline.ladderShockPct", group: "Baseline wheel", label: "Ladder: fixed shock", unit: "percent", editable: true, note: null },
  { path: "baseline.ladderShockMinPct", group: "Baseline wheel", label: "Ladder: shock at least", unit: "percent", editable: true, note: "from history" },
  { path: "baseline.ladderShockMaxPct", group: "Baseline wheel", label: "Ladder: shock at most", unit: "percent", editable: true, note: "from history" },
  { path: "baseline.ladderShockNoHistoryPct", group: "Baseline wheel", label: "Ladder: shock with under a year of history", unit: "percent", editable: true, note: "a new listing: fewer than 250 closes in the years of history" },
  { path: "baseline.ladderShockLookbackYears", group: "Baseline wheel", label: "Ladder: years of history", unit: "integer", editable: true, note: null },
  {
    path: "baseline.ladderTop",
    group: "Baseline wheel",
    label: "Ladder: top",
    unit: "choice",
    editable: true,
    note: "where the rungs start: K_max = top − (top − floor) × (committed + rung) ÷ reserve",
    choices: [
      { value: "break_even", label: "The cycle's break-even" },
      { value: "price", label: "The lower of the break-even and today's price" },
    ],
  },
  {
    path: "baseline.ladderPace",
    group: "Baseline wheel",
    label: "Ladder: pace",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "any_look", label: "A new rung at any look with room" },
      { value: "one_open", label: "A new rung only while no ladder put is open" },
      { value: "no_puts", label: "No puts: the shares' budget alone, the reserve kept in cash" },
    ],
  },
  {
    path: "baseline.ladderPutVersusCall",
    group: "Baseline wheel",
    label: "Ladder: put or call on free shares",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "call_first", label: "A put only when no call on the free shares qualifies" },
      { value: "higher_yield", label: "A put when its yield beats the best call's by more than the margin" },
    ],
  },
  { path: "baseline.ladderPutYieldMarginPct", group: "Baseline wheel", label: "Ladder: put yield above the call's by more than", unit: "percent", editable: true, note: "relative: 25 = a quarter above the call's yield; 0 = any higher" },
  { path: "baseline.ladderMinutesBetweenRungs", group: "Baseline wheel", label: "Ladder: minutes between new rungs, at least", unit: "integer", editable: true, note: "from the ticker's last rung; 0 = any look (looks are 30 minutes apart)" },
  { path: "baseline.ladderMaxRungsPerSession", group: "Baseline wheel", label: "Ladder: new rungs per session, at most", unit: "integer", editable: true, note: "per ticker; 0 = no limit" },
  {
    path: "baseline.shareFill",
    group: "Baseline wheel",
    label: "A new Covered Call's shares bought at",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "plus_one_cent", label: "The 10:00 price + $0.01" },
      { value: "ten_oclock_price", label: "The 10:00 price" },
    ],
  },
  {
    path: "baseline.dayValueOptions",
    group: "Baseline wheel",
    label: "Open options in the day's account value",
    unit: "choice",
    editable: true,
    note: "left out: the account is cash (premiums included) and shares at the 10:00 price",
    choices: [
      { value: "marked", label: "At their marks" },
      { value: "excluded", label: "Left out" },
    ],
  },
  {
    path: "baseline.callDeltaRange",
    group: "Baseline wheel",
    label: "|delta| of calls on held shares",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "entry_range", label: "The entry's range" },
      { value: "own_range", label: "Their own range, below" },
    ],
  },
  { path: "baseline.callMinAbsDelta", group: "Baseline wheel", label: "Calls' |delta| from", unit: "number", editable: true, note: "with their own range" },
  { path: "baseline.callMaxAbsDelta", group: "Baseline wheel", label: "Calls' |delta| to", unit: "number", editable: true, note: "with their own range" },
  { path: "baseline.takeProfitPct", group: "Baseline wheel", label: "Take profit at", unit: "percent", editable: true, note: "of the premium: an option is bought back at a look once buying it back keeps at least this much; 0 = hold to expiry" },
  { path: "baseline.shareStopLossPct", group: "Baseline wheel", label: "Sell shares below cost by", unit: "percent", editable: true, note: "every share of the stock is sold (any call on them bought back) once the price is this far below what the cycle's shares cost; 0 = never" },
  {
    path: "baseline.earnings",
    group: "Baseline wheel",
    label: "Earnings",
    unit: "choice",
    editable: true,
    note: "a report's date is known from 30 calendar days before it",
    choices: [
      { value: "ignore", label: "Sell through earnings" },
      { value: "skip_spanning", label: "No sale whose expiry spans earnings" },
    ],
  },
  { path: "baseline.maxAccountPctPerStock", group: "Baseline wheel", label: "Max per stock", unit: "percent", editable: true, note: "% of the account for new sales: puts at their strike, shares at their cost, net of premium" },
  {
    path: "baseline.looks",
    group: "Baseline wheel",
    label: "Decides",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "every_look", label: "At every look (every 30 minutes)" },
      { value: "first_look", label: "Once a day, at 10:00" },
    ],
  },
  {
    path: "baseline.volatilityEdgeFilter",
    group: "Baseline wheel",
    label: "Sell only above the forecast",
    unit: "choice",
    editable: true,
    note: "a contract's implied volatility against the stock's 21-session forecast, both on the forecast's clock (the Signals model's IV and forecast)",
    choices: [
      { value: "off", label: "Off" },
      { value: "entries", label: "New entries only, by at least the margin below" },
      { value: "all_sales", label: "Every sale (calls on held shares too), by at least the margin below" },
    ],
  },
  { path: "baseline.minVolatilityEdgePoints", group: "Baseline wheel", label: "IV above the forecast by", unit: "number", editable: true, note: "volatility points (5: 55% against a 50% forecast); may be negative" },
  {
    path: "baseline.ranking",
    group: "Baseline wheel",
    label: "Pick by",
    unit: "choice",
    editable: true,
    note: "Edge Yield: the Signals model's expected P&L after costs, as a yearly rate on the exposure",
    choices: [
      { value: "premium_yield", label: "Premium yield" },
      { value: "edge_yield", label: "Edge Yield" },
      { value: "time_value", label: "Time value (premium less what is already in the money)" },
      { value: "premium_dollars", label: "Premium in dollars" },
      { value: "premium_per_day", label: "Premium in dollars per day to expiry" },
    ],
  },
  {
    path: "baseline.expiryChoice",
    group: "Baseline wheel",
    label: "Expiry",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "any_in_range", label: "Any in the range, by the ranking" },
      { value: "nearest_qualifying", label: "The nearest that has a qualifying contract" },
    ],
  },
  {
    path: "baseline.coverage",
    group: "Baseline wheel",
    label: "When the volume limit binds",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "best_contract", label: "Only the best contract; the rest waits" },
      { value: "fill_down_ranking", label: "The rest goes to the next candidates in order" },
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
  if (section === "baseline") return ({ ...defaultBacktestBaselineSettings, ...settings.baseline } as unknown as Record<string, number | string>)[field]!;
  if (section === "model") {
    const model = { ...defaultBacktestModelSettings, ...settings.model };
    return field === "spreadCostChargedPct" ? (model.spreadCostChargedPct ?? settings.trading.spreadCostChargedPct) : (model as unknown as Record<string, number | string>)[field]!;
  }
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
