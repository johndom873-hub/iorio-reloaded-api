import type { PlutoSettings } from "../pluto/settingsStore.js";
import type { TradingSettings } from "../lib/tradingSettingsStore.js";
import type { KellyEdgeBasis } from "../pluto/postModelGates.js";
import type { ModelForecastMethod } from "../lib/volatilityForecast.js";
import type { LadderLevels } from "./engine/backtestBaselineLadder.js";

// The backtesting API contract (docs/backtesting/). The app mirrors these types in src/api/backtest.ts.

export type BacktestJobKind = "download" | "backtest" | "analysis";
export type BacktestJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** What the screen shows: a running job with a heartbeat older than 60 s is "stopped". */
export type BacktestJobDisplayStatus = BacktestJobStatus | "stopped";
export type BacktestTablesMode = "walk_forward" | "current";

/**
 * Who decides a session's trades. "baseline": the naive wheel of BacktestBaselineSettings (Marcelo 2026-10-13), the CC +
 * Put Ladder. "steady_stake": the Steady Stake of BacktestSteadyStakeSettings. "vol_farmer": the Vol Farmer of
 * BacktestVolFarmerSettings; "vol_farmer_v2": Vol Farmer v2 of BacktestVolFarmerV2Settings (research). "rules" (Pluto's
 * stand-in rules on the Signals model, BacktestPolicySettings) and "llm" (the AI model through the subscription) were
 * retired with Signals (Marcelo 2026-10-27): their past sessions stay readable, none is created or run again.
 */
export type BacktestDecisionMaker = "rules" | "llm" | "baseline" | "steady_stake" | "vol_farmer" | "vol_farmer_v2";

/** The decision makers a session can still be created and run with. */
export const activeBacktestDecisionMakers = ["baseline", "steady_stake", "vol_farmer", "vol_farmer_v2"] as const satisfies readonly BacktestDecisionMaker[];

export const retiredBacktestDecisionMakerMessage = "The rules and llm backtests were retired with Signals; their past sessions stay readable.";

export function isRetiredBacktestDecisionMaker(decisionMaker: BacktestDecisionMaker): boolean {
  return decisionMaker === "rules" || decisionMaker === "llm";
}

/**
 * The naive wheel (approved by Marcelo 2026-10-13; the research log has the full rules). At every look: free round lots of
 * shares get the call with the highest premium yield in the delta and expiry ranges; free cash goes into the entry (a
 * cash-secured put, or 100 shares bought with a call sold on them) with the highest premium yield in the same ranges.
 * Everything is held to expiry: no buybacks, rolls, closes, stops, breakers or Signals.
 */
export interface BacktestBaselineSettings {
  /**
   * How free cash enters a stock: a cash-secured put, a Covered Call entry, or (higher_yield, Marcelo 2026-10-20) at each
   * look whichever of the two ranks higher by the Ranking, each held to its own rules.
   */
  entry: "put" | "covered_call" | "higher_yield";
  /** The |delta| range, from each quote's own implied volatility. */
  minAbsDelta: number;
  maxAbsDelta: number;
  /** Calendar days to expiry. */
  minDte: number;
  maxDte: number;
  /** Widest spread sold into, as a percent of the mid: (ask − bid) ÷ mid. */
  maxSpreadPctOfMid: number;
  /**
   * Calls on held shares: any strike in the delta range; only at or above what the cycle's shares cost (acquisition cost
   * per share acquired); only at or above the cycle's cash break-even (cashBreakEvenPerShare: what the shares held must
   * bring for the cycle to end flat); only at or above
   * the price of the latest share acquisition (a purchase, or a put assigned at its strike); only at or above the average
   * price paid for the shares held (ledgerHeldSharesAverageCost); at or above that average first and, for the lots still
   * uncovered, at or above the cycle's break-even; or none (the shares are held uncovered).
   */
  callStrike: "delta_range" | "above_share_cost" | "above_break_even" | "above_latest_entry" | "above_average_cost" | "above_average_cost_else_break_even" | "none";
  /**
   * A Covered Call entry's call: any strike; only at or above the price paid for its shares; or only at or above the average price
   * of the shares held once these are bought (the price paid when none are held).
   */
  entryCallStrike: "any" | "above_purchase_price" | "above_average_after_purchase";
  /**
   * A Covered Call entry while some held round lots have no call: "wait" until they all have one, or "buy" (the Covered Call entry buys
   * every share its call covers and leaves the uncovered lots to their own calls).
   */
  entryWhenSharesUncovered: "wait" | "buy";
  /**
   * With a Covered Call entry: Covered Call entries buy shares while the shares held, at the 10:00 price, stay within this % of the
   * day's account value; 100 = no cap. An assigned put may take them past it.
   */
  maxSharesPctOfAccount: number;
  /**
   * An entry (a Covered Call entry's call, a Cash-Secured Put entry's put) is sold only when its premium yield (annualized)
   * is above this %, and the calls on held shares too with minCallYieldAppliesTo "every_call"; 0 = any. The ladder's puts
   * at any yield.
   */
  minCallYieldPct: number;
  /**
   * "every_call": the entries and the calls on held shares (assigned ones included); "new_covered_calls": the entries only
   * (Covered Call entries' calls, Cash-Secured Put entries' puts), held shares' calls at any yield (Marcelo 2026-10-16).
   */
  minCallYieldAppliesTo: "every_call" | "new_covered_calls";
  /** "reserve_ladder": the put ladder on a cash reserve (backtestBaselineLadder.ts), with either entry; "off": no ladder. */
  putsWhenNoCall: "off" | "reserve_ladder";
  /**
   * With putsWhenNoCall "reserve_ladder" (backtestBaselineLadder.ts): the entries (Covered Calls' shares at cost, or Cash-Secured
   * Puts' collateral until assigned) at most this % of the account value the cycle started with; the rest is the puts' reserve. maxSharesPctOfAccount does not apply.
   */
  ladderSharesPct: number;
  /** The rungs the reserve is spent in: each put's collateral at most reserve ÷ rungs. */
  ladderRungs: number;
  /** The stock shock S: "history" (the deepest fall in the lookback before the cycle, within min–max) or "fixed" (ladderShockPct). */
  ladderShock: "history" | "fixed";
  ladderShockPct: number;
  ladderShockMinPct: number;
  ladderShockMaxPct: number;
  /** S when the lookback holds under a year of closes (fewer than 250: a new listing), outside the min–max range. */
  ladderShockNoHistoryPct: number;
  ladderShockLookbackYears: number;
  /** The ladder's top A: the cycle's break-even, or the lower of it and today's price (the rungs then spread from the price down to the floor). */
  ladderTop: "break_even" | "price";
  /** When a new rung may be sold: at any look with room, only while no ladder put is open, or never (the shares' budget alone). */
  ladderPace: "any_look" | "one_open" | "no_puts";
  /**
   * When the ladder sells a put while held shares are free: only when no call on them qualifies, or when its premium yield
   * beats the best call's by more than ladderPutYieldMarginPct% (relative: 25 = a quarter above the call's), the shares then
   * waiting for a later look.
   */
  ladderPutVersusCall: "call_first" | "higher_yield";
  ladderPutYieldMarginPct: number;
  /**
   * The ladder's Puts: on the |delta| range (minAbsDelta–maxAbsDelta), or "none": any |delta|, the rung's cap, days to expiry,
   * spread, minimum bid and volume limit bounding them (Marcelo 2026-10-16: the |delta| range is for the Calls only).
   */
  ladderPutDeltaRange: "delta_range" | "none";
  /** The day's recorded account value: open options at their marks, or left out (cash and shares only) until the end. */
  dayValueOptions: "marked" | "excluded";
  /** The |delta| range of every Call (on held shares and a new Covered Call): the Puts' (minAbsDelta–maxAbsDelta), or their own (callMinAbsDelta–callMaxAbsDelta). */
  callDeltaRange: "entry_range" | "own_range";
  callMinAbsDelta: number;
  callMaxAbsDelta: number;
  /** Buy an option back at a look once its buyback keeps at least this percentage of the premium; 0 = hold to expiry. */
  takeProfitPct: number;
  /** Sell every share of the stock (buying back any call written on them) once its price is this percentage below the cycle's cost per share acquired; 0 = never. */
  shareStopLossPct: number;
  /** "skip_spanning": no new sale whose expiry spans a known earnings date (Pluto's rule; dates known 30 days ahead). */
  earnings: "ignore" | "skip_spanning";
  /** The most of the account one stock may take for new sales (puts at their strike, shares at their cost, net of premium), percent. */
  maxAccountPctPerStock: number;
  /** When the baseline decides: at every look (every 30 minutes) or only at the 10:00 look. */
  looks: "every_look" | "first_look";
  /**
   * Sell only a contract whose implied volatility is at least minVolatilityEdgePoints above the stock's 21-session
   * forecast (YZ21), both on the forecast's clock (the Signals model's IV and forecast): for new entries only (a put or a
   * Covered Call entry), or for every sale, the calls on held shares too.
   */
  volatilityEdgeFilter: "off" | "entries" | "all_sales";
  /** Volatility points (5 = 5 points, e.g. 55% against a 50% forecast); may be negative. */
  minVolatilityEdgePoints: number;
  /**
   * The drop-risk filters on new entries (approved by Marcelo 2026-10-19; research: Ladder Drop-Risk Filters): no Cash-Secured
   * Put entry and no Covered Call entry (within the ladder's shares budget too) while the stock is stretched or its implied
   * volatility is near the top of its year; Calls on held shares and ladder Puts are never filtered. Each is on or off with
   * its own limit, and with both on either one blocks (entryDropRiskFilters.ts):
   *   extension z = (C ÷ A200 − 1) ÷ σ63: C the previous session's close, A200 the average of the last 200 daily closes, σ63
   *                 the standard deviation of the last 63 daily log returns × √252 (IBKR's split-adjusted closes before the day)
   *   IV Rank     = (IV − IV_min) ÷ (IV_max − IV_min) × 100 over the last 252 days with an implied volatility, IV the latest
   *                 of them (IBKR's daily IV before the day; Price Performance's IV Rank, ivMetrics.ts)
   */
  entryExtensionFilter: "off" | "on";
  /** Block a new entry while extension z is at or above this. */
  entryMaxExtensionZ: number;
  entryIvRankFilter: "off" | "on";
  /** Block a new entry while IV Rank is at or above this (0–100). */
  entryMaxIvRank: number;
  /**
   * The order the candidates are picked in: premium yield; the Signals model's Edge Yield; time value (the fill less its
   * intrinsic value, per contract after commission); the premium in dollars (the fill, intrinsic value included); or the
   * premium in dollars per calendar day to expiry (the fill ÷ days, at least 1).
   */
  ranking: "premium_yield" | "edge_yield" | "time_value" | "premium_dollars" | "premium_per_day";
  /** "nearest_qualifying": candidates from the nearest expiry that has any come first, then the next expiry's, each ranked. */
  expiryChoice: "any_in_range" | "nearest_qualifying";
  /**
   * "fill_down_ranking": when the best contract's volume limit cannot take every free lot (or the whole entry), the rest
   * goes to the next candidates in order until every lot is covered (the entry: until the cash or the stock's share runs out).
   */
  coverage: "best_contract" | "fill_down_ranking";
  /**
   * The hedge (Marcelo 2026-10-22, backtestBaselineHedge.ts): long Puts bought on the shares an entry brings in (a Covered
   * Call entry's, a Cash-Secured Put entry's once assigned), sold as the ladder's rungs are assigned (as many contracts as
   * the rung's), when shares leave, and near expiry (then replaced while shares are held). The Puts' target days to
   * expiry; 0 = no hedge.
   */
  hedgePutTenorDays: number;
  /** The listed expiry nearest the target days, or the first at or after them. */
  hedgePutExpiry: "nearest" | "first_at_or_after";
  /** What the strike is set from: the stock price at the purchase, or the price paid for the shares (an assigned Put's strike). Replacements near expiry: the stock price. */
  hedgePutStrikeFrom: "stock_price" | "price_paid";
  /** The strike this % below that price (0 = at the money): the listed strike nearest it. */
  hedgePutBelowPricePct: number;
  /**
   * How many Puts per 100 shares an entry brings in: one ("share_level"), or as many as one rung buys if assigned at its cap
   * ÷ the lots of the shares' budget (rung_level, at most one) = (1 − s) ÷ (s × (rungs − S)), s the share level and S the
   * shock; either × hedgePutCoveragePct.
   */
  hedgePutSize: "share_level" | "rung_level";
  hedgePutCoveragePct: number;
  /** A Put with this many calendar days or fewer to expiry is sold, and replaced while shares are held (with the whole position covered: up to its size). */
  hedgePutRollDaysLeft: number;
  /**
   * What the Puts cover (Marcelo 2026-10-23): the shares each entry brings in ("entries", the rules above and below), or
   * the whole position ("position"): the shares held plus the shares the open short Puts (the entry's and the ladder's
   * rungs) would bring, × hedgePutCoveragePct, bought as soon as it grows and kept until hedgePutRollDaysLeft whatever
   * the shares do (no sale when a rung is assigned or shares leave).
   */
  hedgePutCovers: "entries" | "position";
  /** With the whole position covered: the Puts are spread over this many expiries, so that their rolls come at different times. */
  hedgePutStaggeredExpiries: number;
  /** How the strike is chosen (Marcelo 2026-10-23): hedgePutBelowPricePct below a price ("price"), or the Put whose own |delta| is nearest hedgePutAbsDelta ("delta"). */
  hedgePutStrikeBy: "price" | "delta";
  hedgePutAbsDelta: number;
  /**
   * No Put is bought while it is too dear (Marcelo 2026-10-23; a Put held is kept, a skipped purchase is tried again at the
   * next look): its yearly cost above hedgePutCostFallShare × the stock's typical yearly fall ("cost_vs_typical_fall"), its
   * IV above hedgePutIvMultiple × the median of the stock's IV over 252 sessions ("iv_vs_history") or × the realized
   * volatility of the last 21 sessions ("iv_vs_realized").
   */
  hedgePutPriceGate: "off" | "cost_vs_typical_fall" | "iv_vs_history" | "iv_vs_realized";
  hedgePutCostFallShare: number;
  hedgePutIvMultiple: number;
  /** The Puts' realized P&L in the cycle's break-even (the Calls' floor and the ladder's top), or left out as live does. */
  hedgeInBreakEven: "excluded" | "included";
  /**
   * How the hedge holds down its purchases (Marcelo 2026-10-22): sell the Puts when the shares leave (the rule as built);
   * keep them for up to hedgePutTurnoverDays outside the cycle for the next entry to take ("keep_for_next_entry"), or
   * the same but sold instead when struck more than hedgePutFarBelowPct below the new entry's price
   * ("keep_unless_far_below"); or buy an entry's Puts only hedgePutTurnoverDays after the last purchase
   * ("wait_between_purchases").
   */
  hedgePutTurnover: "sell_when_shares_leave" | "keep_for_next_entry" | "keep_unless_far_below" | "wait_between_purchases";
  /** Calendar days: how long Puts are kept after the shares leave, or the wait after a purchase. */
  hedgePutTurnoverDays: number;
  hedgePutFarBelowPct: number;
}

