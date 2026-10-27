import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadPlutoSettings } from "../pluto/settingsStore.js";
import { kellyFraction } from "../pluto/postModelGates.js";
import { mapTradingSettingsRow } from "../lib/tradingSettingsStore.js";
import { backtestTickerBaselineKeys, defaultBacktestBaselineSettings, defaultBacktestModelSettings, defaultBacktestPolicySettings, defaultBacktestSteadyStakeSettings, defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, type BacktestSettingApplicability, type BacktestSettingCondition, type BacktestSettingGroup, type BacktestSettingRow, type BacktestSettingSection, type BacktestSettings, type BacktestSettingsTemplate } from "./backtestTypes.js";
import { earningsDateKnownCalendarDaysAhead } from "./engine/backtestTickerInputs.js";

// The New session settings table (docs/backtesting/): the values a session snapshots and may change for itself only. The
// policy, model, Pluto and Kelly values are still snapshotted (the retired rules sessions read them); no row shows them.

/** Pluto's settings, the trading settings without the commission estimator (the flat commission applies) and the Kelly fraction. */
export async function loadCurrentBacktestSettings(connection: Knex = db): Promise<BacktestSettings> {
  const [pluto, tradingRow] = await Promise.all([loadPlutoSettings(connection), connection("trading_settings").first()]);
  if (!tradingRow) throw new Error("No trading_settings row found.");
  const trading = mapTradingSettingsRow(tradingRow);
  return { pluto, trading, kellyFraction, policy: { ...defaultBacktestPolicySettings }, decisionMaker: "baseline", model: { ...defaultBacktestModelSettings, spreadCostChargedPct: trading.spreadCostChargedPct }, baseline: { ...defaultBacktestBaselineSettings }, steadyStake: { ...defaultBacktestSteadyStakeSettings }, volFarmer: { ...defaultBacktestVolFarmerSettings }, volFarmerV2: { ...defaultBacktestVolFarmerV2Settings } };
}

type RowDefinition = Omit<BacktestSettingRow, "now" | "group" | "section" | "appliesWhen"> & { fixedValue?: number | string };

const percentOfAccount = "% of the account";

