import type { PlutoSettings } from "../pluto/settingsStore.js";
import type { TradingSettings } from "../lib/tradingSettingsStore.js";
import type { LlmSessionEstimate } from "./llm/estimateLlmSession.js";
import type { OpenCandidateRanking } from "../lib/signalCandidates.js";
import type { KellyEdgeBasis } from "../pluto/postModelGates.js";
import type { LadderLevels } from "./engine/backtestBaselineLadder.js";

// The backtesting API contract (docs/backtesting/). The app mirrors these types in src/api/backtest.ts.

export type BacktestJobKind = "download" | "backtest" | "analysis";
export type BacktestJobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
/** What the screen shows: a running job with a heartbeat older than 60 s is "stopped". */
export type BacktestJobDisplayStatus = BacktestJobStatus | "stopped";
export type BacktestTablesMode = "walk_forward" | "current";

/**
 * Who makes the choices the AI model makes live: the stand-in rules (BacktestPolicySettings), or the model itself (Claude
 * through the subscription, src/backtest/llm/). "baseline": none of Pluto or Signals, the naive wheel of
 * BacktestBaselineSettings (Marcelo 2026-10-13), to measure what each rule adds.
 */
export type BacktestDecisionMaker = "rules" | "llm" | "baseline";

/**
 * The naive wheel (approved by Marcelo 2026-10-13; the research log has the full rules). At every look: free round lots of
 * shares get the call with the highest premium yield in the delta and expiry ranges; free cash goes into the entry (a
 * cash-secured put, or 100 shares bought with a call sold on them) with the highest premium yield in the same ranges.
 * Everything is held to expiry: no buybacks, rolls, closes, stops, breakers or Signals.
 */
export interface BacktestBaselineSettings {
  /** How free cash enters a stock: a cash-secured put, or a Covered Call entry. */
  entry: "put" | "covered_call";
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
}

/**
 * The engine's version, stored on each session it runs (backtest_sessions.engine_version): raised whenever a stored
 * session's settings would give different results, so the ticker analysis compares only same-engine runs. A new setting
 * whose default keeps the results does not raise it. 1: the engine as of 3020323 (2026-10-15). 2: max per ticker and max
 * per sector are shares of the capital budget, not of the account (2026-10-16). 3: a call's break-even floor is the
 * cycle's cash break-even, counting what shares that left the cycle brought in (2026-10-20).
 */
export const backtestEngineVersion = 3;

export const defaultBacktestBaselineSettings: BacktestBaselineSettings = { entry: "put", minAbsDelta: 0.05, maxAbsDelta: 0.6, minDte: 1, maxDte: 45, maxSpreadPctOfMid: 15, callStrike: "delta_range", entryCallStrike: "any", entryWhenSharesUncovered: "wait", maxSharesPctOfAccount: 100, minCallYieldPct: 0, minCallYieldAppliesTo: "every_call", putsWhenNoCall: "off", ladderSharesPct: 50, ladderRungs: 5, ladderShock: "history", ladderShockPct: 70, ladderShockMinPct: 60, ladderShockMaxPct: 80, ladderShockNoHistoryPct: 90, ladderShockLookbackYears: 10, ladderTop: "break_even", ladderPace: "any_look", ladderPutVersusCall: "call_first", ladderPutYieldMarginPct: 0, ladderPutDeltaRange: "delta_range", dayValueOptions: "marked", callDeltaRange: "entry_range", callMinAbsDelta: 0.05, callMaxAbsDelta: 0.6, takeProfitPct: 0, shareStopLossPct: 0, earnings: "ignore", maxAccountPctPerStock: 100, looks: "every_look", volatilityEdgeFilter: "off", minVolatilityEdgePoints: 0, entryExtensionFilter: "off", entryMaxExtensionZ: 1, entryIvRankFilter: "off", entryMaxIvRank: 80, ranking: "premium_yield", expiryChoice: "any_in_range", coverage: "best_contract" };

/**
 * The stand-in for the AI model's choices (docs/backtesting/FULL-FIDELITY-DESIGN.md §5). Everything else in a pass is
 * Pluto's own code. A pass considers closes first, then rolls, then opens, and takes at most one action; an open is
 * always Pluto's own top pick (Edge Yield, then Edge $).
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
 * The Signals model's parameters a session may change (Marcelo 2026-10-13); live always runs on the defaults. They change
 * the model's figures and Pluto's use of them, never the fills (trading.spreadCostChargedPct prices every fill).
 */
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
}