/**
 * The engine's version, stored on each session it runs (backtest_sessions.engine_version): raised whenever a stored
 * session's settings would give different results, so the ticker analysis compares only same-engine runs. A new setting
 * whose default keeps the results does not raise it. 1: the engine as of 3020323 (2026-10-15). 2: max per ticker and max
 * per sector are shares of the capital budget, not of the account (2026-10-16). 3: a call's break-even floor is the
 * cycle's cash break-even, counting what shares that left the cycle brought in (2026-10-20).
 */
export const backtestEngineVersion = 3;

export const defaultBacktestBaselineSettings: BacktestBaselineSettings = { entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15, callStrike: "delta_range", entryCallStrike: "any", entryWhenSharesUncovered: "wait", maxSharesPctOfAccount: 100, minCallYieldPct: 0, minCallYieldAppliesTo: "every_call", putsWhenNoCall: "off", ladderSharesPct: 50, ladderRungs: 5, ladderShock: "history", ladderShockPct: 70, ladderShockMinPct: 60, ladderShockMaxPct: 80, ladderShockNoHistoryPct: 90, ladderShockLookbackYears: 10, ladderTop: "break_even", ladderPace: "any_look", ladderPutVersusCall: "call_first", ladderPutYieldMarginPct: 0, ladderPutDeltaRange: "delta_range", dayValueOptions: "marked", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, entryExtensionFilter: "off", entryMaxExtensionZ: 1, entryIvRankFilter: "off", entryMaxIvRank: 80, ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "best_contract", hedgePutTenorDays: 0, hedgePutExpiry: "nearest", hedgePutStrikeFrom: "stock_price", hedgePutBelowPricePct: 0, hedgePutSize: "share_level", hedgePutCoveragePct: 100, hedgePutRollDaysLeft: 7, hedgePutCovers: "entries", hedgePutStaggeredExpiries: 3, hedgePutStrikeBy: "price", hedgePutAbsDelta: 0.25, hedgePutPriceGate: "off", hedgePutCostFallShare: 0.3, hedgePutIvMultiple: 1.3, hedgeInBreakEven: "excluded", hedgePutTurnover: "sell_when_shares_leave", hedgePutTurnoverDays: 30, hedgePutFarBelowPct: 10 };

/**
 * The Steady Stake (decision maker "steady_stake"): each ticker keeps a steady share of its pot in its shares, bought or
 * sold back to it whenever it drifts out of the band, and sells Calls on those shares and Puts on the pot's free cash
 * only on an expiry day, at the 10:00 look, each expiring at that day's close. It decides at the 10:00 look only; no
 * Pluto rules and no Signals.
 */
export interface BacktestSteadyStakeSettings {
  /** The stake: the shares' value as a percent of the ticker's pot (in a shared account, its equal share of the account). */
  stakePct: number;
  /** Shares are bought or sold back to the stake once their value is off it by more than this percent of the pot. */
  rebalanceBandPct: number;
  /** On an expiry day: the percent of the free round lots that get a Call expiring that day; 0 = none. */
  callCoveragePct: number;
  /** The Calls' |delta|: the contract nearest it, no further than deltaTolerance away. */
  callAbsDelta: number;
  /** On an expiry day: the percent of the pot's free cash put up as collateral for Puts expiring that day; 0 = none. */
  putCashPct: number;
  /** The Puts' |delta|: the contract nearest it, no further than deltaTolerance away. */
  putAbsDelta: number;
  /** How far a contract's |delta| may be from its target. */
  deltaTolerance: number;
  /** Widest spread sold into, as a percent of the mid: (ask − bid) ÷ mid. */
  maxSpreadPctOfMid: number;
}

export const defaultBacktestSteadyStakeSettings: BacktestSteadyStakeSettings = { stakePct: 80, rebalanceBandPct: 5, callCoveragePct: 100, callAbsDelta: 0.2, putCashPct: 100, putAbsDelta: 0.2, deltaTolerance: 0.05, maxSpreadPctOfMid: 50 };

/**
 * The Vol Farmer (decision maker "vol_farmer", Marcelo 2026-10-23): shares with a Covered Call and a long Put that hedges
 * them. A cycle buys the shares, sells the Call and buys the Put at a 10:00 look; when the stock reaches the Call's
 * strike the whole position is unwound (the shares sold, the Call bought back, the Put sold) and the next cycle starts at
 * the next day's 10:00 look. A Call that expires below its strike is followed by the next one at the next day's 10:00
 * look, the Put kept. It decides at the 10:00 look only; no Pluto rules and no Signals (backtestVolFarmerLook.ts).
 */
export interface BacktestVolFarmerSettings {
  /** The Calls' |delta| range, from each quote's own implied volatility. */
  callMinAbsDelta: number;
  callMaxAbsDelta: number;
  /** The Calls' days to expiry (the engine reads Calls up to 45 days out). */
  callMinDte: number;
  callMaxDte: number;
  /** The Puts' days to expiry; a Put also expires on or after the Call's expiry (0 from: from the Call's expiry). */
  putMinDte: number;
  putMaxDte: number;
  /** The highest Put strike, as a percent above the stock price: 0 = at or below the price, −5 = at least 5% below it. */
  putMaxStrikeAbovePricePct: number;
  /** The fall the Put's protection is measured on, as a percent of the stock price. */
  protectionFallPct: number;
  /** Widest spread traded into, as a percent of the mid: (ask − bid) ÷ mid. */
  maxSpreadPctOfMid: number;
  /** The percent of the free cash a cycle's first purchase leaves in cash, for the later Puts (with the Calls' premiums). */
  putCashReservePct: number;
  /** Which Calls are tried: "in_range" (callMinDte to callMaxDte) or "next" (only the next listed expiry after today). */
  callExpiry: "in_range" | "next";
  /**
   * When the stock reaches the Call's strike: "unwind" the whole position there, "hold_to_expiry" (the Call is assigned
   * at its expiry if it ends in the money), or "unwind_if_net_positive" (unwind only when closing everything nets the
   * cycle a gain, else hold and check that again at every later look to the Call's expiry).
   */
  crossing: "unwind" | "hold_to_expiry" | "unwind_if_net_positive";
  /** Which Puts are tried: "in_range" (putMinDte to putMaxDte, on or after the Call's expiry) or "with_the_call" (only the Call's own expiry). */
  putExpiry: "in_range" | "with_the_call";
  /** Whether the cycle's realized Call P&L counts in the hedge rule, beside the Puts' realized P&L. */
  hedgeRuleCallPremiums: "excluded" | "included";
  /** The least protection a new Put may offer, as a percent (0 = any). */
  minPutProtectionPct: number;
  /**
   * Shares held with no Put and no Call that qualifies: "none" leaves them unhedged, "put" buys the Put at the strike cap
   * for the nearest expiry 7 or more days out, "cheapest_per_year" the Put putChoice takes (no hedge rule; protection to
   * the next listed Call expiry).
   */
  hedgeWithoutCall: "none" | "put" | "cheapest_per_year";
  /** Of the Puts that pass the hedge rule and minPutProtectionPct: "most_protection", or "cheapest_per_year" (the lowest yearly cost). */
  putChoice: "most_protection" | "cheapest_per_year";
  /** The most a new Put may cost, as a percent of the Call's premium (0 = no limit; 100 = a zero-cost collar). */
  maxPutCostPctOfCallPremium: number;
  /** Puts held and no Call that passes with them: "none" waits, "when_no_call" sells them when their banked P&L lets a Call pass with a new Put. */
  putRoll: "none" | "when_no_call";
  /** A Call expired below its strike with a Put held whose sale would realize a gain: "keep" it, or "sell_if_in_profit" with a new Call and a new Put that pass the hedge rule. */
  hedgeAfterExpiry: "keep" | "sell_if_in_profit";
  /** Shares called away with a Put held: "end" the cycle (the Put sold), or "continue_if_under_water" (the shares bought back and the Put kept unless the cycle's share and Put P&L with the Put's sale is above 0). */
  afterAssignment: "end" | "continue_if_under_water";
  /** Whether the cycle's realized share P&L counts in the hedge rule, beside the Puts' realized P&L. */
  hedgeRuleStockPnl: "excluded" | "included";
  /**
   * Shares and a Put held and no Call sold at the look: "none" keeps the Put; "when_no_call" sells every Put whose sale
   * realizes a gain, so the gain counts in the hedge rule from then, and hedges the lots left without a Put with the
   * hedgeWithoutCall Put.
   */
  putCashIn: "none" | "when_no_call";
  /** The least protection of the Put bought after a cash-in, as a percent (0 = any); hedgeWithoutCall "cheapest_per_year" only. */
  cashInPutMinProtectionPct: number;
  /** "put": the long Put hedge above; "none": no Put at all, a Call passing the hedge rule on the shares alone (research). */
  hedge: "put" | "none";
}

