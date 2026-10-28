import type { BacktestAction, BacktestBaselineSettings, BacktestBreakEvenLevel, BacktestLadderLevel, BacktestOrderShortfall, EffectiveBacktestSettings } from "../backtestTypes.js";
import type { BaselineNoCandidate, BaselineNoSaleReason } from "./baselineSaleSteps.js";
import type { BacktestBarHistory } from "./backtestBarHistory.js";
import type { HedgePutQuoteSource } from "./backtestBaselineHedge.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import type { BacktestDayMarket, BacktestTickerProfile } from "./backtestTickerInputs.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import type { VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import type { SimulatedLedger } from "./ledger/simulatedLedger.js";

// What one look of a backtest day hands a decision maker (the baseline wheel, the Steady Stake, the Vol Farmer, Vol Farmer
// v2) and what it answers. runBacktestSession.ts builds the look; each decision maker's own module decides it.
//
// Scales: a look's quotes are today's chain (prices, strikes and 100-share contracts as traded today); the ledger holds a
// symbol's open cycle on the scale of its first day. With r = F(cycle) ÷ F(today), a price goes to the ledger × r and a
// share count ÷ r, and comes back the other way. r is 1 unless a split fell inside the open cycle.

/** One symbol at a look: its day (the 10:00 capture and what was known that morning) and, after 10:00, the look's own quotes. */
export interface BacktestLookSymbol {
  profile: BacktestTickerProfile;
  /** The ticker's daily bars on today's traded scale. */
  bars: BacktestBarHistory;
  /** The 10:00 capture. */
  market: BacktestDayMarket;
  /** A look after 10:00: its quotes and the stock price then. Absent at the 10:00 look, which reads the capture. */
  intraday?: {
    quotes: readonly SymbolFileQuote[];
    stockPrice: number;
  };
  /** Today's cumulative split factor. */
  splitFactorToday: number;
  /** The session's next trading day's (today's on its last day): a split takes effect at that session when it differs. */
  splitFactorNextSession?: number;
  /** False when the open cycle spans a split whose contracts do not fit its share scale: no option order is simulated on the ticker until it ends. */
  optionContractsRepresentable: boolean;
  /** IBKR's split-adjusted daily closes before today, ascending. */
  adjustedDailyClosesBeforeToday: readonly { date: string; close: number }[];
  /** The look's long-dated Puts, for the baseline wheel's hedge and the Vol Farmer's; absent when the hedge is off. */
  hedgePutQuotes?: HedgePutQuoteSource;
  /** The 10:00 look's Calls of every listed expiry, for Vol Farmer v2's LEAPS; absent for every other decision maker. */
  leapsCallQuotes?: HedgePutQuoteSource;
}

/** One ticker of a session of per-ticker pots: its baseline settings (the session's with its own values) and its weight, its pot ÷ every pot. */
export interface BacktestTickerSetup {
  baseline: BacktestBaselineSettings;
  weight: number;
}

export interface BacktestLookContext {
  todayIso: string;
  /** The look's time, "HH:MM" Eastern; 10:00 when absent. */
  lookTimeEt?: string;
  /** The symbols at this look (those with a file day, a 10:00 stock price and, after 10:00, a price and the look's quotes), in the session's order. */
  symbols: readonly BacktestLookSymbol[];
  /** The sector of every symbol of the session, at this look or not. */
  sectorBySymbol: ReadonlyMap<string, string | null>;
  calendar: BacktestTradingCalendar;
  settings: EffectiveBacktestSettings;
  /** A session of per-ticker pots: each ticker's own baseline settings and its weight. Absent when the tickers share one account and the session's settings. */
  tickerSetupBySymbol?: ReadonlyMap<string, BacktestTickerSetup>;
  /** The volatility model's tables of the day (walk-forward or current): the baseline's Edge Yield ranking and volatility edge filter read them. */
  modelTables: VolatilityModelTables;
  ledger: SimulatedLedger;
  /** The session day before today; null on the first. */
  previousSessionDateIso: string | null;
  /** The 10:00 mark per share of every open leg, on its cycle's scale. The look adds the legs it opens. */
  priceByLegId: Map<string, number>;
  nextActionId(): string;
  /** Today's place among the session's days, 0 on its first: Vol Farmer v2's tickers take turns by it. */
  sessionDayIndex?: number;
}

/** One option sold in the look, as traded: what the session's per-option trade row is built from. */
export interface BacktestOptionSale {
  legId: string;
  actionId: string;
  symbol: string;
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
  exposureDollars: number;
  dte: number;
  delta: number | null;
  /** The Signals model's figures, kept on the trade rows of the sessions the rules ran; null for every sale now. */
  grade: string | null;
  edgeMargin: number | null;
  expectedPnlDollars: number | null;
  calibratedExpectedPnlDollars: number | null;
  edgeYield: number | null;
  histYield: number | null;
  kellyContracts: number | null;
  stressContracts: number | null;
  /** r on the opening day: the ledger's prices ÷ this are the prices as traded that day. */
  priceToCycleScale: number;
}

export interface BacktestLookResult {
  /** Filled and refused, in order. */
  actions: BacktestAction[];
  optionSales: BacktestOptionSale[];
  /** One line on the look: what was done, or why nothing was, symbol by symbol, then where opens were stopped. */
  summary: string;
  /** The same without where opens were stopped, and those apart: a day of several looks says each once. */
  summaryOfActions: string;
  opensStopped: string[];
  /** The baseline: its orders that left contracts unsold. */
  shortfalls?: BacktestOrderShortfall[];
  /** The baseline: the put ladder's levels at this look, per symbol whose cycle holds shares. */
  ladderLevels?: BacktestLadderLevel[];
  /** Vol Farmer v2: both positions' break-evens after the look, per symbol whose cycle holds shares. */
  breakEvenLevels?: BacktestBreakEvenLevel[];
  /** The baseline: sales that were due and not made for a reason the shortfalls do not hold. */
  noSaleNotes?: BacktestNoSaleNote[];
  /** The baseline: orders that found no contract within the rules, with what each check left out. */
  noCandidateNotes?: BacktestNoCandidateNote[];
}

/** An order of a look that found no contract within the rules (BaselineNoCandidate), recorded only: the Wheel cycles' explanation. */
export type BacktestNoCandidateNote = BaselineNoCandidate & { tradingDate: string; lookTimeEt: string; symbol: string };

/** A look that sold nothing where a sale was due (BaselineNoSaleReason), recorded only: the Wheel cycles' gaps and uncovered stretches read it. */
export interface BacktestNoSaleNote {
  tradingDate: string;
  symbol: string;
  reason: BaselineNoSaleReason;
  /** "entry_filter": each filter's limit when it blocked, null for one that did not. */
  entryFilterLimits: { extensionZ: number | null; ivRank: number | null } | null;
}