/** Live's values (volatilityEdge.ts, contractValuation.ts, signalCandidates.ts, postModelGates.ts, impliedVolatilitySurface.ts). */
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
}

export interface BacktestSettingsOverrides {
  pluto?: Partial<PlutoSettings>;
  trading?: Partial<Omit<TradingSettings, "commissionEstimator">>;
  kellyFraction?: number;
  policy?: Partial<BacktestPolicySettings>;
  decisionMaker?: BacktestDecisionMaker;
  model?: Partial<BacktestModelSettings>;
  baseline?: Partial<BacktestBaselineSettings>;
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

/** One row of the New session settings table. `path` addresses the value inside BacktestSettings, e.g. "pluto.minEdgeYieldPct" or "policy.roll". */
export type BacktestSettingGroup =
  | "How the session runs"
  | "Put ladder"
  | "Calls and Covered Calls"
  | "Contract choice"
  | "Entry filters"
  | "Exits"
  | "Capital and sizing"
  | "Candidate quality"
  | "Model"
  | "System checks"
  | "Rules' choices";

/** "baseline_wheel": rows a Baseline wheel session (the CC + Put Ladder) reads, some shared with the rules and the AI model;
 *  "pluto_rules": rows only the rules and the AI model read. */
export type BacktestSettingSection = "baseline_wheel" | "pluto_rules";

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
  /** `path` addresses e.g. "pluto.minEdgeYieldPct", "policy.roll" or "model.forecastWindowDays". */
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
  /** With the AI model as decision maker: how many calls and how many hours of model time the session may take (an upper bound); null with the rules. */
  llmEstimate: LlmSessionEstimate | null;
  /** Each ticker's pot, weight and values with where each came from ("pots"); null when the tickers share the session's settings. */
  resolvedBySymbol: Record<string, BacktestSymbolSettings> | null;
}

/**
 * What POST /backtest/sessions/estimate answers: the create route's checks and resolution, nothing created. A request
 * whose only problems are tickers' values still answers here (each ticker with its problems); any other problem is a 400.
 */
export interface BacktestSessionEstimateResponse {
  warnings: string[];
  llmEstimate: LlmSessionEstimate | null;
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
   * default pot. Required with the rules or the AI model.
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
  /** One run with the AI model deciding: its estimate; null otherwise. */
  llmEstimate: LlmSessionEstimate | null;
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
  /** LLM mode only: the decisions asked of the model, and how many the cache answered. */
  llmCalls?: { asked: number; fromCache: number };
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
  strategyKey: "cash_secured_put" | "covered_call" | "unstructured";
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

export type BacktestActionKind = "open_cash_secured_put" | "open_covered_call" | "roll" | "close_shares" | "close_leg" | "close_position";

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
  buckets: { csp: BacktestCycleBucket; unstructured: BacktestCycleBucket; cc: BacktestCycleBucket; hedge: BacktestCycleBucket };
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
}

/**
 * The days of a stretch on which each reason stopped a sale (Marcelo 2026-10-20): a day counts under every reason seen
 * at any of its looks, and as unrecorded when none was. Gaps: the Entry filters (extension z, IV Rank) and the entry
 * order's shortfalls (cash, volume, no candidate). Uncovered shares: the calls' shortfalls (volume, no candidate) and a
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

/** A stretch of a cycle's sessions with shares held and no call on some of them (as traded on its first day). */
export interface BacktestUncoveredStretch extends BacktestIdleStretch {
  sharesUncovered: number;
  sharesHeld: number;
}

/** A cycle's detail, read when its row is opened; null for sessions run before cycles kept it. */
export interface BacktestCycleDetail {
  timeline: BacktestCycleTimelineRow[];
  uncoveredStretches: BacktestUncoveredStretch[];
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
  /** How many actions and fills the session stored; they are read page by page (BacktestActionsPage, BacktestFillsPage). */
  bookCounts: { filledActions: number; blockedActions: number; fills: number };
}

export interface BacktestCompareResponse {
  sessions: (BacktestSessionListItem & { overrides: BacktestSettingsOverrides; baselineMetrics: BacktestMetrics | null; spyBaselineMetrics: BacktestMetrics | null })[];
  /** Account value per day for each session id, plus "baseline:<sessionId>" curves for buy and hold of its symbols and "spy:<sessionId>" curves for buy and hold of SPY (one of each per distinct period and starting value). */
  curves: { key: string; label: string; points: { tradingDate: string; value: number }[] }[];
}