export const defaultBacktestVolFarmerSettings: BacktestVolFarmerSettings = { callMinAbsDelta: 0.05, callMaxAbsDelta: 0.3, callMinDte: 1, callMaxDte: 45, callExpiry: "in_range", putMinDte: 0, putMaxDte: 360, putMaxStrikeAbovePricePct: 0, protectionFallPct: 20, maxSpreadPctOfMid: 50, putCashReservePct: 10, crossing: "unwind", putExpiry: "in_range", hedgeRuleCallPremiums: "excluded", minPutProtectionPct: 0, hedgeWithoutCall: "none", putChoice: "most_protection", maxPutCostPctOfCallPremium: 0, putRoll: "none", hedgeAfterExpiry: "keep", afterAssignment: "end", hedgeRuleStockPnl: "excluded", putCashIn: "none", cashInPutMinProtectionPct: 0, hedge: "put" };

/**
 * Vol Farmer v2 (decision maker "vol_farmer_v2", Marcelo 2026-10-27; research): two Covered Calls at different price
 * levels, no hedge Put. The first position buys shares with half the pot and sells Calls at or above its break-even (what
 * the shares cost less its Calls' premiums). While the best of those Calls yields under putsStartCallYieldPct a year,
 * Puts are sold with the other half, struck at least stepBelowFirstBreakEvenPct (the Step) below that break-even; their shares,
 * once assigned, are the second position, with a break-even of its own (the strike less its Puts' and Calls' premiums).
 * When the second position finds no Call at or above its break-even, the free cash buys a LEAPS Call, sold when the second
 * position is called away. Calls and Puts on the next listed expiry, held to it; the Calls' |delta| range and the spread
 * limit are the Vol Farmer's settings (backtestVolFarmerV2Look.ts).
 */
export interface BacktestVolFarmerV2Settings {
  /** Puts start under: Puts are sold while the best Call the first position can sell yields under this, percent a year (no Call: 0%). */
  putsStartCallYieldPct: number;
  /** Put |delta|: the Puts' highest |delta|. */
  putMaxAbsDelta: number;
  /** A Put's strike is at least this far below the first position's break-even, percent (with stepRule "fixed"). */
  stepBelowFirstBreakEvenPct: number;
  /**
   * How the Step is set (Marcelo 2026-10-27): "fixed" is stepBelowFirstBreakEvenPct; "implied_move_at_put_sale" is the
   * one-month implied move at each Put sale, IBKR's 30-day IV of the latest daily bar before the day (within 10
   * sessions) × √(21 ÷ 252). No IV in those 10 sessions: the fixed Step.
   */
  stepRule: VolFarmerV2StepRule;
  /** The LEAPS: the first listed expiry at least this many days out. */
  leapsMinDte: number;
  /** The LEAPS: that expiry's Call whose |delta| is nearest this. */
  leapsAbsDelta: number;
  /**
   * The LEAPS cap (Marcelo 2026-10-27), % of the account's value at the look, positions marked: a LEAPS purchase spends
   * at most this, never more than the free cash. 0: no cap, all the free cash.
   */
  leapsMaxAccountPct: number;
  /**
   * When it decides (Marcelo 2026-10-27, as Pluto runs it): "first_look" at 10:00 only; "every_look" at every look (every
   * 30 minutes), on that look's quotes and price.
   */
  looks: VolFarmerV2Looks;
}

export const volFarmerV2StepRules = ["fixed", "implied_move_at_put_sale"] as const;
export type VolFarmerV2StepRule = (typeof volFarmerV2StepRules)[number];
export const volFarmerV2LooksChoices = ["first_look", "every_look"] as const;
export type VolFarmerV2Looks = (typeof volFarmerV2LooksChoices)[number];

export const defaultBacktestVolFarmerV2Settings: BacktestVolFarmerV2Settings = { putsStartCallYieldPct: 5, putMaxAbsDelta: 0.2, stepBelowFirstBreakEvenPct: 15, stepRule: "fixed", leapsMinDte: 365, leapsAbsDelta: 0.7, leapsMaxAccountPct: 0, looks: "first_look" };

/**
 * The stand-in for the AI model's choices (docs/backtesting/FULL-FIDELITY-DESIGN.md §5), read by the retired rules
 * sessions only: kept for their stored settings. A pass considered closes first, then rolls, then opens, and took at most
 * one action; an open was always Pluto's own top pick (Edge Yield, then Edge $).
 */
export interface BacktestPolicySettings {
  /** Roll or hold: only legs flagged near expiry, assignment risk or decayed; any eligible roll; never. The best by net roll $. */
  roll: "flagged_legs" | "any_eligible" | "never";
  /** A buyback Pluto offers because holding the put no longer pays (P2): take it, or never. */
  buyback: "when_offered" | "never";
  /** Round lots in profit above the floor (P1): a call on them when one clears the break-even rule, else sell; always sell; never sell (calls only). */
  sharesInProfit: "call_else_sell" | "always_sell" | "always_keep";
  /** A close offered before a macro event (F3): when the event's stress loss is at least what is left to earn less the close cost; never; always. */
  eventClose: "stress_vs_remaining" | "never" | "always";
  /**
   * A choice Pluto's gates refuse. try_next: that candidate is left out for the rest of the look and the rules choose
   * again, except that a refused open showing the account has no room ends the opens where there is none for that look
   * (on its ticker: the ticker's exposure limits, its cooldown; on every ticker: the budget, the cash reserve, the
   * open-positions cap), while rolls and closes are still tried. stop: the look ends at the first refusal.
   */
  afterBlockedChoice: "stop" | "try_next";
}

export const defaultBacktestPolicySettings: BacktestPolicySettings = { roll: "flagged_legs", buyback: "when_offered", sharesInProfit: "call_else_sell", eventClose: "stress_vs_remaining", afterBlockedChoice: "try_next" };

/**
 * The Signals model's parameters a rules session could change (Marcelo 2026-10-13), kept for the retired rules sessions'
 * stored settings. They changed the model's figures and Pluto's use of them, never the fills
 * (trading.spreadCostChargedPct prices every fill).
 */
/** The order the retired rules backtests ranked their opens in, kept for their stored settings. */
export type OpenCandidateRanking = "edge_yield" | "hist_yield" | "edge_dollars";

export interface BacktestModelSettings {
  /** The Yang-Zhang window of the valuation forecast, in sessions; the walk-forward tables are built on the same window. */
  forecastWindowDays: number;
  /** The edge margins the grades start at, percent (strong ≥ good ≥ weak). */
  gradeStrongMarginPct: number;
  gradeGoodMarginPct: number;
  gradeWeakMarginPct: number;
  /** The order of the eligible opens: Pluto's top pick is the first. */
  rankOpensBy: OpenCandidateRanking;
  /** What the Kelly cap's expected P&L per contract is. */
  kellyBasis: KellyEdgeBasis;
  /** Surface fit and the 10:00 stock price: the widest quote spread a fit point or a parity pair may have, % of its mid. */
  surfaceMaxSpreadPctOfMid: number;
  /** Surface fit: the fewest fit points an expiry needs. */
  surfaceMinPointsPerSlice: number;
  /** Surface fit: the worst root-mean-square error of a usable expiry, in volatility points. */
  surfaceMaxRmseVp: number;
  /** The share of the half-spread the model charges as friction; null: the fills' share (sessions created before the split). */
  spreadCostChargedPct: number | null;
  /** The valuation forecast (volatilityForecast.ts ModelForecastMethod); the walk-forward tables stay standardized by Yang-Zhang 21. */
  forecastMethod: ModelForecastMethod;
  /** The variance clock's rest-of-day curve: live's, measured on 2026-06..10, or the 2020–2026 measure (varianceClock.ts). */
  restOfDayCurve: BacktestRestOfDayCurve;
}

export type BacktestRestOfDayCurve = "measured_2026_june_to_october" | "measured_2020_to_2026";
export const backtestRestOfDayCurves: readonly BacktestRestOfDayCurve[] = ["measured_2026_june_to_october", "measured_2020_to_2026"];

/** The values live used while Signals ran (volatilityForecast.ts, contractValuation.ts, postModelGates.ts, impliedVolatilitySurface.ts). */
export const defaultBacktestModelSettings: BacktestModelSettings = {
  forecastWindowDays: 21,
  gradeStrongMarginPct: 20,
  gradeGoodMarginPct: 10,
  gradeWeakMarginPct: 0,
  rankOpensBy: "edge_yield",
  kellyBasis: "edge_dollars",
  surfaceMaxSpreadPctOfMid: 50,
  surfaceMinPointsPerSlice: 8,
  surfaceMaxRmseVp: 3,
  spreadCostChargedPct: null,
  forecastMethod: "yang_zhang_21",
  restOfDayCurve: "measured_2026_june_to_october",
};

/** Settings frozen with a session. `trading` leaves out the commission estimator (the flat commission applies). */
export interface BacktestSettings {
  pluto: PlutoSettings;
  trading: Omit<TradingSettings, "commissionEstimator">;
  /** Share of full Kelly used to size (Pluto's fixed constant is `kellyFraction` in postModelGates.ts). */
  kellyFraction: number;
  /** Absent on sessions created before the wheel was simulated: the defaults apply. */
  policy?: BacktestPolicySettings;
  /** Absent on older sessions: "rules". */
  decisionMaker?: BacktestDecisionMaker;
  /** Absent on sessions created before the model's parameters could change: the defaults apply. */
  model?: BacktestModelSettings;
  /** Absent on sessions created before the baseline wheel existed: the defaults apply. */
  baseline?: BacktestBaselineSettings;
  /** Absent on sessions created before the Steady Stake existed: the defaults apply. */
  steadyStake?: BacktestSteadyStakeSettings;
  /** Absent on sessions created before the Vol Farmer existed: the defaults apply. */
  volFarmer?: BacktestVolFarmerSettings;
  /** Absent on sessions created before Vol Farmer v2 existed: the defaults apply. */
  volFarmerV2?: BacktestVolFarmerV2Settings;
}