/** Every row's label, unit and note; backtestSettingLayout places them. "fixed." rows are model constants, shown but not editable. */
export const backtestSettingRowDefinitions: readonly RowDefinition[] = [
  { path: "fixed.earningsDateKnownCalendarDaysAhead", label: "Earnings dates known 30 days ahead", unit: "days", editable: false, note: "a report's date is seen from 30 calendar days before it: expiries spanning it are skipped only from then", fixedValue: earningsDateKnownCalendarDaysAhead },

  { path: "trading.spreadCostChargedPct", label: "Spread cost share", unit: "percent", editable: true, note: "how much of the half-spread a fill gives up" },

  { path: "pluto.windowStartEt", label: "Looks from", unit: "time", editable: false, note: "ET; a look every 30 minutes where the data files hold quotes (10:00 to 15:30)" },
  { path: "pluto.windowEndEt", label: "Looks until", unit: "time", editable: false, note: "ET; never later than 30 minutes before the close (12:30 on a 13:00 day)" },

  {
    path: "decisionMaker",
    label: "Decision maker",
    unit: "choice",
    editable: true,
    note: "who decides the session's trades. The Steady Stake, the Vol Farmer and Vol Farmer v2: only their own group's values, at the 10:00 look (Vol Farmer v2 also reads the Vol Farmer's Calls' |delta| and spread)",
    choices: [
      { value: "baseline", label: "Baseline wheel (no Pluto rules, no Signals)" },
      { value: "steady_stake", label: "Steady Stake (a steady share stake, Calls and Puts on expiry days)" },
      { value: "vol_farmer", label: "Vol Farmer (shares, a Covered Call and a long Put hedge)" },
      { value: "vol_farmer_v2", label: "Vol Farmer v2 (two Covered Calls at different levels, a LEAPS Call; research)" },
    ],
  },
  { path: "volFarmer.callMinAbsDelta", label: "Calls' |delta| from", unit: "number", editable: true, note: "the Call sold is the one with the highest premium yield (annualized) inside the |delta| and days-to-expiry ranges whose strike passes the hedge rule; |delta| from each quote's own implied volatility" },
  { path: "volFarmer.callMaxAbsDelta", label: "Calls' |delta| to", unit: "number", editable: true, note: null },
  { path: "volFarmer.callMinDte", label: "Calls' days to expiry from", unit: "days", editable: true, note: "the data files' Calls are read up to 45 days out" },
  { path: "volFarmer.callMaxDte", label: "Calls' days to expiry to", unit: "days", editable: true, note: null },
  {
    path: "volFarmer.callExpiry",
    label: "Calls tried",
    unit: "choice",
    editable: true,
    note: "in the days-to-expiry range: every expiry from the Calls' days to expiry from/to. The next expiry: only the first listed expiry after today (the range is not read); a day none of its Calls passes the hedge rule sells no Call, and the next 10:00 look tries again",
    choices: [
      { value: "in_range", label: "Every expiry in the days-to-expiry range" },
      { value: "next", label: "Only the next expiry" },
    ],
  },
  { path: "volFarmer.putMinDte", label: "Puts' days to expiry from", unit: "days", editable: true, note: "the Put also expires on or after the Call's expiry: 0 = from the Call's expiry" },
  { path: "volFarmer.putMaxDte", label: "Puts' days to expiry to", unit: "days", editable: true, note: null },
  { path: "volFarmer.putMaxStrikeAbovePricePct", label: "Puts' strike up to", unit: "percent", editable: true, note: "% above the stock price; 0 = at or below the price, −5 = at least 5% below it (−20 to 10)" },
  { path: "volFarmer.protectionFallPct", label: "Protection measured on a fall of", unit: "percent", editable: true, note: "% of the stock price: of the Puts that pass the hedge rule, the one whose gain after its cost offsets the most of the shares' loss on this fall by the Call's expiry" },
  { path: "volFarmer.maxSpreadPctOfMid", label: "Spread at most", unit: "percent", editable: true, note: "(ask − bid) ÷ mid; a bid of at least $0.05, and a Call within 20% of the contract's previous-session volume, as for the ladder" },
  { path: "volFarmer.putCashReservePct", label: "Cash kept for later Puts", unit: "percent", editable: true, note: "% of the free cash a cycle's first purchase does not spend: the later Puts are paid from it and the Calls' premiums (0 to 50)" },
  {
    path: "volFarmer.crossing",
    label: "When the stock reaches the Call's strike",
    unit: "choice",
    editable: true,
    note: "unwind: the shares sold at the strike, the Call bought back and the Put sold at their Black-Scholes values, there and then. Hold to expiry: nothing is traded; a Call in the money at its expiry is assigned (its shares go at the strike) and the Put is sold at the next 10:00 look, or settles with the Call. Unwind if the cycle nets a gain: the cycle's realized P&L (shares, Calls and Puts, commissions included) plus closing everything at the unwind's prices; above 0 it unwinds, else everything is held and the same sum, at each later look's prices (the fill rule), is checked at every look to the Call's expiry, unwinding at the first above 0",
    choices: [
      { value: "unwind", label: "Unwind the position at the crossing" },
      { value: "hold_to_expiry", label: "Hold to the Call's expiry (assignment)" },
      { value: "unwind_if_net_positive", label: "Unwind if the cycle nets a gain, else check at every look" },
    ],
  },
  {
    path: "volFarmer.putExpiry",
    label: "Puts tried",
    unit: "choice",
    editable: true,
    note: "in the days-to-expiry range: every expiry from the Puts' days to expiry from/to, on or after the Call's. With the Call: only Puts expiring with the Call, so each Put settles at the Call's expiry and its gain or loss counts in the hedge rule from then",
    choices: [
      { value: "in_range", label: "Every expiry in the days-to-expiry range" },
      { value: "with_the_call", label: "Only the Call's expiry" },
    ],
  },
  {
    path: "volFarmer.hedgeRuleCallPremiums",
    label: "Call P&L in the hedge rule",
    unit: "choice",
    editable: true,
    note: "included: the cycle's realized Call P&L (premiums kept, buybacks paid) is added to the Puts' realized P&L in the hedge rule, so the Calls already sold pay for the Puts bought since",
    choices: [
      { value: "excluded", label: "Left out" },
      { value: "included", label: "Included" },
    ],
  },
  { path: "volFarmer.minPutProtectionPct", label: "Least protection of a new Put", unit: "percent", editable: true, note: "% of the fall the protection is measured on: a Call qualifies only with a Put that passes the hedge rule and offers at least this much; 0 = any (0 to 100)" },
  {
    path: "volFarmer.hedgeWithoutCall",
    label: "Shares with no Call that qualifies",
    unit: "choice",
    editable: true,
    note: "a Put: shares held with no Put buy the Put at the strike cap (the highest strike up to the Puts' strike limit) of the nearest expiry 7 or more days out, the Calls tried again at the next 10:00 look with it. The Put choice's Put: the one the Put choice below takes among the Puts tried, with no hedge rule (there is no Call) and protection measured to the next listed Call expiry; above all once the Put held has expired",
    choices: [
      { value: "none", label: "Left unhedged" },
      { value: "put", label: "A Put" },
      { value: "cheapest_per_year", label: "The Put choice's Put" },
    ],
  },
  {
    path: "volFarmer.putChoice",
    label: "Put chosen",
    unit: "choice",
    editable: true,
    note: "of the Puts that pass the hedge rule and offer at least the least protection: the most protection, or the cheapest per year: (time value × 100 + one contract's commission) ÷ (stock price × 100) ÷ (days to expiry ÷ 365), a tie going to the more protection",
    choices: [
      { value: "most_protection", label: "The most protection" },
      { value: "cheapest_per_year", label: "The cheapest per year" },
    ],
  },
  { path: "volFarmer.maxPutCostPctOfCallPremium", label: "A new Put costs at most", unit: "percent", editable: true, note: "% of the Call's premium (its fill): of the Puts that pass, the most protection within this budget; 100 = a zero-cost collar, 0 = no limit (0 to 500)" },
  {
    path: "volFarmer.putRoll",
    label: "Puts held and no Call passes",
    unit: "choice",
    editable: true,
    note: "roll: the Puts held are sold when what they realize, counted in the hedge rule, lets a Call pass with a new Put; the Call and the new Put are then traded at the same look. Wait: no trade until a Call passes with the Puts held or they expire",
    choices: [
      { value: "none", label: "Wait" },
      { value: "when_no_call", label: "Roll the Put when that lets a Call pass" },
    ],
  },
  {
    path: "volFarmer.hedgeAfterExpiry",
    label: "Put in profit after a Call expires",
    unit: "choice",
    editable: true,
    note: "sell it: after a Call expired below its strike, Puts held whose sale would realize a gain (their fill less what they cost, commissions included) are sold, but only with a new Call and a new Put that pass the hedge rule with that gain counted; otherwise they are kept and the next Call is sold with them. Keep them: the next Call is sold with the Puts held",
    choices: [
      { value: "keep", label: "Keep it" },
      { value: "sell_if_in_profit", label: "Sell it with a new Call and Put" },
    ],
  },
  {
    path: "volFarmer.afterAssignment",
    label: "Shares called away, Put held",
    unit: "choice",
    editable: true,
    note: "end the cycle: the Put is sold at the next 10:00 look. Buy back when under water: at the next 10:00 look the cycle's realized share and Put P&L plus the Put's sale (Calls left out) is worked out; above 0 the Put is sold and the cycle ends, else the shares called away are bought back at the 10:00 price (as many as the free cash pays for), the Put is kept and a Call that passes the hedge rule is sold on them",
    choices: [
      { value: "end", label: "End the cycle" },
      { value: "continue_if_under_water", label: "Buy the shares back when under water" },
    ],
  },
  {
    path: "volFarmer.hedgeRuleStockPnl",
    label: "Realized share P&L in the hedge rule",
    unit: "choice",
    editable: true,
    note: "included: the cycle's realized share P&L (shares called away or sold) is added to the Puts' realized P&L in the hedge rule, so the gain on shares called away counts for the Calls on the shares bought back",
    choices: [
      { value: "excluded", label: "Left out" },
      { value: "included", label: "Included" },
    ],
  },
  {
    path: "volFarmer.putCashIn",
    label: "Put in profit and no Call sold",
    unit: "choice",
    editable: true,
    note: "cash it in: at a 10:00 look that sells no Call (after the rolls above are tried), each Put held whose sale would realize a gain (its fill less what it cost, commissions included) is sold, so the gain counts in the hedge rule's realized Put P&L from then and lowers the price a Call must pass at; the lots left without a Put get the Put of \"Shares with no Call that qualifies\" at the same look. Keep it: the Put is held until a Call is sold with it, a roll sells it or it expires",
    choices: [
      { value: "none", label: "Keep it" },
      { value: "when_no_call", label: "Cash it in" },
    ],
  },
  { path: "volFarmer.cashInPutMinProtectionPct", label: "Least protection of the Put after a cash-in", unit: "percent", editable: true, note: "% of the fall the protection is measured on: the Put bought for the lots a cash-in left without one (with \"The Put choice's Put\") offers at least this much; 0 = any (0 to 100)" },
  {
    path: "volFarmer.hedge",
    label: "Hedge",
    unit: "choice",
    editable: true,
    note: "none (research): no Put is ever bought; a Call passes the hedge rule on the shares alone, (strike − what the shares cost) + the cycle's realized P&L the rule counts ≥ 0, and a new cycle's lots = free cash × (1 − the cash kept ÷ 100) ÷ (100 × price + stock commission). The Put settings above are not read",
    choices: [
      { value: "put", label: "A long Put" },
      { value: "none", label: "None" },
    ],
  },
  { path: "volFarmerV2.putsStartCallYieldPct", label: "Puts start under", unit: "percent", editable: true, note: "% a year: Puts start while the first position's Calls yield under this. At each 10:00 look where the first position needs a new Call (none open), the best Call the first position can sell (at or above its break-even, the Vol Farmer's |delta| range, the next expiry) is measured by its premium yield; under this (no Call: 0%), Puts are sold with the other half of the pot, beside the Calls" },
  { path: "volFarmerV2.putMaxAbsDelta", label: "Put |delta|", unit: "number", editable: true, note: "the Puts' highest |delta|: the Put sold is the one with the highest premium yield of the next expiry up to this |delta|, struck far enough below the first position's break-even (next row); as many contracts as half the pot secures (strike × 100 each)" },
  { path: "volFarmerV2.stepBelowFirstBreakEvenPct", label: "Step", unit: "percent", editable: true, note: "% at least below the first break-even: a Put's strike ≤ the first position's break-even × (1 − this ÷ 100), so the second position opens lower than the first (0 to 90); the Step with the Fixed Step rule, and the implied-move rule's Step when no IV is found" },
  {
    path: "volFarmerV2.stepRule",
    label: "Step rule",
    unit: "choice",
    editable: true,
    note: "Fixed: the Step above. One-month implied move: Step = IV × √(21 ÷ 252), IV being IBKR's 30-day implied volatility of the latest daily bar before the day (within 10 sessions; none: the fixed Step), taken at each Put sale. IV 30% gives a Step of 8.7%",
    choices: [
      { value: "fixed", label: "Fixed" },
      { value: "implied_move_at_put_sale", label: "One-month implied move, at each Put sale" },
    ],
  },
  { path: "volFarmerV2.leapsMinDte", label: "LEAPS expiry from", unit: "days", editable: true, note: "when the second position finds no Call at or above its break-even, the free cash (up to the LEAPS cap) buys a LEAPS Call of the first listed expiry at least this many days out (30 to 1000), sold when the second position is called away" },
  { path: "volFarmerV2.leapsAbsDelta", label: "LEAPS |delta|", unit: "number", editable: true, note: "of that expiry's Calls, the one whose |delta| (from its own implied volatility) is nearest this" },
  { path: "volFarmerV2.leapsMaxAccountPct", label: "LEAPS cap", unit: "percent", editable: true, note: "% of the account's value at the 10:00 look (positions marked) a LEAPS purchase spends at most, never more than the free cash. 0: no cap, all the free cash (0 to 100)" },
  { path: "steadyStake.stakePct", label: "Stake", unit: "percent", editable: true, note: "% of the pot: the share of each ticker's pot held in its shares. At the 10:00 look, whole shares are bought or sold back to it when their value drifts out of the band" },
  { path: "steadyStake.rebalanceBandPct", label: "Rebalancing band", unit: "percent", editable: true, note: "% of the pot: shares are traded back to the stake once their value is off it by more than this. A $100,000 pot at 80% ± 5 holds shares worth $75,000 to $85,000" },
  { path: "steadyStake.callCoveragePct", label: "Calls on expiry days", unit: "percent", editable: true, note: "% of the free round lots: at 10:00 on a day the ticker has an expiry, Calls expiring at that day's close, the contract nearest the Calls' |delta| first, then the next nearest while the volume limit leaves lots uncovered. 0 = no Calls" },
  { path: "steadyStake.callAbsDelta", label: "Calls' |delta|", unit: "number", editable: true, note: "the target; from each quote's own implied volatility" },
  { path: "steadyStake.putCashPct", label: "Puts on expiry days", unit: "percent", editable: true, note: "% of the pot's free cash (the pot less the shares and any open Puts): Puts expiring at that day's close, nearest the Puts' |delta| first. 0 = no Puts" },
  { path: "steadyStake.putAbsDelta", label: "Puts' |delta|", unit: "number", editable: true, note: "the target; from each quote's own implied volatility" },
  { path: "steadyStake.deltaTolerance", label: "|delta| tolerance", unit: "number", editable: true, note: "how far a contract's |delta| may be from its target; when no contract is that close, nothing is sold that day" },
  { path: "steadyStake.maxSpreadPctOfMid", label: "Spread at most", unit: "percent", editable: true, note: "(ask − bid) ÷ mid; a bid of at least $0.05 and at most 20% of the contract's previous-session volume, as for the ladder" },
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
  { path: "baseline.hedgePutTenorDays", label: "Hedge: Puts' days to expiry", unit: "days", editable: true, note: "long Puts bought on the shares an entry brings in (a Covered Call entry's, a Cash-Secured Put entry's once assigned), or on the whole position; 0 = no hedge" },
  {
    path: "baseline.hedgePutCovers",
    label: "Hedge: covers",
    unit: "choice",
    editable: true,
    note: "the whole position: the shares held plus the shares the open short Puts (the entry's and the ladder's rungs) would bring, bought as soon as it grows and kept until the roll whatever the shares do",
    choices: [
      { value: "entries", label: "The shares each entry brings in" },
      { value: "position", label: "The whole position: shares and short Puts" },
    ],
  },
  {
    path: "baseline.hedgePutExpiry",
    label: "Hedge: expiry",
    unit: "choice",
    editable: true,
    note: "listed expiries thin out beyond two months: on 2021-11-01 NFLX listed 81, 109, 137, 228, 319 and 445 days out",
    choices: [
      { value: "nearest", label: "The listed expiry nearest the days" },
      { value: "first_at_or_after", label: "The first listed expiry at or after the days" },
    ],
  },
  {
    path: "baseline.hedgePutStrikeFrom",
    label: "Hedge: strike from",
    unit: "choice",
    editable: true,
    note: "the two differ only after a Cash-Secured Put is assigned below its strike; a replacement near expiry is always set from the stock price",
    choices: [
      { value: "stock_price", label: "The stock price at the purchase" },
      { value: "price_paid", label: "The price paid for the shares" },
    ],
  },
  {
    path: "baseline.hedgePutStrikeBy",
    label: "Hedge: strike chosen by",
    unit: "choice",
    editable: true,
    note: "by delta, a volatile stock's Put is struck further below the price: the Put's own |delta|, from the IV of its mid on the forward",
    choices: [
      { value: "price", label: "A share below a price" },
      { value: "delta", label: "The Put's |delta|" },
    ],
  },
  { path: "baseline.hedgePutBelowPricePct", label: "Hedge: strike below that price by", unit: "percent", editable: true, note: "0 = at the money; the listed strike nearest it" },
  { path: "baseline.hedgePutAbsDelta", label: "Hedge: Put |delta|", unit: "number", editable: true, note: "the listed Put whose |delta| is nearest it; 0.25 is about 10% below SPY's price over a year, about 30% below SMCI's" },
  {
    path: "baseline.hedgePutPriceGate",
    label: "Hedge: no purchase while too dear",
    unit: "choice",
    editable: true,
    note: "a Put held is kept; a skipped purchase is tried again at the next look",
    choices: [
      { value: "off", label: "Off" },
      { value: "cost_vs_typical_fall", label: "Yearly cost above a share of the typical yearly fall" },
      { value: "iv_vs_history", label: "IV above a multiple of the stock's median IV over 252 sessions" },
      { value: "iv_vs_realized", label: "IV above a multiple of the last 21 sessions' realized volatility" },
    ],
  },
  { path: "baseline.hedgePutCostFallShare", label: "Hedge: yearly cost at most this share of the typical fall", unit: "number", editable: true, note: "yearly cost = mid ÷ stock price × 365 ÷ days to expiry; typical yearly fall = the median, over 5 years, of the deepest fall in each year of closes. 0.3 × a 40% fall = 12% a year" },
  { path: "baseline.hedgePutIvMultiple", label: "Hedge: IV at most this multiple", unit: "number", editable: true, note: "of the stock's median IV over 252 sessions, or of the realized volatility of the last 21" },
  {
    path: "baseline.hedgePutSize",
    label: "Hedge: size",
    unit: "choice",
    editable: true,
    note: "rung level = (1 − share level) ÷ (share level × (rungs − shock)), at most one Put per 100 shares: 60% shares, 2 rungs and a 70% shock give 0.51",
    choices: [
      { value: "share_level", label: "Share level: one Put per 100 shares bought" },
      { value: "rung_level", label: "Rung level: the Puts one rung buys if assigned at its cap" },
    ],
  },
  { path: "baseline.hedgePutCoveragePct", label: "Hedge: share of that size", unit: "percent", editable: true, note: "50 = half the Puts; whole contracts, rounded down over the cycle's entries" },
  {
    path: "baseline.hedgePutStaggeredExpiries",
    label: "Hedge: expiries the Puts are spread over",
    unit: "integer",
    editable: true,
    note: "3 with 360 days rolled at 90 left: Puts of about 360, 270 and 180 days, so a third of them rolls each quarter",
  },
  { path: "baseline.hedgePutRollDaysLeft", label: "Hedge: roll with days left", unit: "days", editable: true, note: "a Put this close to expiry is sold, and replaced (same count, same rules) while shares are held; with the whole position, up to its size" },
  {
    path: "baseline.hedgeInBreakEven",
    label: "Hedge: realized P&L in the break-even",
    unit: "choice",
    editable: true,
    note: "the Calls' floor and the ladder's top: a Put sold at a gain lowers them",
    choices: [
      { value: "excluded", label: "Left out, as live does" },
      { value: "included", label: "Included once the Puts are sold" },
    ],
  },
  {
    path: "baseline.hedgePutTurnover",
    label: "Hedge: fewer purchases",
    unit: "choice",
    editable: true,
    note: "kept Puts leave the cycle at their mark (no trade), so the cycle ends as without them; the next entry takes them back in and buys only what's missing",
    choices: [
      { value: "sell_when_shares_leave", label: "Off: sell the Puts when the shares leave" },
      { value: "keep_for_next_entry", label: "Keep the Puts for the next entry" },
      { value: "keep_unless_far_below", label: "Keep them, unless struck far below the new price" },
      { value: "wait_between_purchases", label: "Wait between purchases" },
    ],
  },
  { path: "baseline.hedgePutTurnoverDays", label: "Hedge: days to keep or wait", unit: "days", editable: true, note: "kept Puts no entry has taken by then are sold; with the wait, an entry's Puts are bought once this long after the last purchase, if its shares are still held" },
  { path: "baseline.hedgePutFarBelowPct", label: "Hedge: far below the new price by", unit: "percent", editable: true, note: "kept Puts struck this much below the new entry's price are sold, and at-the-money ones bought" },
];

