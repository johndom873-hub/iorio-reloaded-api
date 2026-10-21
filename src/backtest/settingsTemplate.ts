import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { kellyFraction } from "../pluto/postModelGates.js";
import { mapTradingSettingsRow } from "../lib/tradingSettingsStore.js";
import { backtestTickerBaselineKeys, defaultBacktestBaselineSettings, defaultBacktestModelSettings, defaultBacktestPolicySettings, type BacktestSettingApplicability, type BacktestSettingCondition, type BacktestSettingGroup, type BacktestSettingRow, type BacktestSettingSection, type BacktestSettings, type BacktestSettingsTemplate } from "./backtestTypes.js";
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

type RowDefinition = Omit<BacktestSettingRow, "now" | "group" | "section" | "appliesWhen"> & { fixedValue?: number | string };

const percentOfAccount = "% of the account";

/** Every row's label, unit and note; backtestSettingLayout places them. "fixed." rows are model constants, shown but not editable. */
export const backtestSettingRowDefinitions: readonly RowDefinition[] = [
  { path: "pluto.capitalBudgetPct", label: "Capital budget", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.orderSizePctOfBudget", label: "Order size", unit: "percent", editable: true, note: "% of the capital budget" },
  { path: "pluto.maxTickerPctOfBudget", label: "Max per ticker", unit: "percent", editable: true, note: "% of the capital budget" },
  { path: "pluto.maxSectorPctOfBudget", label: "Max per sector", unit: "percent", editable: true, note: "% of the capital budget; 100 = no cap; a symbol's sector is the one on its ticker" },
  { path: "pluto.maxOpenPositions", label: "Max open positions", unit: "integer", editable: true, note: null },
  { path: "pluto.minCashReservePct", label: "Min cash reserve", unit: "percent", editable: true, note: null },
  { path: "trading.maxOrderPctOfPortfolio", label: "Max order size (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "trading.maxConcentrationPerTickerPct", label: "Max per ticker (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "trading.minCashReservePct", label: "Min cash reserve (order gate)", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.stressRiskBudgetPct", label: "Stress cap per order", unit: "percent", editable: true, note: percentOfAccount },
  { path: "pluto.stressSigmas", label: "Stress move", unit: "number", editable: true, note: "σ (standard deviations of the forecast move)" },
  { path: "kellyFraction", label: "Kelly fraction", unit: "number", editable: true, note: `Pluto sizes with a fixed ${kellyFraction} of full Kelly` },

  { path: "pluto.minGrade", label: "Min grade", unit: "grade", editable: true, note: null },
  { path: "pluto.minEdgeYieldPct", label: "Min Edge Yield", unit: "percent", editable: true, note: null },
  { path: "pluto.maxAbsDelta", label: "Max |delta|", unit: "number", editable: true, note: null },
  { path: "trading.deltaTargetMin", label: "Delta band from", unit: "number", editable: true, note: null },
  { path: "trading.deltaTargetMax", label: "Delta band to", unit: "number", editable: true, note: null },
  { path: "pluto.minDte", label: "Min days to expiry", unit: "days", editable: true, note: null },
  { path: "pluto.maxDte", label: "Max days to expiry", unit: "days", editable: true, note: "data files hold up to 45 days" },
  { path: "pluto.minAnnualizedYieldPct", label: "Min premium yield", unit: "percent", editable: true, note: null },
  { path: "trading.minAnnualizedYieldPct", label: "Min premium yield (Signals)", unit: "percent", editable: true, note: null },
  { path: "pluto.maxSpreadPct", label: "Max spread", unit: "percent", editable: true, note: "% of mid" },
  { path: "pluto.minOpenInterest", label: "Min open interest", unit: "integer", editable: true, note: "the previous day's, as Pluto sees at 10:00" },
  { path: "pluto.minSessionVolume", label: "Min volume", unit: "integer", editable: true, note: "the previous day's full-day volume: today's at 10:00 is not in the history" },
  { path: "pluto.maxContractsVolumeSharePct", label: "Max share of contract volume", unit: "percent", editable: true, note: "of the previous day's volume" },
  { path: "pluto.maxDayMoveMultiple", label: "Max day move", unit: "number", editable: true, note: "× the normal daily move" },
  { path: "fixed.earningsDateKnownCalendarDaysAhead", label: "Earnings dates known 30 days ahead", unit: "days", editable: false, note: "a report's date is seen from 30 calendar days before it: expiries spanning it are skipped, and Pluto's closes before earnings apply, only from then", fixedValue: earningsDateKnownCalendarDaysAhead },

  { path: "trading.spreadCostChargedPct", label: "Spread cost share", unit: "percent", editable: true, note: "how much of the half-spread a fill gives up" },
  { path: "pluto.maxSliceRmseVp", label: "Max slice fit error", unit: "number", editable: true, note: "volatility points: worst surface fit error trusted for the expiry" },
  { path: "pluto.minSlicePointCount", label: "Min slice points", unit: "integer", editable: true, note: "fewest quotes the expiry's fit must rest on" },
  { path: "pluto.maxMidVsSurfaceIvVp", label: "Max mid vs surface IV", unit: "number", editable: true, note: "volatility points: largest gap between the mid's IV and the surface" },
  { path: "pluto.maxIvShiftVp", label: "Max IV shift", unit: "number", editable: true, note: "volatility points: how far an expiry's quotes at a look may sit from the 10:00 surface; 0 at the 10:00 look and on days without intraday quotes" },
  { path: "fixed.forecastWindowDays", label: "Forecast window", unit: "days", editable: false, note: null, fixedValue: 21 },
  { path: "fixed.gradeCutPoints", label: "Grade cut points", unit: "percent", editable: false, note: null, fixedValue: "20 / 10 / 0%" },

  { path: "pluto.windowStartEt", label: "Looks from", unit: "time", editable: false, note: "ET; a look every 30 minutes where the data files hold quotes (10:00 to 15:30)" },
  { path: "pluto.windowEndEt", label: "Looks until", unit: "time", editable: false, note: "ET; never later than 30 minutes before the close (12:30 on a 13:00 day)" },
  { path: "pluto.maxActionsPerSession", label: "Max orders per day", unit: "integer", editable: true, note: "across every symbol and every look of the day, automatic closes included" },
  { path: "pluto.tickerCooldownMinutes", label: "Ticker cooldown after a fill", unit: "integer", editable: true, note: "minutes; 60 = no new open or roll on the ticker at the next look, allowed again at the one after" },
  { path: "pluto.dailyLossBreakerPct", label: "Daily-loss breaker", unit: "percent", editable: true, note: "the account down this much from the previous close at a look: nothing more is done that day" },
  { path: "pluto.spyStressBreakerPct", label: "Market stress", unit: "percent", editable: true, note: "SPY down this much on the day at a look: no new opens at that look; rolls and closes stay" },

  {
    path: "decisionMaker",
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
    label: "Entry with free cash",
    unit: "choice",
    editable: true,
    note: "only with the baseline wheel as decision maker. At every look free round lots get the call with the highest premium yield, free cash the entry with the highest premium yield; everything is held to expiry. With the ladder, a Cash-Secured Put entry's collateral stays within the ladder's Shares at most, and the ladder starts once it is assigned. Whichever ranks higher: at each look the best put (in the entry |delta| range) and the best Covered Call (in the Calls' range, under the Entry call strike rule) are compared by the Ranking, and the look's entry is the winner's kind only",
    choices: [
      { value: "put", label: "Cash-Secured Put" },
      { value: "covered_call", label: "Covered Call (100 shares bought and one call sold on them)" },
      { value: "higher_yield", label: "Put or Covered Call, whichever ranks higher" },
    ],
  },
  { path: "baseline.minAbsDelta", label: "|delta| from", unit: "number", editable: true, note: "from each quote's own implied volatility" },
  { path: "baseline.maxAbsDelta", label: "|delta| to", unit: "number", editable: true, note: null },
  { path: "baseline.minDte", label: "Days to expiry from", unit: "days", editable: true, note: "0 = options expiring on the look's day" },
  { path: "baseline.maxDte", label: "Days to expiry to", unit: "days", editable: true, note: "data files hold up to 45 days" },
  { path: "baseline.maxSpreadPctOfMid", label: "Spread at most", unit: "percent", editable: true, note: "(ask − bid) ÷ mid; contracts quoted wider are left out" },
  {
    path: "baseline.callStrike",
    label: "Calls on held shares",
    unit: "choice",
    editable: true,
    note: "cost: what the cycle's shares cost per share; break-even: what each share held must bring for the cycle to end flat, (the cycle's share purchases − what shares that left it brought in − its premium) ÷ shares held",
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
    label: "New Covered Calls while held shares have no call",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "wait", label: "Wait until every held lot has a call" },
      { value: "buy", label: "Buy: the new Covered Call buys every share its call covers" },
    ],
  },
  { path: "baseline.maxSharesPctOfAccount", label: "Shares at most", unit: "percent", editable: true, note: "of the account value, the shares held at the 10:00 price: new Covered Calls stop there; 100 = no cap" },
  { path: "baseline.minCallYieldPct", label: "Sell only above a premium yield of", unit: "percent", editable: true, note: "annualized; 0 = any. Every entry (a new Covered Call's Call, a Cash-Secured Put entry's Put) and, as set below, the Calls on held shares; the ladder's Puts at any yield" },
  {
    path: "baseline.minCallYieldAppliesTo",
    label: "That premium yield applies to",
    unit: "choice",
    editable: true,
    note: "an entry below it is not opened: no shares bought or Put sold, the cash waits",
    choices: [
      { value: "every_call", label: "Every entry and every Call (held shares included)" },
      { value: "new_covered_calls", label: "Entries only (new Covered Calls and Cash-Secured Put entries; Calls on held shares at any premium)" },
    ],
  },
  {
    path: "baseline.putsWhenNoCall",
    label: "Puts when no call is sold",
    unit: "choice",
    editable: true,
    note: "the ladder sells Puts on a cash reserve once shares are held, with either entry: the more of the reserve committed, the lower the strike",
    choices: [
      { value: "off", label: "None" },
      { value: "reserve_ladder", label: "A ladder on a cash reserve: the more of it committed, the lower the strike" },
    ],
  },
  { path: "baseline.ladderSharesPct", label: "Ladder: shares at most", unit: "percent", editable: true, note: "of the account value the cycle started with: the shares at cost, or a Cash-Secured Put entry's collateral until it is assigned; the rest is the puts' reserve" },
  { path: "baseline.ladderRungs", label: "Ladder: rungs", unit: "integer", editable: true, note: "each put's collateral at most the reserve ÷ rungs" },
  {
    path: "baseline.ladderShock",
    label: "Ladder: stock shock",
    unit: "choice",
    editable: true,
    note: "the fall from the highest price since the cycle started at which the reserve is fully committed",
    choices: [
      { value: "history", label: "The stock's Max drawdown in the years before the cycle, within the range below" },
      { value: "fixed", label: "Fixed, below" },
    ],
  },
  { path: "baseline.ladderShockPct", label: "Ladder: fixed shock", unit: "percent", editable: true, note: null },
  { path: "baseline.ladderShockMinPct", label: "Ladder: shock at least", unit: "percent", editable: true, note: "from history" },
  { path: "baseline.ladderShockMaxPct", label: "Ladder: shock at most", unit: "percent", editable: true, note: "from history" },
  { path: "baseline.ladderShockNoHistoryPct", label: "Ladder: shock with under a year of history", unit: "percent", editable: true, note: "a new listing: fewer than 250 closes in the years of history" },
  { path: "baseline.ladderShockLookbackYears", label: "Ladder: years of history", unit: "integer", editable: true, note: null },
  {
    path: "baseline.ladderTop",
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
    label: "Ladder: put or call on free shares",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "call_first", label: "A put only when no call on the free shares qualifies" },
      { value: "higher_yield", label: "A put when its yield beats the best call's by more than the margin" },
    ],
  },
  { path: "baseline.ladderPutYieldMarginPct", label: "Ladder: put yield above the call's by more than", unit: "percent", editable: true, note: "relative: 25 = a quarter above the call's yield; 0 = any higher" },
  {
    path: "baseline.ladderPutDeltaRange",
    label: "Ladder: |delta| of the Puts",
    unit: "choice",
    editable: true,
    note: "with none, the rung's cap, days to expiry, spread, minimum bid and volume limit bound them",
    choices: [
      { value: "delta_range", label: "The |delta| range above" },
      { value: "none", label: "None: any |delta|" },
    ],
  },
  {
    path: "baseline.dayValueOptions",
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
    label: "|delta| of Calls (held shares and new Covered Calls)",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "entry_range", label: "The same range as the Puts" },
      { value: "own_range", label: "Their own range, below" },
    ],
  },
  { path: "baseline.callMinAbsDelta", label: "Calls' |delta| from", unit: "number", editable: true, note: "with their own range" },
  { path: "baseline.callMaxAbsDelta", label: "Calls' |delta| to", unit: "number", editable: true, note: "with their own range" },
  { path: "baseline.takeProfitPct", label: "Take profit at", unit: "percent", editable: true, note: "of the premium: an option is bought back at a look once buying it back keeps at least this much; 0 = hold to expiry" },
  { path: "baseline.shareStopLossPct", label: "Sell shares below cost by", unit: "percent", editable: true, note: "every share of the stock is sold (any call on them bought back) once the price is this far below what the cycle's shares cost; 0 = never" },
  {
    path: "baseline.earnings",
    label: "Earnings",
    unit: "choice",
    editable: true,
    note: "a report's date is known from 30 calendar days before it",
    choices: [
      { value: "ignore", label: "Sell through earnings" },
      { value: "skip_spanning", label: "No sale whose expiry spans earnings" },
    ],
  },
  { path: "baseline.maxAccountPctPerStock", label: "Max per stock", unit: "percent", editable: true, note: "% of the account for new sales: puts at their strike, shares at their cost, net of premium; ladder Puts are sized by the rung instead" },
  {
    path: "baseline.looks",
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
  { path: "baseline.minVolatilityEdgePoints", label: "IV above the forecast by", unit: "number", editable: true, note: "volatility points (5: 55% against a 50% forecast); may be negative" },
  {
    path: "baseline.entryExtensionFilter",
    label: "Skip entries on a stretched stock",
    unit: "choice",
    editable: true,
    note: "extension z = (previous close ÷ 200-day average − 1) ÷ 63-session volatility. MRNA on 2021-09-20: 100% above its average with 81% volatility, z 1.24. Cash-Secured Put and Covered Call entries only: Calls on held shares and ladder Puts are never skipped",
    choices: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  { path: "baseline.entryMaxExtensionZ", label: "Extension z limit", unit: "number", editable: true, note: "no new entry while z is at or above this; 1: the stock is more than a year's typical move above its 200-day average" },
  {
    path: "baseline.entryIvRankFilter",
    label: "Skip entries at a high IV Rank",
    unit: "choice",
    editable: true,
    note: "IV Rank = (IV − the year's lowest) ÷ (the year's highest − lowest) × 100, over the last 252 days with an IV, as on Price Performance. Entries only, like the filter above",
    choices: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  { path: "baseline.entryMaxIvRank", label: "IV Rank limit", unit: "number", editable: true, note: "no new entry while IV Rank is at or above this, 0–100; 80: IV in the top fifth of its year's range" },
  {
    path: "baseline.ranking",
    label: "Pick by",
    unit: "choice",
    editable: true,
    note: "Calls and Covered Calls only: ladder Puts always go by premium yield. Edge Yield: the Signals model's expected P&L after costs, as a yearly rate on the exposure",
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
    label: "Expiry",
    unit: "choice",
    editable: true,
    note: "Calls and Covered Calls only: ladder Puts take any expiry in the range, by premium yield",
    choices: [
      { value: "any_in_range", label: "Any in the range, by the ranking" },
      { value: "nearest_qualifying", label: "The nearest that has a qualifying contract" },
    ],
  },
  {
    path: "baseline.coverage",
    label: "When the volume limit binds",
    unit: "choice",
    editable: true,
    note: null,
    choices: [
      { value: "best_contract", label: "Only the best contract; the rest waits" },
      { value: "fill_down_ranking", label: "The rest goes to the next candidates in order" },
    ],
  },
  {
    path: "baseline.knifeGuard",
    label: "Falling-knife guard",
    unit: "choice",
    editable: true,
    note: "while the stock is at least 25% below its 252-session closing high, new buying (Cash-Secured Put and Covered Call entries, ladder Puts) is scaled by K = minimum + (1 − minimum) × min(1, q ÷ 0.5), q = beta × SPY's fall from its own high ÷ the stock's fall: the market's share of the fall. PTON on 2021-11-08: 67% below its high with SPY at its high, q 0.00, so no new buying at minimum 0; it fell another 53%. Market's share + IV: halved again while implied volatility is at its 21-session peak. Calls on held shares are never scaled",
    choices: [
      { value: "off", label: "Off" },
      { value: "market_share", label: "Market's share" },
      { value: "market_share_and_iv", label: "Market's share + IV" },
    ],
  },
  { path: "baseline.knifeGuardMinScale", label: "Guard: scale when the stock falls alone", unit: "number", editable: true, note: "K when the market explains none of the fall (q = 0): 0 stops new buying, 0.5 halves it; K reaches 1 once the market explains half the fall" },
  {
    path: "baseline.kellySizing",
    label: "Kelly sizing",
    unit: "choice",
    editable: true,
    note: "dynamic: a multiplier m at each look scales the entries' room in the shares' budget and each ladder Put's collateral (a rung's strike cap stays where today's rung puts it); what the entries leave unspent joins the ladder's reserve. Calls on held shares are never scaled",
    choices: [
      { value: "disabled", label: "Disabled (today's sizes)" },
      { value: "dynamic", label: "Dynamic" },
    ],
  },
  {
    path: "baseline.kellyMultiplierRule",
    label: "Kelly: multiplier from",
    unit: "choice",
    editable: true,
    note: "extension z: less near tops, more near bottoms; z = (previous close ÷ 200-day average − 1) ÷ 63-session volatility, as in the Entry filters (fewer than 200 closes: m = 1). Constant: the same m at every look, a control",
    choices: [
      { value: "extension", label: "Extension z" },
      { value: "constant", label: "Constant (a control)" },
    ],
  },
  { path: "baseline.kellyTopFromZ", label: "Kelly: cut from extension z", unit: "number", editable: true, note: "m = 1 up to this z, falling linearly to 0 at the next row's z. MRNA on 2021-09-20, z 1.24: m 0.26 with 0.5 → 1.5, 0.76 with 1.0 → 2.0" },
  { path: "baseline.kellyTopToZ", label: "Kelly: zero at extension z", unit: "number", editable: true, note: "no new buying from this z up" },
  { path: "baseline.kellyMaxMultiplier", label: "Kelly: most at bottoms", unit: "number", editable: true, note: "m rises linearly from 1 at z 0 to this at z −1 or below; 1 = no boost. SPY on 2020-03-23, z −0.49: m 1.49 with 2; always within the cash and what is left of the reserve" },
  {
    path: "baseline.kellySpyMove",
    label: "Kelly: SPY's 21-session move",
    unit: "choice",
    editable: true,
    note: "on: m × (1 − 0.5 × clamp((move − 2%) ÷ 4%, 0, 1)), full up to +2%, half from +6%",
    choices: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  {
    path: "baseline.kellyAtTops",
    label: "Kelly: the entry room held back at a top",
    unit: "choice",
    editable: true,
    note: "at z at or above the cut: price $100, shares' budget $50,000 and m 0.4 buy $20,000 of shares; the other $30,000 waits, or secures Puts at a strike ≤ 100 × (1 − 0.30 × 0.6) = $82 (any |delta|, by premium yield, as ladder Puts)",
    choices: [
      { value: "wait_in_cash", label: "Waits in cash" },
      { value: "deeper_puts", label: "Deeper Puts" },
    ],
  },
  { path: "baseline.kellyConstantMultiplier", label: "Kelly: constant multiplier", unit: "number", editable: true, note: "m at every look with the constant rule" },
];

const ladderOn: BacktestSettingCondition = { path: "baseline.putsWhenNoCall", oneOf: ["reserve_ladder"] };
const onlyWithLadder: BacktestSettingApplicability = { allOf: [ladderOn], explanation: "Applies only with Puts when no call is sold set to the ladder." };
const kellyDynamic: BacktestSettingApplicability = { allOf: [ladderOn, { path: "baseline.kellySizing", oneOf: ["dynamic"] }], explanation: "Applies only with Kelly sizing dynamic." };
const kellyFromExtension: BacktestSettingApplicability = { allOf: [ladderOn, { path: "baseline.kellySizing", oneOf: ["dynamic"] }, { path: "baseline.kellyMultiplierRule", oneOf: ["extension"] }], explanation: "Applies only with Kelly sizing dynamic from extension z." };
const onlyWithHistoryShock: BacktestSettingApplicability ={ allOf: [ladderOn, { path: "baseline.ladderShock", oneOf: ["history"] }], explanation: "Applies only with the ladder's Stock shock set to the stock's Max drawdown." };

/**
 * The groups in order, each row's place in them, and when a Baseline wheel row is read at all (as the engine reads them:
 * backtestBaselineLook, baselineSaleSteps, backtestBaselineLadder). The New session table and the lab's settings show this.
 */
export const backtestSettingLayout: readonly { group: BacktestSettingGroup; section: BacktestSettingSection; rows: readonly { path: string; appliesWhen?: BacktestSettingApplicability }[] }[] = [
  {
    group: "How the session runs",
    section: "baseline_wheel",
    rows: [
      { path: "decisionMaker" },
      { path: "baseline.looks", appliesWhen: { allOf: [{ path: "decisionMaker", oneOf: ["baseline"] }], explanation: "Applies only with the Baseline wheel as decision maker." } },
      { path: "pluto.windowStartEt" },
      { path: "pluto.windowEndEt" },
      { path: "baseline.entry" },
      { path: "baseline.dayValueOptions" },
      { path: "baseline.earnings" },
      { path: "fixed.earningsDateKnownCalendarDaysAhead" },
      { path: "trading.spreadCostChargedPct" },
    ],
  },
  {
    group: "Put ladder",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.putsWhenNoCall" },
      { path: "baseline.ladderSharesPct", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderRungs", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderShock", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderShockPct", appliesWhen: { allOf: [ladderOn, { path: "baseline.ladderShock", oneOf: ["fixed"] }], explanation: "Applies only with the ladder's Stock shock set to Fixed." } },
      { path: "baseline.ladderShockMinPct", appliesWhen: onlyWithHistoryShock },
      { path: "baseline.ladderShockMaxPct", appliesWhen: onlyWithHistoryShock },
      { path: "baseline.ladderShockLookbackYears", appliesWhen: onlyWithHistoryShock },
      { path: "baseline.ladderShockNoHistoryPct", appliesWhen: onlyWithHistoryShock },
      { path: "baseline.ladderTop", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderPace", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderPutVersusCall", appliesWhen: onlyWithLadder },
      { path: "baseline.ladderPutYieldMarginPct", appliesWhen: { allOf: [ladderOn, { path: "baseline.ladderPutVersusCall", oneOf: ["higher_yield"] }], explanation: "Applies only with Put or call on free shares set to the higher yield." } },
      { path: "baseline.ladderPutDeltaRange", appliesWhen: onlyWithLadder },
    ],
  },
  {
    group: "Calls and Covered Calls",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.callStrike" },
      { path: "baseline.entryCallStrike" },
      { path: "baseline.entryWhenSharesUncovered" },
      { path: "baseline.callDeltaRange" },
      { path: "baseline.callMinAbsDelta", appliesWhen: { allOf: [{ path: "baseline.callDeltaRange", oneOf: ["own_range"] }], explanation: "Applies only with |delta| of Calls set to their own range." } },
      { path: "baseline.callMaxAbsDelta", appliesWhen: { allOf: [{ path: "baseline.callDeltaRange", oneOf: ["own_range"] }], explanation: "Applies only with |delta| of Calls set to their own range." } },
      { path: "baseline.minCallYieldPct" },
      { path: "baseline.minCallYieldAppliesTo", appliesWhen: { allOf: [{ path: "baseline.minCallYieldPct", above: 0 }], explanation: "Applies only with a minimum premium yield above 0." } },
      { path: "baseline.maxAccountPctPerStock" },
      { path: "baseline.maxSharesPctOfAccount", appliesWhen: { allOf: [{ path: "baseline.putsWhenNoCall", noneOf: ["reserve_ladder"] }], explanation: "Not used with the ladder: the ladder's Shares at most replaces it." } },
    ],
  },
  {
    group: "Contract choice",
    section: "baseline_wheel",
    rows: [
      ...["baseline.minAbsDelta", "baseline.maxAbsDelta"].map((path) => ({
        path,
        appliesWhen: { anyOf: [{ path: "baseline.callDeltaRange", oneOf: ["entry_range"] }, { path: "baseline.entry", oneOf: ["put", "higher_yield"] }, { path: "baseline.ladderPutDeltaRange", oneOf: ["delta_range"] }], explanation: "Applies only when Calls or Puts use this range: Calls with the same range as the Puts, Cash-Secured Put entries, or ladder Puts with the |delta| range." },
      })),
      { path: "baseline.minDte" },
      { path: "baseline.maxDte" },
      { path: "baseline.maxSpreadPctOfMid" },
      { path: "baseline.ranking" },
      { path: "baseline.expiryChoice" },
      { path: "baseline.coverage" },
      { path: "baseline.volatilityEdgeFilter" },
      { path: "baseline.minVolatilityEdgePoints", appliesWhen: { allOf: [{ path: "baseline.volatilityEdgeFilter", noneOf: ["off"] }], explanation: "Applies only with Sell only above the forecast on." } },
    ],
  },
  {
    group: "Entry filters",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.entryExtensionFilter" },
      { path: "baseline.entryMaxExtensionZ", appliesWhen: { allOf: [{ path: "baseline.entryExtensionFilter", oneOf: ["on"] }], explanation: "Applies only with Skip entries on a stretched stock on." } },
      { path: "baseline.entryIvRankFilter" },
      { path: "baseline.entryMaxIvRank", appliesWhen: { allOf: [{ path: "baseline.entryIvRankFilter", oneOf: ["on"] }], explanation: "Applies only with Skip entries at a high IV Rank on." } },
    ],
  },
  {
    group: "Falling-knife guard",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.knifeGuard", appliesWhen: onlyWithLadder },
      { path: "baseline.knifeGuardMinScale", appliesWhen: { allOf: [ladderOn, { path: "baseline.knifeGuard", noneOf: ["off"] }], explanation: "Applies only with the Falling-knife guard on." } },
    ],
  },
  {
    group: "Kelly sizing",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.kellySizing", appliesWhen: onlyWithLadder },
      { path: "baseline.kellyMultiplierRule", appliesWhen: kellyDynamic },
      { path: "baseline.kellyTopFromZ", appliesWhen: kellyFromExtension },
      { path: "baseline.kellyTopToZ", appliesWhen: kellyFromExtension },
      { path: "baseline.kellyMaxMultiplier", appliesWhen: kellyFromExtension },
      { path: "baseline.kellySpyMove", appliesWhen: kellyFromExtension },
      { path: "baseline.kellyAtTops", appliesWhen: kellyFromExtension },
      { path: "baseline.kellyConstantMultiplier", appliesWhen: { allOf: [ladderOn, { path: "baseline.kellySizing", oneOf: ["dynamic"] }, { path: "baseline.kellyMultiplierRule", oneOf: ["constant"] }], explanation: "Applies only with Kelly sizing dynamic on a constant." } },
    ],
  },
  { group: "Exits", section: "baseline_wheel", rows: [{ path: "baseline.takeProfitPct" }, { path: "baseline.shareStopLossPct" }] },
  {
    group: "Capital and sizing",
    section: "pluto_rules",
    rows: ["pluto.capitalBudgetPct", "pluto.orderSizePctOfBudget", "pluto.maxTickerPctOfBudget", "pluto.maxSectorPctOfBudget", "pluto.maxOpenPositions", "pluto.minCashReservePct", "trading.maxOrderPctOfPortfolio", "trading.maxConcentrationPerTickerPct", "trading.minCashReservePct", "pluto.stressRiskBudgetPct", "pluto.stressSigmas", "kellyFraction"].map((path) => ({ path })),
  },
  {
    group: "Candidate quality",
    section: "pluto_rules",
    rows: ["pluto.minGrade", "pluto.minEdgeYieldPct", "pluto.maxAbsDelta", "trading.deltaTargetMin", "trading.deltaTargetMax", "pluto.minDte", "pluto.maxDte", "pluto.minAnnualizedYieldPct", "trading.minAnnualizedYieldPct", "pluto.maxSpreadPct", "pluto.minOpenInterest", "pluto.minSessionVolume", "pluto.maxContractsVolumeSharePct", "pluto.maxDayMoveMultiple"].map((path) => ({ path })),
  },
  { group: "Model", section: "pluto_rules", rows: ["pluto.maxSliceRmseVp", "pluto.minSlicePointCount", "pluto.maxMidVsSurfaceIvVp", "pluto.maxIvShiftVp", "fixed.forecastWindowDays", "fixed.gradeCutPoints"].map((path) => ({ path })) },
  { group: "System checks", section: "pluto_rules", rows: ["pluto.maxActionsPerSession", "pluto.tickerCooldownMinutes", "pluto.dailyLossBreakerPct", "pluto.spyStressBreakerPct"].map((path) => ({ path })) },
  { group: "Rules' choices", section: "pluto_rules", rows: ["policy.roll", "policy.buyback", "policy.sharesInProfit", "policy.eventClose", "policy.afterBlockedChoice"].map((path) => ({ path })) },
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