export interface BacktestSettingsOverrides {
  pluto?: Partial<PlutoSettings>;
  trading?: Partial<Omit<TradingSettings, "commissionEstimator">>;
  kellyFraction?: number;
  policy?: Partial<BacktestPolicySettings>;
  decisionMaker?: BacktestDecisionMaker;
  model?: Partial<BacktestModelSettings>;
  baseline?: Partial<BacktestBaselineSettings>;
  steadyStake?: Partial<BacktestSteadyStakeSettings>;
  volFarmer?: Partial<BacktestVolFarmerSettings>;
  volFarmerV2?: Partial<BacktestVolFarmerV2Settings>;
}

/**
 * How a session's tickers share the account. "shared_account": the session's settings for every ticker and the whole
 * account as each ladder's base (every session created before per-ticker pots). "pots": each ticker has its own pot and
 * baseline values, its ladder's base is its weight (its pot ÷ every pot) of the account, and the tickers still share the
 * one account, its cash and its interest.
 */
export type BacktestBookMode = "shared_account" | "pots";

/** The baseline values that can differ between the tickers of one session; every other value is the session's. */
export const backtestTickerBaselineKeys = ["minAbsDelta", "maxAbsDelta", "ladderSharesPct", "ladderRungs", "ladderShock", "ladderShockPct", "ladderShockMinPct", "ladderShockMaxPct"] as const;
export type BacktestTickerBaselineKey = (typeof backtestTickerBaselineKeys)[number];
export type BacktestTickerBaselineSettings = Pick<BacktestBaselineSettings, BacktestTickerBaselineKey>;

/** "per_ticker": each ticker's saved lab values apply; "global": the lab's global values for every ticker. */
export type BacktestSettingsSource = "per_ticker" | "global";

/** Where a ticker's value came from: the lab's global values, the ticker's lab values, the session-wide overrides, or the request's values for the ticker. */
export type BacktestSymbolSettingSource = "global" | "ticker" | "session" | "request";

/** A ticker's own values, as asked in a request or saved in the lab. */
export interface BacktestTickerValues {
  potDollars?: number;
  baseline?: Partial<BacktestTickerBaselineSettings>;
}

/** A ticker of a "pots" session as it was created. */
export interface BacktestSymbolSettings {
  potDollars: number;
  /** Its pot ÷ every pot: its share of the account for the ladder's base, fixed for the session. */
  weight: number;
  baseline: BacktestTickerBaselineSettings;
  source: Record<BacktestTickerBaselineKey | "potDollars", BacktestSymbolSettingSource>;
}

/** The baseline's orders: calls on the free lots, the entry with the free cash, a ladder put, a put on the DTE budget. */
export type BacktestOrderStep = "held_calls" | "entry" | "ladder_put" | "budget_put";

/** Why an order left contracts unsold: the cash cut it; the contracts within the rules ran out (each to its volume limit, or already held); or none was within the rules. */
export type BacktestShortfallReason = "cash" | "volume" | "no_candidate";

/**
 * An order of the baseline that left contracts unsold, as its look saw it (recorded only: no decision reads it). Looks
 * that found nothing within the rules are one row per day, symbol and order: the day's first such look, with their count.
 */
export interface BacktestOrderShortfall {
  tradingDate: string;
  at: string;
  lookTimeEt: string;
  symbol: string;
  step: BacktestOrderStep;
  right: "C" | "P";
  /** In contracts of the order's best candidate (a put's: the rung's collateral ÷ (its strike × 100)); null when there was none to measure it by. */
  wantedContracts: number | null;
  filledContracts: number;
  unsoldContracts: number | null;
  reason: BacktestShortfallReason;
  /** 1, or the day's looks a no_candidate row stands for. */
  lookCount: number;
  /** The best contract the order was allowed to sell (the first in its ranking not already held); null when none. */
  bestCandidate: { expiry: string; strike: number; dte: number; premiumYield: number; volumeCap: number } | null;
}

/** The put ladder's levels at a symbol's first look of a day while its cycle holds shares (recorded only), on that day's scale. */
export interface BacktestLadderLevel {
  tradingDate: string;
  at: string;
  lookTimeEt: string;
  symbol: string;
  /** Today's cumulative split factor: the price as traded ÷ it = split-adjusted. */
  splitFactor: number;
  levels: LadderLevels;
}

/** Vol Farmer v2: each position's break-even per share after a look, as traded, per symbol whose cycle holds shares. */
export interface BacktestBreakEvenLevel {
  tradingDate: string;
  at: string;
  lookTimeEt: string;
  symbol: string;
  /** Today's cumulative split factor: the price as traded ÷ it = split-adjusted. */
  splitFactor: number;
  /** Null while the first position holds no shares. */
  firstBreakEven: number | null;
  /** Null while the second position (the assigned Puts' shares) holds none. */
  secondBreakEven: number | null;
}

/** A problem with a ticker's values in a request: the value it is about (a per-ticker baseline key or "potDollars"; null for the combination), and the sentence. */
export interface BacktestTickerProblem {
  key: string | null;
  message: string;
}

/** A ticker as a request resolves it (the New session screen's estimate): its values, where each came from, what each would be one layer down, and what is wrong with them. */
export interface BacktestSymbolResolution extends Omit<BacktestSymbolSettings, "potDollars" | "weight"> {
  /** Null when the ticker has no pot. */
  potDollars: number | null;
  /** Null while any ticker of the request has no pot. */
  weight: number | null;
  /** For each value not from the lab's global values: the value and source it returns to when this session's or the ticker's layer is removed. */
  fallback: Partial<Record<BacktestTickerBaselineKey | "potDollars", { value: number | string | null; source: BacktestSymbolSettingSource }>>;
  /** Empty when the ticker's values can run. */
  problems: BacktestTickerProblem[];
}

/** A session's settings with its overrides applied and every default filled in: what the engine runs on. */
export interface EffectiveBacktestSettings extends BacktestSettings {
  policy: BacktestPolicySettings;
  decisionMaker: BacktestDecisionMaker;
  model: BacktestModelSettings;
  baseline: BacktestBaselineSettings;
  steadyStake: BacktestSteadyStakeSettings;
  volFarmer: BacktestVolFarmerSettings;
  volFarmerV2: BacktestVolFarmerV2Settings;
}

export interface BacktestJobView {
  id: string;
  kind: BacktestJobKind;
  symbol: string;
  sessionId: string | null;
  sessionName: string | null;
  status: BacktestJobStatus;
  displayStatus: BacktestJobDisplayStatus;
  progressDone: number;
  progressTotal: number;
  progressLabel: string | null;
  /** Seconds left at the recent pace; null until it can be estimated. */
  etaSeconds: number | null;
  /** Total run time so far (a resumed download adds its earlier runs; a resumed backtest starts again); null if it never ran. */
  runSeconds: number | null;
  heartbeatAt: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** A queued download put at the top of the queue (the latest put first starts first). */
  putFirst: boolean;
  /** A running download asked to pause: it goes back into the queue once it stops. */
  pauseRequested: boolean;
}

/** A split the engine found by comparing the options' closing parity price with IBKR's split-adjusted close. */
export interface BacktestDetectedSplit {
  /** The last file day on the old scale. */
  lastDayBefore: string;
  /** The first file day on the new scale. */
  firstDayAfter: string;
  /** New shares per old share: 10 = a 10-for-1 split, 0.1 = a 1-for-10 reverse split. */
  ratio: number;
}

/** A part of an option day the downloader fetches (the file's day_issues.part). */
export type BacktestDataFilePart = "quotes" | "eod" | "open_interest" | "intraday_quotes";

/** Everything wrong with a file's option days, for the Data files table's Issues tooltip. Reasons are plain text. */
export interface BacktestDataFileIssues {
  /** Weekdays between firstDate and lastDate with nothing stored and no failed attempt recorded, as runs of consecutive weekdays. */
  notStored: { firstDate: string; lastDate: string; weekdays: number }[];
  /** Days stored with a part or an expiration missing: one entry per day, expiration and reason. */
  partial: { tradingDate: string; expiry: string | null; parts: BacktestDataFilePart[]; reason: string }[];
  /** Days, or a day's intraday quotes, the downloader could not retrieve; every later download asks for them again. */
  unavailable: { tradingDate: string; part: BacktestDataFilePart | null; reason: string }[];
}

export interface BacktestDataFileSummary {
  symbol: string;
  /** Splits found in the file's period; null until the file has been analysed (after a download or a session run). */
  detectedSplits: BacktestDetectedSplit[] | null;
  firstDate: string | null;
  lastDate: string | null;
  /** Days stored with data. */
  completeDays: number;
  /** Weekdays between firstDate and lastDate with no row at all (a gap to fill). */
  missingWeekdays: number;
  /** Stored days of which the downloader could not retrieve a part or an expiration (the file's day_issues); 0 on a file without that record. */
  daysWithIssues: number;
  /** Days the downloader could not retrieve at all, or whose intraday quotes it could not (the file's unavailable_days); 0 on a file without that record. */
  unavailableDays: number;
  /** Days with complete intraday quotes; null on a file downloaded before intraday quotes existed. */
  intradayDays: number | null;
  sizeBytes: number;
  /** IBKR daily bars in the local DB for the symbol (the forecast and settlement prices). */
  barsFirstDate: string | null;
  barsLastDate: string | null;
  /** How many of those bars are stored; 0 when none. */
  barsCount: number;
  /** Distinct days in `issues`: nothing stored, stored with a part missing, or not retrievable. */
  issueDays: number;
  issues: BacktestDataFileIssues;
}

/**
 * What a session's win rate, averages, edge capture and model accuracy are measured on. "wheel_cycle": the wheel cycle's
 * P&L, as the platform shows it. "option": each option's own result, on the sessions run before cycles carried the P&L
 * (their stored figures are kept).
 */
export type BacktestPnlBasis = "wheel_cycle" | "option";

/**
 * The headline figures (docs/backtesting/FORMULAS.md). Ratios are fractions (0.418 = +41.8%). On the wheel-cycle basis:
 * win rate = closed cycles with a total above 0 ÷ closed cycles; average win and loss are per closed cycle; edge
 * capture = Σ closed cycles' totals ÷ Σ Edge $ predicted for the options sold in them. A buy-and-hold series has no
 * trades or cycles: those figures are 0 or null.
 */
export interface BacktestMetrics {
  startValue: number;
  endValue: number;
  totalReturn: number;
  cagr: number;
  sortino: number | null;
  maxDrawdown: number;
  worstMonth: number | null;
  /** Options sold: opening puts and calls and the new leg of each roll. */
  tradeCount: number;
  /** Wheel cycles, and those of them that closed; absent on sessions measured per option. */
  cycleCount?: number;
  closedCycleCount?: number;
  winRate: number | null;
  averageWinDollars: number | null;
  averageLossDollars: number | null;
  edgeCapture: number | null;
  capitalInUse: number;
  returnOnCapitalInUse: number | null;
  inTheMoneyAtExpiryShare: number | null;
  interestDollars: number;
}