const ladderOn: BacktestSettingCondition = { path: "baseline.putsWhenNoCall", oneOf: ["reserve_ladder"] };
const hedgeOn: BacktestSettingCondition = { path: "baseline.hedgePutTenorDays", above: 0 };
const hedgeOnEntries: BacktestSettingCondition = { path: "baseline.hedgePutCovers", oneOf: ["entries"] };
const strikeByPrice: BacktestSettingCondition = { path: "baseline.hedgePutStrikeBy", oneOf: ["price"] };
const onlyWithLadder: BacktestSettingApplicability = { allOf: [ladderOn], explanation: "Applies only with Puts when no call is sold set to the ladder." };
const onlyWithHistoryShock: BacktestSettingApplicability = { allOf: [ladderOn, { path: "baseline.ladderShock", oneOf: ["history"] }], explanation: "Applies only with the ladder's Stock shock set to the stock's Max drawdown." };

/**
 * The groups in order, each row's place in them, and when a Baseline wheel row is read at all (as the engine reads them:
 * backtestBaselineLook, baselineSaleSteps, backtestBaselineLadder). The New session table and the lab's settings show this.
 */
/** The Vol Farmer rows Vol Farmer v2 reads too: its Calls' |delta| range and the spread limit. */
const volFarmerV2ReadsIt: ReadonlySet<string> = new Set(["volFarmer.callMinAbsDelta", "volFarmer.callMaxAbsDelta", "volFarmer.maxSpreadPctOfMid"]);

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
  { group: "Exits", section: "baseline_wheel", rows: [{ path: "baseline.takeProfitPct" }, { path: "baseline.shareStopLossPct" }] },
  {
    group: "Hedge",
    section: "baseline_wheel",
    rows: [
      { path: "baseline.hedgePutTenorDays" },
      { path: "baseline.hedgePutCovers", appliesWhen: { allOf: [hedgeOn], explanation: "Applies only with the hedge on (Puts' days to expiry above 0)." } },
      { path: "baseline.hedgePutExpiry", appliesWhen: { allOf: [hedgeOn], explanation: "Applies only with the hedge on (Puts' days to expiry above 0)." } },
      { path: "baseline.hedgePutStrikeBy", appliesWhen: { allOf: [hedgeOn], explanation: "Applies only with the hedge on (Puts' days to expiry above 0)." } },
      { path: "baseline.hedgePutStrikeFrom", appliesWhen: { allOf: [hedgeOn, hedgeOnEntries, strikeByPrice], explanation: "Applies only with the hedge on, covering the shares each entry brings in, and the strike chosen by price." } },
      { path: "baseline.hedgePutBelowPricePct", appliesWhen: { allOf: [hedgeOn, strikeByPrice], explanation: "Applies only with the hedge on and the strike chosen by price." } },
      { path: "baseline.hedgePutAbsDelta", appliesWhen: { allOf: [hedgeOn, { path: "baseline.hedgePutStrikeBy", oneOf: ["delta"] }], explanation: "Applies only with the hedge on and the strike chosen by delta." } },
      { path: "baseline.hedgePutSize", appliesWhen: { allOf: [hedgeOn, hedgeOnEntries], explanation: "Applies only with the hedge on and covering the shares each entry brings in." } },
      { path: "baseline.hedgePutCoveragePct", appliesWhen: { allOf: [hedgeOn], explanation: "Applies only with the hedge on (Puts' days to expiry above 0)." } },
      { path: "baseline.hedgePutStaggeredExpiries", appliesWhen: { allOf: [hedgeOn, { path: "baseline.hedgePutCovers", oneOf: ["position"] }], explanation: "Applies only with the hedge on and covering the whole position." } },
      ...["baseline.hedgePutRollDaysLeft", "baseline.hedgeInBreakEven", "baseline.hedgePutPriceGate"].map((path) => ({
        path,
        appliesWhen: { allOf: [hedgeOn], explanation: "Applies only with the hedge on (Puts' days to expiry above 0)." },
      })),
      { path: "baseline.hedgePutCostFallShare", appliesWhen: { allOf: [hedgeOn, { path: "baseline.hedgePutPriceGate", oneOf: ["cost_vs_typical_fall"] }], explanation: "Applies only with the hedge on and No purchase while too dear set to the yearly cost." } },
      { path: "baseline.hedgePutIvMultiple", appliesWhen: { allOf: [hedgeOn, { path: "baseline.hedgePutPriceGate", oneOf: ["iv_vs_history", "iv_vs_realized"] }], explanation: "Applies only with the hedge on and No purchase while too dear set to an IV rule." } },
      { path: "baseline.hedgePutTurnover", appliesWhen: { allOf: [hedgeOn, hedgeOnEntries], explanation: "Applies only with the hedge on and covering the shares each entry brings in." } },
      {
        path: "baseline.hedgePutTurnoverDays",
        appliesWhen: { allOf: [hedgeOn, hedgeOnEntries, { path: "baseline.hedgePutTurnover", oneOf: ["keep_for_next_entry", "keep_unless_far_below", "wait_between_purchases"] }], explanation: "Applies only with the hedge on, covering the shares each entry brings in, and Fewer purchases set to keep or wait." },
      },
      {
        path: "baseline.hedgePutFarBelowPct",
        appliesWhen: { allOf: [hedgeOn, hedgeOnEntries, { path: "baseline.hedgePutTurnover", oneOf: ["keep_unless_far_below"] }], explanation: "Applies only with the hedge on, covering the shares each entry brings in, and Fewer purchases set to keep them unless struck far below." },
      },
    ],
  },
  {
    group: "Steady Stake",
    section: "steady_stake",
    rows: ["steadyStake.stakePct", "steadyStake.rebalanceBandPct", "steadyStake.callCoveragePct", "steadyStake.callAbsDelta", "steadyStake.putCashPct", "steadyStake.putAbsDelta", "steadyStake.deltaTolerance", "steadyStake.maxSpreadPctOfMid"].map((path) => ({
      path,
      appliesWhen: { allOf: [{ path: "decisionMaker", oneOf: ["steady_stake"] }], explanation: "Applies only with the Steady Stake as decision maker." },
    })),
  },
  {
    group: "Vol Farmer",
    section: "vol_farmer",
    rows: ["volFarmer.callMinAbsDelta", "volFarmer.callMaxAbsDelta", "volFarmer.callMinDte", "volFarmer.callMaxDte", "volFarmer.callExpiry", "volFarmer.putMinDte", "volFarmer.putMaxDte", "volFarmer.putMaxStrikeAbovePricePct", "volFarmer.protectionFallPct", "volFarmer.maxSpreadPctOfMid", "volFarmer.putCashReservePct", "volFarmer.crossing", "volFarmer.putExpiry", "volFarmer.hedgeRuleCallPremiums", "volFarmer.minPutProtectionPct", "volFarmer.hedgeWithoutCall", "volFarmer.putChoice", "volFarmer.maxPutCostPctOfCallPremium", "volFarmer.putRoll", "volFarmer.hedgeAfterExpiry", "volFarmer.afterAssignment", "volFarmer.hedgeRuleStockPnl", "volFarmer.putCashIn", "volFarmer.cashInPutMinProtectionPct", "volFarmer.hedge"].map((path) => ({
      path,
      appliesWhen: volFarmerV2ReadsIt.has(path)
        ? { allOf: [{ path: "decisionMaker", oneOf: ["vol_farmer", "vol_farmer_v2"] }], explanation: "Applies only with the Vol Farmer or Vol Farmer v2 as decision maker." }
        : { allOf: [{ path: "decisionMaker", oneOf: ["vol_farmer"] }], explanation: "Applies only with the Vol Farmer as decision maker." },
    })),
  },
  {
    group: "Vol Farmer v2",
    section: "vol_farmer_v2",
    rows: ["volFarmerV2.putsStartCallYieldPct", "volFarmerV2.putMaxAbsDelta", "volFarmerV2.stepBelowFirstBreakEvenPct", "volFarmerV2.stepRule", "volFarmerV2.leapsMinDte", "volFarmerV2.leapsAbsDelta", "volFarmerV2.leapsMaxAccountPct"].map((path) => ({
      path,
      appliesWhen: { allOf: [{ path: "decisionMaker", oneOf: ["vol_farmer_v2"] }], explanation: "Applies only with Vol Farmer v2 as decision maker." },
    })),
  },
];