const tickerBaselinePaths = new Set(backtestTickerBaselineKeys.map((key) => `baseline.${key}`));
/** A baseline value that can differ by ticker in a session of per-ticker pots. */
const isTickerBaselinePath = (path: string) => tickerBaselinePaths.has(path);

const rowDefinitionByPath = new Map(backtestSettingRowDefinitions.map((row) => [row.path, row]));
const placedPaths = backtestSettingLayout.flatMap((group) => group.rows.map((row) => row.path));
const misplacedPaths = [...backtestSettingRowDefinitions.map((row) => row.path).filter((path) => placedPaths.filter((placed) => placed === path).length !== 1), ...placedPaths.filter((path) => !rowDefinitionByPath.has(path))];
if (misplacedPaths.length > 0) throw new Error(`backtestSettingLayout must place every setting row once: ${misplacedPaths.join(", ")}`);

export function buildBacktestSettingRows(settings: BacktestSettings, decisionMakers: { claudeCliAvailable: boolean }): BacktestSettingRow[] {
  const placed = backtestSettingLayout.flatMap(({ group, section, rows }) => rows.map(({ path, appliesWhen }) => ({ definition: rowDefinitionByPath.get(path)!, group, section, appliesWhen })));
  return placed.map(({ definition: { fixedValue, ...row }, group, section, appliesWhen }) => ({
    group,
    section,
    ...(appliesWhen ? { appliesWhen } : {}),
    ...row,
    ...(isTickerBaselinePath(row.path) ? { perTicker: true as const } : {}),
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