/** A session's wheel cycles at its end: every cycle's P&L, closed ones realized and open ones at the last marks. */
export interface BacktestWheelCycleSummary {
  cycleCount: number;
  closedCycleCount: number;
  openCycleCount: number;
  /** Σ every cycle's total. */
  totalPnlDollars: number;
  /** Σ the open cycles' totals: what they would make if closed at the last marks. */
  openCyclePnlDollars: number;
}

export interface BacktestSessionListItem {
  id: string;
  name: string;
  /** The symbols as text: "SMCI", or "SMCI, HOOD, INTC". */
  symbol: string;
  /** The symbols on the session's book, in the order given. */
  symbols: string[];
  startDate: string;
  endDate: string;
  startingValue: number;
  tablesMode: BacktestTablesMode;
  status: BacktestJobStatus;
  overrideCount: number;
  metrics: BacktestMetrics | null;
  /** How the metrics measure P&L: per wheel cycle, or per option on sessions run before cycles carried it. */
  pnlBasis: BacktestPnlBasis;
  /** The wheel cycles of a finished session measured per cycle; null otherwise. */
  wheelCycles: BacktestWheelCycleSummary | null;
  createdAt: string;
  /** Its latest job's run; null on the session list items that do not carry it (a comparison) or when the job is gone. */
  latestRun: BacktestSessionRunState | null;
  /** The batch it was started in, with its run number and the batch's run count; null on a session made before batches. */
  batch: BacktestSessionBatchRef | null;
}

/** A session's place in its batch. */
export interface BacktestSessionBatchRef {
  id: string;
  name: string;
  runNumber: number;
  runCount: number;
}

/** A session's latest job as the Sessions list shows it: a running job whose heartbeat stopped shows as stopped. */
export interface BacktestSessionRunState {
  status: BacktestJobStatus;
  displayStatus: BacktestJobDisplayStatus;
  progressDone: number;
  progressTotal: number;
}

/** The Sessions list's filters; "running" also matches a session still queued. */
export type BacktestSessionStatusFilter = "succeeded" | "running" | "failed" | "cancelled";

export const backtestSessionsPageDefaultLimit = 50;
export const backtestSessionsPageMaxLimit = 200;

/**
 * One page of the Sessions list, newest first. An entry is a session, or a batch of two or more runs with its runs that the
 * filters match (contiguous, by run number); `total` counts the entries; `symbols` lists every symbol any session has, for
 * the Symbol filter.
 */
export interface BacktestSessionsPage {
  sessions: BacktestSessionListItem[];
  total: number;
  limit: number;
  offset: number;
  symbols: string[];
}

/**
 * Whether a ticker suits the CC + Put Ladder, as an admin marked it on the Data files table. A ticker without one is Pending;
 * "pending" is a Pending ticker with a note (the window only marks Suitable or Unsuitable).
 */
export interface BacktestTickerSuitability {
  status: "pending" | "suitable" | "unsuitable";
  note: string;
  updatedAt: string;
  /** Null when the user who marked it was deleted. */
  updatedByName: string | null;
}

/** A ticker's name and classification for the Analyse window's header. */
export interface BacktestTickerProfile {
  /** "tradingview": full name, sector, industry and kind; "ibkr": IBKR's stored name (upper case, cut short) and sector, until TradingView answers. */
  source: "tradingview" | "ibkr";
  companyName: string | null;
  /** "NASDAQ", "NYSE", "AMEX" (TradingView's name for NYSE Arca), "CBOE"; IBKR's primary exchange in the fallback. */
  exchange: string | null;
  sector: string | null;
  industry: string | null;
  /** Null when not known (IBKR's sector only says "ETF"). */
  kind: "stock" | "adr" | "etf" | "other" | null;
}

export interface BacktestOverview {
  dataDirectory: string;
  files: BacktestDataFileSummary[];
  /** By symbol: the tickers marked so far (the rest are Pending). */
  suitabilityBySymbol: Record<string, BacktestTickerSuitability>;
  /**
   * The backtests, then the downloads. Backtests: the 50 latest, finished or not, latest activity first. Downloads: the
   * running one, the stopped ones, the queue in the order it starts them, then the finished ones, the last to end first;
   * every unfinished one is listed, the finished ones fill up to 50. The sessions are read page by page.
   */
  jobs: BacktestJobView[];
  /** How many backtests run at once (BACKTEST_MAX_PARALLEL_SESSIONS); the rest wait in the queue. */
  maxParallelSessions: number;
}

/** One value a "choice" row can take. */
export interface BacktestSettingChoice {
  value: string;
  label: string;
  /** Why the choice cannot be picked yet; absent when it can. */
  unavailableReason?: string;
}

/** One row of the New session settings table. `path` addresses the value inside BacktestSettings, e.g. "baseline.ladderRungs" or "trading.spreadCostChargedPct". */
export type BacktestSettingGroup = "How the session runs" | "Put ladder" | "Calls and Covered Calls" | "Contract choice" | "Entry filters" | "Exits" | "Hedge" | "Steady Stake" | "Vol Farmer" | "Vol Farmer v2";

/** "baseline_wheel": rows a Baseline wheel session (the CC + Put Ladder) reads, a few shared with the others;
 *  "steady_stake": rows only the Steady Stake reads; "vol_farmer": rows the Vol Farmer reads (a few Vol Farmer v2 too);
 *  "vol_farmer_v2": rows only Vol Farmer v2 reads. */
export type BacktestSettingSection = "baseline_wheel" | "steady_stake" | "vol_farmer" | "vol_farmer_v2";

/** A row's value against another row's: `oneOf` / `noneOf` its choice values, or a number `above`. */
export interface BacktestSettingCondition {
  path: string;
  oneOf?: string[];
  noneOf?: string[];
  above?: number;
}

/** When a row's value is read at all: every condition in `allOf`, and one of `anyOf` when given. */
export interface BacktestSettingApplicability {
  allOf?: BacktestSettingCondition[];
  anyOf?: BacktestSettingCondition[];
  /** Says when it applies, for the row that doesn't apply now. */
  explanation: string;
}

export interface BacktestSettingRow {
  path: string;
  group: BacktestSettingGroup;
  section: BacktestSettingSection;
  /** Absent: always read (in its section's sessions). */
  appliesWhen?: BacktestSettingApplicability;
  /** `path` addresses e.g. "baseline.ladderRungs", "trading.spreadCostChargedPct" or "decisionMaker". */
  label: string;
  /** "time" is a clock time, "HH:MM" Eastern. */
  unit: "percent" | "number" | "integer" | "dollars" | "grade" | "days" | "time" | "choice";
  now: number | string;
  editable: boolean;
  note: string | null;
  /** The values a "choice" row can take, the default first. */
  choices?: BacktestSettingChoice[];
  /** One of the baseline values that can differ by ticker in a session of per-ticker pots (backtestTickerBaselineKeys). */
  perTicker?: true;
}

export interface BacktestSettingsTemplate {
  settings: BacktestSettings;
  rows: BacktestSettingRow[];
  /** Pluto behaviour a session does not replay, for the note under the table. */
  notReplayed: string[];
}

/** The lab's global settings (separate from Pluto's live settings): the New session table's rows plus the default pot. */
export interface BacktestLabSettingsView extends BacktestSettingsTemplate {
  /** The dollars each ticker starts with when it has no pot of its own. */
  defaultPotDollars: number;
  updatedAt: string;
}

/** A ticker's lab values as stored; null = the lab's global value. */
export interface BacktestLabTickerOverrides {
  symbol: string;
  potDollars: number | null;
  ladderSharesPct: number | null;
  ladderRungs: number | null;
  /** A fixed shock instead of the global shock rule. */
  ladderShockPct: number | null;
  minAbsDelta: number | null;
  maxAbsDelta: number | null;
  updatedAt: string;
}

/** One changed lab value: a global settings path ("baseline.ladderRungs", "lab.defaultPotDollars") or a ticker field ("ladderRungs"). */
export interface BacktestLabChange {
  field: string;
  oldValue: string;
  newValue: string;
}

export interface BacktestLabAuditRow {
  id: number;
  changedAt: string;
  userDisplayName: string | null;
  /** Null for a global value. */
  symbol: string | null;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** How many stored analyses the save re-ran; null for ticker saves and rows from before it was recorded. */
  analysesRerun: number | null;
}

/** The most symbols one session runs on its book. */
export const backtestMaxSymbolsPerSession = 30;

/** What POST /backtest/sessions answers: the session, its job, and what the session will do differently because of what its data files hold (it still runs). */
export interface CreateBacktestSessionResponse {
  session: BacktestSessionListItem;
  job: BacktestJobView;
  warnings: string[];
  /** Each ticker's pot, weight and values with where each came from ("pots"); null when the tickers share the session's settings. */
  resolvedBySymbol: Record<string, BacktestSymbolSettings> | null;
}

/**
 * What POST /backtest/sessions/estimate answers: the create route's checks and resolution, nothing created. A request
 * whose only problems are tickers' values still answers here (each ticker with its problems); any other problem is a 400.
 */
export interface BacktestSessionEstimateResponse {
  warnings: string[];
  /** The session's capital: the starting value given, else Σ the pots; null while a ticker has no pot. */
  capital: number | null;
  bookMode: BacktestBookMode;
  resolvedBySymbol: Record<string, BacktestSymbolResolution> | null;
}

export interface CreateBacktestSessionRequest {
  name: string;
  /** One to backtestMaxSymbolsPerSession symbols, each with a data file; they share one simulated book. */
  symbols: string[];
  /** Accepted in place of `symbols` for one symbol (requests written before sessions took a list). */
  symbol?: string;
  startDate: string;
  endDate: string;
  /**
   * The session's capital. With the baseline deciding, it is split equally into the tickers' pots and can be left out:
   * each ticker's pot is then its symbolSettings pot, else its lab pot (settingsSource "per_ticker"), else the lab's
   * default pot. Required with the Steady Stake and the Vol Farmers.
   */
  startingValue?: number;
  tablesMode: BacktestTablesMode;
  overrides: BacktestSettingsOverrides;
  /** The baseline only; "per_ticker" unless given. */
  settingsSource?: BacktestSettingsSource;
  /** The baseline only: values for some of the session's tickers, over every other source. */
  symbolSettings?: Record<string, BacktestTickerValues>;
}

/** A batch takes 1 to this many runs (Marcelo 2026-10-17). */
export const backtestMaxRunsPerBatch = 9;

/**
 * POST /backtest/batches: the New session form's request. Every run shares the name's batch, the period, the tables, the
 * settings and where ticker values come from; each run has its own symbols and ticker values. Two or more runs need the
 * baseline as decision maker and each run's pots (no starting value). A run's session is named "<name> · Run 2 · <label>"
 * (one run: the name), cut to 120 characters.
 */
export interface CreateBacktestBatchRequest {
  name: string;
  startDate: string;
  endDate: string;
  tablesMode: BacktestTablesMode;
  overrides: BacktestSettingsOverrides;
  settingsSource?: BacktestSettingsSource;
  /** One run only: as CreateBacktestSessionRequest's. */
  startingValue?: number;
  runs: { label?: string; symbols: string[]; symbolSettings?: Record<string, BacktestTickerValues> }[];
}

export interface BacktestBatchSummary {
  id: string;
  name: string;
  createdAt: string;
  runCount: number;
}