/** What a session does not replay, for the note under the table. */
export const backtestNotReplayed: readonly string[] = [
  "What happens between two looks: a session looks every 30 minutes, on the quotes of that instant.",
  "Orders in flight: a session's order fills when it is placed.",
  "A symbol's looks after 10:00 on the days its data file has no intraday quotes.",
  "Early assignment and dividends.",
];

/** Paths a session may override. */
export const editableBacktestSettingPaths: ReadonlySet<string> = new Set(backtestSettingRowDefinitions.filter((row) => row.editable).map((row) => row.path));

/** The value a row's path addresses inside the settings ("pluto.windowStartEt", "trading.spreadCostChargedPct", "baseline.ladderRungs", "decisionMaker"). */
export function readBacktestSettingValue(settings: BacktestSettings, settingPath: string): number | string {
  if (settingPath === "decisionMaker") return settings.decisionMaker ?? "rules";
  const [section, field] = settingPath.split(".") as [string, string];
  if (section === "baseline") return ({ ...defaultBacktestBaselineSettings, ...settings.baseline } as unknown as Record<string, number | string>)[field]!;
  if (section === "steadyStake") return ({ ...defaultBacktestSteadyStakeSettings, ...settings.steadyStake } as unknown as Record<string, number | string>)[field]!;
  if (section === "volFarmer") return ({ ...defaultBacktestVolFarmerSettings, ...settings.volFarmer } as unknown as Record<string, number | string>)[field]!;
  if (section === "volFarmerV2") return ({ ...defaultBacktestVolFarmerV2Settings, ...settings.volFarmerV2 } as unknown as Record<string, number | string>)[field]!;
  if (section === "pluto") return (settings.pluto as unknown as Record<string, number | string>)[field]!;
  if (section === "trading") return (settings.trading as unknown as Record<string, number | string>)[field]!;
  throw new Error(`Not a settings path: ${settingPath}`);
}