/** What POST /backtest/batches answers: the batch, each run's session and job, and the warnings ("Run 2: …" with two or more runs). */
export interface CreateBacktestBatchResponse {
  batch: BacktestBatchSummary;
  runs: { session: BacktestSessionListItem; job: BacktestJobView }[];
  warnings: string[];
}

/** An account value series point: the run (or the combined portfolio), buy and hold of its tickers, buy and hold of SPY (null when not kept). */
export interface BacktestValuePoint {
  tradingDate: string;
  value: number;
  baselineValue: number;
  spyBaselineValue: number | null;
}

export interface BacktestBatchRun {
  runNumber: number;
  session: BacktestSessionListItem;
  overrides: BacktestSettingsOverrides;
  settingsSource: BacktestSettingsSource | null;
  symbolSettings: Record<string, BacktestSymbolSettings> | null;
  baselineMetrics: BacktestMetrics | null;
  spyBaselineMetrics: BacktestMetrics | null;
  /** Its latest job: progress while it runs, run time once done. */
  job: BacktestJobView | null;
  /** Every trading day at 10:00 ET, once the run has finished; empty before. */
  points: BacktestValuePoint[];
  /** Per symbol, once the run has finished; empty before. */
  tickerStatistics: BacktestTickerStatistics[];
}

/** GET /backtest/batches/:id. The runs share the period, the tables and the decision maker. */
export interface BacktestBatchDetail {
  batch: BacktestBatchSummary & { startDate: string; endDate: string; tablesMode: BacktestTablesMode; decisionMaker: BacktestDecisionMaker };
  runs: BacktestBatchRun[];
}

/** The figures of an account value line alone: what buy and hold has (no trades, cycles, exposure or interest kept per day). */
export type BacktestCurveFigures = Pick<BacktestMetrics, "startValue" | "endValue" | "totalReturn" | "cagr" | "sortino" | "maxDrawdown" | "worstMonth">;

/**
 * GET /backtest/batches/:id/combined?runs=1,3 (formula approved by Marcelo 2026-10-17): the runs added up day by day as
 * separate accounts in one portfolio. Value, exposure and interest are summed; the session's formulas run on the sum, with
 * the runs' trades and cycles pooled. Buy and hold and SPY are the sums of each run's own lines.
 */
export interface BacktestBatchCombined {
  runNumbers: number[];
  metrics: BacktestMetrics;
  baselineFigures: BacktestCurveFigures;
  /** Null when a run did not keep SPY's line. */
  spyBaselineFigures: BacktestCurveFigures | null;
  points: BacktestValuePoint[];
  /** Trading days some of the runs have and others lack, left out of the sum (0 when the runs share every day). */
  daysLeftOut: number;
}

export interface BacktestSessionDay {
  tradingDate: string;
  accountValue: number;
  cash: number;
  exposureDollars: number;
  interestDollars: number;
  dailyReturn: number | null;
  baselineValue: number;
  baselineDailyReturn: number | null;
  /** Fall from the previous peak, ≤ 0. */
  drawdown: number;
  decisionSummary: string | null;
  /** Buy and hold of SPY from the session's first day, for comparison; null on sessions run before it was kept, and while SPY has no price. */
  spyBaselineValue: number | null;
  spyBaselineDailyReturn: number | null;
  /** Looks run that day inside Pluto's window (12 on a full day with intraday quotes; 1 when only the 10:00 quotes exist); null on sessions run before looks were replayed. */
  looksRun: number | null;
  /** Actions filled that day, over all its looks; null on sessions run before looks were replayed. */
  actionsTaken: number | null;
}

/** What a run did with Pluto's window and its system checks, over the whole session. */
export interface BacktestRunStatistics {
  /** Looks run, over every day. */
  looksRun: number;
  /** Days on which at least one symbol was looked at after 10:00. */
  daysWithIntradayLooks: number;
  /** Days the daily-loss breaker tripped: no action from that look to the close. */
  dailyLossBreakerTripDates: string[];
  /** Looks at which market stress (SPY down on the day by the breaker's percentage) barred new opens, and the days they fell on. */
  marketStressLooks: number;
  marketStressDates: string[];
  /** Session days with no SPY 30-minute bars: the market-stress check could not run on them. */
  daysWithoutMarketStressBars: number;
  /** Sessions the AI model decided (retired): the decisions asked of the model, and how many the cache answered. */
  llmCalls?: { asked: number; fromCache: number };
  /** The baseline wheel's hedge, when it is on: its long Puts over the session. */
  hedge?: BacktestHedgeTotals;
}

/** The hedge's long Puts over a session (backtestBaselineHedge.ts summarizeHedge). */
export interface BacktestHedgeTotals {
  purchases: number;
  contractsBought: number;
  /** What the Puts bought cost: fills × shares + commissions. */
  costDollars: number;
  sales: number;
  contractsSold: number;
  /** What the sales brought: fills × shares − commissions (one settled at expiry: its intrinsic value, no commission). */
  proceedsDollars: number;
  /** The Puts sold or expired: what they brought less what they cost. */
  realizedPnlDollars: number;
  /** Puts still held at the end: contracts, their cost and their mark at the last look. */
  openContracts: number;
  openCostDollars: number;
  openMarkDollars: number;
  /** Half the quoted spread of every purchase and sale: what the full spread would have added to the mid fills. */
  halfSpreadDollars: number;
  /**
   * The keep rules' Puts kept between cycles (moved out of a cycle at their mark, no trade): contracts kept, contracts an
   * entry took into its cycle, contracts sold unkept or unused, and the realized P&L of those sales, which is in no cycle.
   */
  keptContracts?: number;
  keptContractsTaken?: number;
  keptContractsSold?: number;
  keptRealizedPnlDollars?: number;
}

/**
 * One option sold, as traded on its opening day: its facts (the fill, days to expiry, how it ended, its sizing caps),
 * the P&L of its position as the platform counts a position's (premium and stock parts), and the wheel cycle it belongs
 * to with the cycle's total. Whether the sale made money is the cycle's answer.
 */
export interface BacktestTrade {
  id: number;
  symbol: string;
  /** The simulated leg (positions[].legs[].legId); null on sessions run before the wheel was simulated. */
  legId: string | null;
  /** How it ended: at expiry (worthless or assigned), bought back, or rolled; null while open. */
  endedBy: "expired_worthless" | "assigned" | "bought_back" | "rolled" | null;
  openedOn: string;
  strategyKey: "cash_secured_put" | "covered_call";
  expiry: string;
  strike: number;
  optionRight: "C" | "P";
  contracts: number;
  bid: number;
  ask: number;
  fillPrice: number;
  commissionDollars: number;
  spotAtOpen: number;
  sharePriceAtOpen: number | null;
  /** EXP $ when it was sold: the position's capital at risk as Positions shows it (a put's strike, or a call's shares at their cost in the book, less the premium after its commission). */
  exposureDollars: number;
  dte: number;
  delta: number | null;
  /** The model's figures when it was sold; null for a baseline wheel's sale (no model). */
  grade: string | null;
  edgeMargin: number | null;
  expectedPnlDollars: number | null;
  calibratedExpectedPnlDollars: number | null;
  edgeYield: number | null;
  histYield: number | null;
  kellyContracts: number | null;
  stressContracts: number | null;
  /** The day it ended: its expiry date, or the day it was bought back or rolled. */
  settledOn: string | null;
  /** The underlying's close on the expiry day, on the opening day's price scale; null when it ended before expiry. */
  settlementClose: number | null;
  /** Assigned at expiry (in the money by a cent or more); null when it ended before expiry. */
  inTheMoneyAtExpiry: boolean | null;
  /** Only on sessions measured per option (BacktestPnlBasis "option"): the option's own result. Null on the others. */
  pnlDollars: number | null;
  /** Its position (positions[].positionId), with the position's P&L: realized (premium and stock parts, after commissions), plus what it still holds at the session's last marks while open. Null on sessions run before positions were kept. */
  positionId: string | null;
  positionStatus: "open" | "closed" | null;
  positionPnlDollars: number | null;
  /** Its wheel cycle (cycles[]: the symbol's cycleNumber), "HOOD #12", with the cycle's status and total. Null on sessions measured per option. */
  cycleNumber: number | null;
  cycleLabel: string | null;
  cycleStatus: "open" | "closed" | null;
  cycleTotalDollars: number | null;
}

export interface BacktestMonthlyReturn {
  /** YYYY-MM */
  month: string;
  sessionReturn: number;
  /** Buy and hold of the session's symbols. */
  baselineReturn: number;
  /** Buy and hold of SPY; null on sessions run before it was kept. */
  spyBaselineReturn: number | null;
}

/**
 * Model accuracy, predicted vs realized, in bands of 10 points of edge margin. On the wheel-cycle basis a row groups the
 * closed cycles whose first option sold had that margin: predicted = Σ Edge $ of the cycle's options sold, realized =
 * the cycle's total. On the option basis it groups the closed options by their own margin.
 */
export interface BacktestAccuracyBand {
  label: string;
  /** Options sold: in the band's cycles, or in the band itself on the option basis. */
  tradeCount: number;
  /** Closed cycles in the band; null on the option basis. */
  cycleCount: number | null;
  predictedPnlDollars: number;
  calibratedPnlDollars: number;
  realizedPnlDollars: number;
}

/** One leg of a simulated position, as the platform's position_legs row would read. Prices and share counts are on the scale of the position's wheel cycle. */
export interface BacktestPositionLeg {
  legId: string;
  /** The leg a partial sale carved this closed slice from. */
  parentLegId: string | null;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strike: number | null;
  expiry: string | null;
  /** Shares per contract (1 for stock). */
  multiplier: number;
  /** Option: the fill less the opening commission per share. Stock: the cost per share with the commission. */
  entryPrice: number;
  entryAt: string;
  /** The closing fill; 0 at expiry or assignment; the strike for shares called away; the entry price for shares handed to another position. */
  exitPrice: number | null;
  exitAt: string | null;
  /** How an option settled at expiry; null while open or when a trade closed it. */
  settledAs: "assigned" | "worthless" | null;
  /** The underlying's close the settlement was decided on. */
  expiryClose: number | null;
  /** Calendar days to expiry when the option was sold. */
  dteAtEntry: number | null;
  /** Realized P&L after closing commissions; null while open. */
  realizedPnlDollars: number | null;
  /** The stored prices ÷ this are the prices as traded on the entry day (1 unless a split fell inside the leg's cycle before it was opened). */
  priceScale: number;
}

export interface BacktestPosition {
  positionId: string;
  symbol: string;
  strategyKey: "cash_secured_put" | "covered_call" | "unstructured" | "hedge" | "leaps";
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  unstructuredReason: string | null;
  /** EXP $ now, net of premium; null once nothing is held. */
  capitalAtRiskDollars: number | null;
  /** The P&L % base. */
  capitalDeployedDollars: number | null;
  realizedPnlDollars: number;
  realizedPremiumPnlDollars: number;
  realizedStockPnlDollars: number;
  /** At the marks of the session's last look; null for a closed position. */
  unrealizedPnlDollars: number | null;
  /** Positions its shares came from. */
  shareSourcePositionIds: string[];
  /** The wheel cycle of its symbol that was running when it opened ("HOOD #3"); null when none is stored. */
  cycleNumber: number | null;
  cycleLabel: string | null;
  legs: BacktestPositionLeg[];
}

/** One simulated fill: an option sold or bought back, shares bought or sold, shares put to the book at the strike. */
export interface BacktestFill {
  fillId: string;
  positionId: string;
  legId: string;
  symbol: string;
  instrument: "stock" | "option";
  side: "buy" | "sell";
  /** Contracts or shares as the simulated book held them when it traded. */
  quantity: number;
  /** Shares per contract when it traded (1 for stock): price × quantity × multiplier is the fill's dollars. */
  multiplier: number;
  /** Per share, on the scale of the leg's cycle. */
  price: number;
  /** price ÷ this is the price as traded that day (1 unless a split fell inside the cycle before the fill). */
  priceScale: number;
  commissionDollars: number;
  executedAt: string;
  /** The Eastern date it executed on (a settlement's is the expiry date). */
  tradingDate: string;
  isClosing: boolean;
  /** The action that caused it; null for a settlement. */
  actionId: string | null;
}

/** How many rows a page of a session's actions or fills returns unless asked otherwise, and at most. */
export const backtestBookPageDefaultLimit = 200;
export const backtestBookPageMaxLimit = 1000;

/** Filters of GET /backtest/sessions/:id/actions and /fills, as query parameters. Dates are trading dates, inclusive. */
export interface BacktestBookPageQuery {
  from?: string;
  to?: string;
  symbol?: string;
  /** Actions only. */
  outcome?: "filled" | "blocked";
  limit?: number;
  offset?: number;
}

/** One page of a session's actions, in the order they were taken; `total` counts every action the filters match. */
export interface BacktestActionsPage {
  actions: BacktestAction[];
  total: number;
  limit: number;
  offset: number;
}

/** One page of a session's fills, in the order they executed; `total` counts every fill the filters match. */
export interface BacktestFillsPage {
  fills: BacktestFill[];
  total: number;
  limit: number;
  offset: number;
}

/** The time of the capture's own look, "HH:MM" Eastern: the day's account mark and surface fit are taken then. */
export const backtestCaptureLookTimeEt = "10:00";

export type BacktestActionKind = "open_cash_secured_put" | "open_covered_call" | "roll" | "buy_shares" | "close_shares" | "close_leg" | "close_position" | "buy_hedge" | "sell_hedge" | "buy_leaps" | "sell_leaps";

/** One thing Pluto did or tried in a pass: filled, or blocked with the gate that refused it. */
export interface BacktestAction {
  actionId: string;
  tradingDate: string;
  /** The look's instant. */
  at: string;
  /** The look's time, "HH:MM" Eastern. */
  lookTimeEt: string;
  /** The pass inside the look, from 1. */
  passNumber: number;
  symbol: string;
  kind: BacktestActionKind;
  /** The candidate or offer id Pluto's pass uses (symbol:strategy:expiry:strike, symbol:roll:leg:expiry:strike, symbol:close_…:id). */
  candidateId: string;
  description: string;
  /** Done by code without a choice (odd lots, the closes before earnings). */
  automatic: boolean;
  /** Why it was chosen: the automatic rule, or the stand-in rule. */
  chosenBecause: string;
  outcome: "filled" | "blocked";
  blockReason: string | null;
  gateResults: { gate: string; ok: boolean; detail: string }[];
  /** The contract traded or closed: as traded that day. */
  contract: { strategyKey?: string; expiry?: string; strike?: number; right?: "C" | "P"; fromExpiry?: string; fromStrike?: number } | null;
  /** The figures Pluto had on the candidate (model valuation) or the offer (its detail). */
  candidateScores: Record<string, unknown> | null;
  quantity: number | null;
  limitPrice: number | null;
  /** The simulated fill per share of the chosen leg; null when blocked. */
  fillPrice: number | null;
  /** Positions it opened or closed. */
  positionIds: string[];
}

export interface BacktestCycleBucket {
  premium: number;
  stock: number;
  total: number;
  capital: number;
}

/** One wheel cycle, from the platform's own cycle derivation: from the first option sold or share held until the symbol is flat. */
export interface BacktestCycle {
  symbol: string;
  /** In order of opening, from 1, per symbol. */
  cycleNumber: number;
  status: "open" | "closed";
  openedAt: string;
  closedAt: string | null;
  openedOn: string;
  closedOn: string | null;
  /** The first day a put of the cycle was assigned; null when none was. */
  assignedOn: string | null;
  /** Trading sessions from the assignment to the cycle's close; null while open or when no put was assigned. */
  recoverySessions: number | null;
  /** Open cycles: trading sessions from the assignment (else from the opening) to the session's last day. */
  ageSessions: number | null;
  totalDollars: number;
  netPremiumDollars: number;
  sharesHeld: number;
  breakEvenPerShare: number | null;
  /** An open cycle's cash break-even, as traded on the session's last day (cycleCashBreakEven.ts), read with the session; null otherwise. */
  cashBreakEvenPerShare?: number | null;
  /** An open cycle's shares at the last marks, as traded on the session's last day (sharesHeld is on the cycle's opening scale), read with the session; null otherwise. */
  sharesHeldNow?: number | null;
  /** An open cycle's free cash ÷ the account value at the session's last day's end, read with the session's detail; null otherwise. */
  freeCashShareNow?: number | null;
  /** A closed cycle's most shares held, as traded on the day it reached them (compared split-adjusted), read with the session's detail; null otherwise. */
  sharesHeldMost?: { shares: number; on: string } | null;
  /** A closed cycle's lowest free cash ÷ the account value, at each day's marks and after each of its looks (sessionFreeCash.ts), read with the session's detail; null otherwise. */
  freeCashShareLowest?: { share: number; on: string } | null;
  /** The cycle's session days with shares and no Call open, and its session days with shares (cycleNoCallDays.ts), read with the session's detail. */
  noCallDays?: { days: number; shareDays: number };
  /** leaps: absent on cycles stored before the LEAPS had a bucket of their own. */
  buckets: { csp: BacktestCycleBucket; unstructured: BacktestCycleBucket; cc: BacktestCycleBucket; hedge: BacktestCycleBucket; leaps?: BacktestCycleBucket };
  dataFlags: string[];
}

/**
 * One row of a cycle's timeline, from the platform's cycle derivation (src/lib/cycles.ts): a sale, buyback, assignment,
 * share hand-over between strategies or mark of what is still open, owned by one strategy. The rows' premium and stock
 * add up to the cycle's net premium and stock P&L, and per strategy to its buckets. Prices and shares are as traded on
 * the row's day; dollars are the same on any scale.
 */
export interface BacktestCycleTimelineRow {
  /** The instant; null for a mark row of what is still open. */
  at: string | null;
  /** The Eastern date of `at`, or a mark row's date. */
  tradingDate: string;
  label: string;
  bucket: keyof BacktestCycle["buckets"];
  instrument: "stock" | "option";
  /** Shares-equivalent (1 contract = 100). */
  quantity: number;
  strike: number | null;
  expiryDate: string | null;
  /** The stock price behind the row: an execution (a fill, an assignment at the strike), or a market close. */
  stockPrice: number | null;
  stockPriceSource: "execution" | "close" | null;
  commissionDollars: number | null;
  premiumDollars: number;
  stockDollars: number;
  /** A hedge option still held: its cost is the open mark's, not a realized loss. */
  unrealized: boolean;
  /**
   * A sold option's annualised yield as the engine recorded it at the sale (premiumYield: time value net of commission ÷
   * the capital ÷ the years to expiry), contract-weighted over the row's fills; added when the cycle is read, null when
   * the sale kept none (a session not run by the baseline). Absent on other rows.
   */
  premiumYield?: number | null;
  /** A sold option's delta as the engine recorded it at the sale (a put's negative), contract-weighted over the row's fills; null when none was kept. */
  delta?: number | null;
  /**
   * A hedge Put bought: its yearly cost as a fraction of the stock price (hedgePutCostYield), from what its purchase
   * recorded, contract-weighted over the row's fills; added when the cycle is read, null when the purchase kept no stock
   * price or days to expiry. Absent on other rows.
   */
  hedgeCostYield?: number | null;
  /**
   * An option sold while the cycle held shares: the cycle's cash break-even just before the sale (cycleCashBreakEven.ts),
   * added when the cycle is read; for a call on held shares under a break-even rule, the floor its strike was held to
   * (engine version 3 on). Null while no shares were held; absent on other rows.
   */
  breakEvenAtSale?: number | null;
  /**
   * Vol Farmer v2: the break-even of the position the sale was for, before its premium, as its sale recorded it: B-E¹ (the
   * first position's: its Calls, and the Puts whose strike it caps) and B-E² (the second's Calls); both for one Call order
   * the two shared. Absent on other sessions' rows and on sessions run before 2026-10-27.
   */
  positionBreakEvens?: { first: number | null; second: number | null };
  /**
   * Vol Farmer v2 with the Step at each Put sale: the Step the Put's strike was capped by, % below B-E¹, and the IV it came
   * from (null: no IV in the 10 sessions before, the fixed Step). Absent on other rows and on sessions run before 2026-10-27.
   */
  putStep?: { stepPct: number; impliedVolatility: number | null };
  /** The shares the cycle held once the row's moment (its look's orders, or the end's marks) was done, as traded on the row's day; added when the cycle is read. */
  sharesHeld?: number;
  /** A put sold as a rung of the ladder: the figures its sale recorded (null for any other put); absent on other rows. */
  ladderRung?: BacktestLadderRungRecord | null;
  /** Free cash ÷ the account value once the row's moment was done (sessionFreeCash.ts), the whole account's; null for a day not recorded; added when the cycle is read. */
  freeCashShare?: number | null;
  /** True on a row written at a Vol Farmer crossing (the stock reached the Call's strike and the position was unwound); absent otherwise; added when the cycle is read. */
  crossing?: boolean;
}

/**
 * A ladder put's rung as its sale recorded it, prices as traded that day (Marcelo 2026-10-21, the Wheel cycles' tooltip):
 * K_max = A − (A − F) × (U + Q) ÷ R0 (backtestBaselineLadder.ts), and the rung it reaches (ladderRungReached).
 */
export interface BacktestLadderRungRecord {
  rungNumber: number;
  rungs: number;
  /** (U + Q) ÷ (R0 ÷ rungs). */
  slices: number;
  /** K_max. */
  cap: number | null;
  /** A: the break-even, or with ladderTop "price" the lower of it and the price. */
  top: number | null;
  breakEven: number | null;
  /** F = the shares' average cost × (1 − S). */
  floor: number | null;
  averageCost: number | null;
  shock: number;
  /** U, Q, R0 and the base R0 is taken from, in dollars. */
  committed: number;
  rungCollateral: number;
  reserve: number;
  base: number;
  /**
   * Why the decision went as it did (Marcelo 2026-10-21, the tooltip's top): the call this rung was preferred to (null:
   * no call qualified), whether it came after the volume limit of the rung's puts before it, the rung's collateral left
   * before it (one contract fits a strike up to a hundredth of it), and its rank of the puts within the rules with the
   * best one's strike and yield.
   */
  callComparison?: { putYield: number; callYield: number; marginPct: number } | null;
  afterVolumeLimit?: boolean;
  collateralLeft?: number;
  saleYield?: number | null;
  rank?: number | null;
  eligibleCount?: number | null;
  bestStrike?: number | null;
  bestYield?: number | null;
}