const tickerBaselinePaths = new Set(backtestTickerBaselineKeys.map((key) => `baseline.${key}`));
/** A baseline value that can differ by ticker in a session of per-ticker pots. */
const isTickerBaselinePath = (path: string) => tickerBaselinePaths.has(path);

const rowDefinitionByPath = new Map(backtestSettingRowDefinitions.map((row) => [row.path, row]));
const placedPaths = backtestSettingLayout.flatMap((group) => group.rows.map((row) => row.path));
const misplacedPaths = [...backtestSettingRowDefinitions.map((row) => row.path).filter((path) => placedPaths.filter((placed) => placed === path).length !== 1), ...placedPaths.filter((path) => !rowDefinitionByPath.has(path))];
if (misplacedPaths.length > 0) throw new Error(`backtestSettingLayout must place every setting row once: ${misplacedPaths.join(", ")}`);

export function buildBacktestSettingRows(settings: BacktestSettings): BacktestSettingRow[] {
  const placed = backtestSettingLayout.flatMap(({ group, section, rows }) => rows.map(({ path, appliesWhen }) => ({ definition: rowDefinitionByPath.get(path)!, group, section, appliesWhen })));
  return placed.map(({ definition: { fixedValue, ...row }, group, section, appliesWhen }) => ({
    group,
    section,
    ...(appliesWhen ? { appliesWhen } : {}),
    ...row,
    ...(isTickerBaselinePath(row.path) ? { perTicker: true as const } : {}),
    now: fixedValue ?? readBacktestSettingValue(settings, row.path),
  }));
}

export async function loadBacktestSettingsTemplate(connection: Knex = db): Promise<BacktestSettingsTemplate> {
  const settings = await loadCurrentBacktestSettings(connection);
  return { settings, rows: buildBacktestSettingRows(settings), notReplayed: [...backtestNotReplayed] };
}