/**
 * The days of a stretch on which each reason stopped a sale (Marcelo 2026-10-20): a day counts under every reason seen
 * at any of its looks, and as unrecorded when none was. Gaps: the Entry filters (extension z, IV Rank) and the entry
 * order's shortfalls (cash, volume, no candidate). Stock-only stretches: the calls' shortfalls (volume, no candidate) and a
 * ladder put sold instead of them.
 */
export interface BacktestNoSaleDays {
  extensionZ: number;
  ivRank: number;
  ladderPutInstead: number;
  cash: number;
  volume: number;
  noCandidate: number;
  unrecorded: number;
}

/**
 * Whole trading sessions with nothing sold where something was due: a symbol with no cycle open (a gap), or a cycle's
 * shares with no call on them. The stock move is C(last idle day) ÷ C(the session before the first idle day) − 1 on
 * IBKR's split-adjusted closes, null when a close is missing.
 */
export interface BacktestIdleStretch {
  /** Free cash ÷ the account value at its first day's 10:00 marks (sessionFreeCash.ts), added when read; absent where not read. */
  freeCashShareAtStart?: number | null;
  firstIdleDay: string;
  lastIdleDay: string;
  idleSessions: number;
  stockMove: number | null;
  noSaleDays: BacktestNoSaleDays;
  /** Why no contract qualified, on the idle days a look found none; null when none did (or on sessions run before it was kept). */
  noCandidate: BacktestNoCandidateDetail | null;
}

/** The baseline's contract checks, in the order it applies them: a contract drops out at the first it fails. */
export const backtestCandidateChecks = ["outsideExpiryRange", "spansEarnings", "belowCost", "aboveCeiling", "noUsableQuote", "spreadTooWide", "tooLittleVolume", "noImpliedVolatility", "outsideDeltaRange", "alreadyHeld", "noTimeValue", "belowMinimumYield", "noForecast", "belowVolatilityEdge"] as const;
export type BacktestCandidateCheck = (typeof backtestCandidateChecks)[number];

/**
 * A stretch's days on which a look found no contract within the rules (the day's first such look): on how many each check
 * left contracts out, and the first such day in full, each check with its rule then and the contracts it left out.
 */
export interface BacktestNoCandidateDetail {
  right: "C" | "P";
  days: number;
  daysByCheck: Partial<Record<BacktestCandidateCheck, number>>;
  firstDay: { date: string; lookTimeEt: string; checks: { check: BacktestCandidateCheck; rule: string; contracts: number }[] };
}

/** A stretch of a symbol with no cycle open: before its first cycle, between two, or after its last closed one to the session's end. */
export interface BacktestCycleGap extends BacktestIdleStretch {
  symbol: string;
  /** The cycle before the gap; null before the symbol's first cycle. */
  afterCycleNumber: number | null;
  /** The cycle after the gap; null after the last cycle. */
  beforeCycleNumber: number | null;
  /** The Entry filters' limits when they blocked an entry in the gap; null for a filter that did not. */
  entryFilterLimits: { extensionZ: number | null; ivRank: number | null };
}

/** A stretch of a cycle's sessions with shares held and no option open, put or call (shares as traded on its first day). */
export interface BacktestStockOnlyStretch extends BacktestIdleStretch {
  sharesHeld: number;
}

/** Why no Call was sold on some days of a No Call run. */
export interface BacktestNoCallReason {
  /** As a phrase: "no Call passed the hedge rule", "the volume limit", "no reason recorded". */
  reason: string;
  /** The run's days it was seen on; a day counts under every reason seen at any of its looks. */
  days: number;
  /** A Vol Farmer hedge-rule reason's figure on the first day it was seen: the shares' break-even under the rule where the look stated it, else what they cost. */
  figure: { kind: "breakEven" | "shareCost"; dollars: number } | null;
  /** A Vol Farmer reason: the look's note on the symbol on the first day it was seen, as written. */
  firstNote: { date: string; text: string } | null;
}

/** A run of a cycle's consecutive session days with shares and no Call open (cycleNoCallDays.ts): a No Call row of the Wheel cycles. */
export interface BacktestNoCallRun {
  firstDay: string;
  lastDay: string;
  sessions: number;
  /** Shares held as traded on the first day: the most at its start or its end. */
  sharesHeld: number;
  /** The run's days with a hedge Put held at any time. */
  hedgePutDays: number;
  /** Most days first. */
  reasons: BacktestNoCallReason[];
  /** Why no Call contract qualified, from the first stock-only stretch of the run with that detail; null otherwise. */
  noCandidate: BacktestNoCandidateDetail | null;
}

/** A cycle's detail, read when its row is opened; null for sessions run before cycles kept it. */
export interface BacktestCycleDetail {
  timeline: BacktestCycleTimelineRow[];
  stockOnlyStretches: BacktestStockOnlyStretch[];
  noCallRuns: BacktestNoCallRun[];
}

/** One source of the account's P&L (approved 2026-10-26). */
export interface BacktestPnlSource {
  pnlDollars: number;
  /** CAGR × pnlDollars ÷ the account's P&L: with interest and the Puts sold, the parts add up to the CAGR; null when the account made nothing. */
  cagrPart: number | null;
  /** The session's trading days on which it was held at any time ÷ all of them. */
  daysHeldShare: number;
}

/** The session tiles' Shares, Covered Calls, Hedge and LEAPS, the whole account's; null on a session without wheel cycles. */
export interface BacktestPnlSources {
  /** The account's P&L less its interest and every option's: what the shares made, sold and still held at the account's last marks; null when none were held. */
  shares: BacktestPnlSource | null;
  /** The Calls sold: premiums less buybacks and commissions, an open one at its last mark; with the median yearly yield recorded at each sale. */
  coveredCalls: (BacktestPnlSource & { quotedYieldMedian: number | null; quotedCount: number }) | null;
  /** The hedge Puts: what they were sold or settled for less their cost and commissions, an open one at its last mark; with the median yearly cost of each purchase (hedgePutCostYield). */
  hedge: (BacktestPnlSource & { quotedCostMedian: number | null; quotedCount: number }) | null;
  /** The Cash-Secured Puts sold: premiums less buybacks and commissions, an open one at its last mark; with the median yearly yield recorded at each sale. */
  cashSecuredPuts: (BacktestPnlSource & { quotedYieldMedian: number | null; quotedCount: number }) | null;
  /** Vol Farmer v2's LEAPS Calls: what they were sold or settled for less their cost and commissions, an open one at its last mark. */
  leaps: BacktestPnlSource | null;
}

/** Per-ticker figures over the session's positions, option sales and cycles. */
export interface BacktestTickerStatistics {
  symbol: string;
  /** Options sold: opening puts and calls and the new leg of each roll. */
  optionSaleCount: number;
  /** Mean calendar days to expiry of those sales. */
  averageTradedDte: number | null;
  putPositionCount: number;
  /** Put positions that have ended (assigned, expired, bought back or rolled). */
  putPositionsEnded: number;
  putPositionsAssigned: number;
  /** Assigned ÷ ended. */
  putAssignedShare: number | null;
  /** Realized P&L of every position on the ticker. */
  realizedPnlDollars: number;
  /** Realized plus what is still held at the session's last marks: the sum of its cycles' totals. */
  totalPnlDollars: number;
  closedCycleCount: number;
  openCycleCount: number;
  /** Closed cycles that had an assignment: their sessions from assignment to close. */
  recoverySessions: { count: number; mean: number | null; median: number | null; longest: number | null };
  /** Open cycles, listed apart. */
  openCycles: { symbol: string; cycleNumber: number; openedOn: string; assignedOn: string | null; ageSessions: number | null; totalDollars: number; sharesHeld: number }[];
}

export interface BacktestSessionDetail {
  session: BacktestSessionListItem & {
    settingsSnapshot: BacktestSettings;
    overrides: BacktestSettingsOverrides;
    /** What the win rate, the averages, edge capture and the accuracy table are measured on. */
    pnlBasis: BacktestPnlBasis;
    bookMode: BacktestBookMode;
    /** Each ticker's pot, weight and values in a "pots" session; null in a "shared_account" one. */
    symbolSettings: Record<string, BacktestSymbolSettings> | null;
    /** A "pots" session: how it was asked for (each ticker's lab values or the global ones; pots from a starting value split equally or not), for Run again; null on a "shared_account" one. */
    settingsSource: BacktestSettingsSource | null;
    potsFromStartingValue: boolean | null;
    /** A "pots" session: per ticker in its turn order, the looks and days at which the cash cut one of its orders; null in a "shared_account" one. */
    cashBoundBySymbol: { symbol: string; looks: number; days: number }[] | null;
    /** Buy and hold of the session's symbols, each with its pot ("pots") or in equal dollar parts, and of SPY: for comparison only. Neither counts dividends. */
    baselineMetrics: BacktestMetrics | null;
    baselineLabel: string;
    spyBaselineMetrics: BacktestMetrics | null;
    spyBaselineLabel: string;
    /** Splits of the session's symbols inside its period (prices were put on each day's traded scale); null before a run analysed any of them. */
    detectedSplits: (BacktestDetectedSplit & { symbol: string })[] | null;
    dataLastDate: string | null;
    error: string | null;
    finishedAt: string | null;
    /** What the run tells about the session as a whole: symbols without intraday quotes, checks that could not run, breaker trips. Empty before a run. */
    notes: string[];
    /** Null before a run, and on sessions run before looks were replayed. */
    runStatistics: BacktestRunStatistics | null;
  };
  job: BacktestJobView | null;
  days: BacktestSessionDay[];
  /** One row per option sold (an opening put or call, the new leg of a roll). */
  trades: BacktestTrade[];
  monthlyReturns: BacktestMonthlyReturn[];
  accuracyByMarginBand: BacktestAccuracyBand[];
  /** The simulated book: empty for sessions run before the wheel was simulated. */
  positions: BacktestPosition[];
  cycles: BacktestCycle[];
  /** Each symbol's stretches with no cycle open, oldest first; empty for sessions run before gaps were kept. */
  cycleGaps: BacktestCycleGap[];
  /** One row per symbol. */
  tickerStatistics: BacktestTickerStatistics[];
  /** The same figures over every symbol together (symbol "All symbols"); null when the session has no book. */
  allSymbolsStatistics: BacktestTickerStatistics | null;
  /** What the shares, the Covered Calls and the hedge each made, the whole account's, worked out when the session is read. */
  pnlSources: BacktestPnlSources | null;
  /** How many actions and fills the session stored; they are read page by page (BacktestActionsPage, BacktestFillsPage). */
  bookCounts: { filledActions: number; blockedActions: number; fills: number };
}

export interface BacktestCompareResponse {
  sessions: (BacktestSessionListItem & { overrides: BacktestSettingsOverrides; baselineMetrics: BacktestMetrics | null; spyBaselineMetrics: BacktestMetrics | null })[];
  /** Account value per day for each session id, plus "baseline:<sessionId>" curves for buy and hold of its symbols and "spy:<sessionId>" curves for buy and hold of SPY (one of each per distinct period and starting value). */
  curves: { key: string; label: string; points: { tradingDate: string; value: number }[] }[];
}
