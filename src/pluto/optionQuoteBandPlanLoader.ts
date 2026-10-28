import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { loadStoredOptionChain, type StoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { loadOpenDaysBetween, loadTradingSessionsBetween } from "../lib/marketSessionStatus.js";
import { loadLastSeenImpliedVolatilityByContract, loadSessionVolumeByContract } from "../lib/optionSessionVolumeStore.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { addCalendarDays } from "../lib/calendarDays.js";
import type { MarketQuoteConsumer } from "../lib/marketQuoteLoop.js";
import { yearsToSessionClose } from "../lib/quoteOwnDelta.js";
import { loadOptionQuoteBandQuotes, upsertOptionQuoteBandQuotes, type OptionQuoteBandQuote, type OptionQuoteBandQuoteWrite } from "./optionQuoteBandQuotes.js";
import { optionQuoteBandDayUniverse, planOptionQuoteBand, type OptionQuoteBandPlan, type LadderClock, type OptionQuoteBandScope, type OptionQuoteBandUniverseContract } from "./optionQuoteBandPlan.js";
import { forwardAnchorsFromBandQuotes } from "./ladderForwardAnchors.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadPlutoState } from "./stateStore.js";
import { effectivePlutoStrategy, loadEnabledPlutoTickerSettings, type PlutoStrategy, type PlutoTickerSettings } from "./tickerSettingsStore.js";

// The option quote band's inputs for the market quote loop (optionQuoteBandPlan.ts). The day's part (universe, last night's
// IVs, the clock) is read once per trading day and ticker (again when its strategy changes); the forwards once the band has
// quotes; the band quotes and the price per cycle.

/** What a ticker's band covers under its strategy (optionQuoteBandPlan.ts): the after-close volume capture covers the same. */
export function optionQuoteBandScopeOf(ticker: PlutoTickerSettings, settings: PlutoSettings): OptionQuoteBandScope {
  if (effectivePlutoStrategy(ticker) === "vol_farmer_v2") return { expiryRule: { kind: "next_listed_expiry" }, callDeltaRange: { minAbsDelta: settings.volFarmerV2CallMinAbsDelta, maxAbsDelta: settings.volFarmerV2CallMaxAbsDelta } };
  return {
    expiryRule: { kind: "days_to_expiry_range", minDte: settings.ladderMinDte, maxDte: settings.ladderMaxDte },
    callDeltaRange: { minAbsDelta: ticker.ladderMinAbsDelta ?? settings.ladderMinAbsDelta, maxAbsDelta: ticker.ladderMaxAbsDelta ?? settings.ladderMaxAbsDelta },
  };
}

export interface OptionQuoteBandTicker {
  tickerId: string;
  symbol: string;
}

export interface OptionQuoteBandPlanner {
  /** The tickers whose band the loop quotes today: Pluto's enabled tickers, under either strategy, while Pluto is not paused. */
  tickers(tradingDateIso: string): Promise<OptionQuoteBandTicker[]>;
  /** Each ticker's contracts for this cycle, at its live price; a ticker without a price is left out. */
  plan(tradingDateIso: string, spotByTicker: ReadonlyMap<string, number | null>, now: Date): Promise<Map<string, OptionQuoteBandTicker & { plan: OptionQuoteBandPlan }>>;
}

interface TickerDay {
  universe: OptionQuoteBandUniverseContract[];
  overnightImpliedVolatilityByContract: Map<string, number>;
  /** Empty until the band has quotes today (read again each cycle until then). */
  anchors: Map<string, BaselineForwardAnchor>;
  /** The strategy the universe was built for. */
  strategy: PlutoStrategy;
  callDeltaRange: OptionQuoteBandScope["callDeltaRange"];
}

export interface OptionQuoteBandPlannerDependencies {
  loadSettings(): Promise<PlutoSettings>;
  /** True while Pluto is paused: the band is not quoted then. */
  loadPaused(): Promise<boolean>;
  loadEnabledTickers(): Promise<PlutoTickerSettings[]>;
  loadChain(tickerId: string): Promise<StoredOptionChain>;
  loadPreviousSessionVolume(tickerId: string, tradingDateIso: string): Promise<Map<string, number> | null>;
  loadOvernightImpliedVolatility(tickerId: string, tradingDateIso: string): Promise<Map<string, number>>;
  /** Today's forwards by expiry from the band's own quotes (forward and the stock price at the quote); empty before the band has quotes. */
  loadForwardAnchors(tickerId: string, tradingDateIso: string): Promise<Map<string, BaselineForwardAnchor>>;
  loadClock(tradingDateIso: string): Promise<LadderClock>;
  loadBandQuotes(tickerId: string, tradingDateIso: string): Promise<OptionQuoteBandQuote[]>;
}

export const defaultOptionQuoteBandPlannerDependencies: OptionQuoteBandPlannerDependencies = {
  loadSettings: () => loadPlutoSettings(),
  loadPaused: async () => (await loadPlutoState()).paused,
  loadEnabledTickers: () => loadEnabledPlutoTickerSettings(),
  loadChain: loadStoredOptionChain,
  loadPreviousSessionVolume: async (tickerId, tradingDateIso) => {
    const openDays = await loadOpenDaysBetween(addCalendarDays(tradingDateIso, -14), addCalendarDays(tradingDateIso, -1));
    const previousSession = openDays[openDays.length - 1];
    return previousSession === undefined ? null : loadSessionVolumeByContract(tickerId, previousSession);
  },
  loadOvernightImpliedVolatility: (tickerId, tradingDateIso) => loadLastSeenImpliedVolatilityByContract(tickerId, tradingDateIso),
  loadForwardAnchors: async (tickerId, tradingDateIso) => {
    const [quotes, sessions, riskFreeRate] = await Promise.all([loadOptionQuoteBandQuotes(tickerId, tradingDateIso), loadTradingSessionsBetween(tradingDateIso, tradingDateIso), getRiskFreeRate()]);
    if (quotes.length === 0 || riskFreeRate === null) return new Map();
    return forwardAnchorsFromBandQuotes(quotes, { todayIso: tradingDateIso, yearsToTodaysClose: yearsToSessionClose(new Date(), sessions[0]?.closeMinutesEt ?? 16 * 60), riskFreeRate });
  },
  loadClock: async (tradingDateIso) => {
    const [session] = await loadTradingSessionsBetween(tradingDateIso, tradingDateIso);
    const riskFreeRate = await getRiskFreeRate();
    if (!session) throw new Error(`${tradingDateIso} is not a trading session in the market calendar`);
    if (riskFreeRate === null) throw new Error("no risk-free rate available");
    return { todayIso: tradingDateIso, closeMinutesEt: session.closeMinutesEt, riskFreeRate };
  },
  loadBandQuotes: loadOptionQuoteBandQuotes,
};

export function createOptionQuoteBandPlanner(dependencies: OptionQuoteBandPlannerDependencies = defaultOptionQuoteBandPlannerDependencies): OptionQuoteBandPlanner {
  let day: { tradingDateIso: string; clock: LadderClock; byTicker: Map<string, TickerDay> } | null = null;

  const ladderTickers = async (): Promise<{ settings: PlutoSettings; tickers: PlutoTickerSettings[] }> => {
    const settings = await dependencies.loadSettings();
    const active = !(await dependencies.loadPaused());
    return { settings, tickers: active ? await dependencies.loadEnabledTickers() : [] };
  };

  const tickerDay = async (ticker: PlutoTickerSettings, settings: PlutoSettings, tradingDateIso: string): Promise<TickerDay> => {
    const cached = day!.byTicker.get(ticker.tickerId);
    const strategy = effectivePlutoStrategy(ticker);
    const scope = optionQuoteBandScopeOf(ticker, settings);
    if (cached && cached.strategy === strategy) {
      if (cached.anchors.size === 0) cached.anchors = await dependencies.loadForwardAnchors(ticker.tickerId, tradingDateIso);
      cached.callDeltaRange = scope.callDeltaRange;
      return cached;
    }
    const [chain, volume, overnight, anchors] = await Promise.all([
      dependencies.loadChain(ticker.tickerId),
      dependencies.loadPreviousSessionVolume(ticker.tickerId, tradingDateIso),
      dependencies.loadOvernightImpliedVolatility(ticker.tickerId, tradingDateIso),
      dependencies.loadForwardAnchors(ticker.tickerId, tradingDateIso),
    ]);
    // No volume captured for the previous session: every volume is unknown and the 20% rule sells nothing, so nothing is quoted.
    const universe = volume === null ? [] : optionQuoteBandDayUniverse({ expirations: chain.expirations, strikesByExpiry: chain.strikesByExpiry, sessionIso: tradingDateIso, expiryRule: scope.expiryRule, previousSessionVolumeByContract: volume });
    const entry: TickerDay = { universe, overnightImpliedVolatilityByContract: overnight, anchors, strategy, callDeltaRange: scope.callDeltaRange };
    day!.byTicker.set(ticker.tickerId, entry);
    return entry;
  };

  return {
    async tickers() {
      const { tickers } = await ladderTickers();
      return tickers.map((ticker) => ({ tickerId: ticker.tickerId, symbol: ticker.symbol }));
    },
    async plan(tradingDateIso, spotByTicker, now) {
      const { settings, tickers } = await ladderTickers();
      const plans = new Map<string, OptionQuoteBandTicker & { plan: OptionQuoteBandPlan }>();
      if (tickers.length === 0) return plans;
      if (day?.tradingDateIso !== tradingDateIso) day = { tradingDateIso, clock: await dependencies.loadClock(tradingDateIso), byTicker: new Map() };
      const clock = day.clock;
      await Promise.all(
        tickers.map(async (ticker) => {
          const stockPrice = spotByTicker.get(ticker.tickerId) ?? null;
          if (stockPrice === null || !(stockPrice > 0)) return;
          const [inputs, todaysQuotes] = await Promise.all([tickerDay(ticker, settings, tradingDateIso), dependencies.loadBandQuotes(ticker.tickerId, tradingDateIso)]);
          plans.set(ticker.tickerId, { tickerId: ticker.tickerId, symbol: ticker.symbol, plan: planOptionQuoteBand({ ...inputs, todaysQuotes, clock, now, stockPrice }) });
        }),
      );
      return plans;
    },
  };
}

/** Band quotes are written in batches of this many as they settle, and the rest at the end of the cycle. */
const bandQuoteWriteBatchSize = 20;

/** The ladder as a user of the market quote loop (server.ts wires it in first, so its band is quoted first). */
export function createLadderQuoteConsumer(planner: OptionQuoteBandPlanner = createOptionQuoteBandPlanner(), store: (writes: OptionQuoteBandQuoteWrite[]) => Promise<void> = upsertOptionQuoteBandQuotes): MarketQuoteConsumer {
  let buffer: OptionQuoteBandQuoteWrite[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await store(batch);
  };
  return {
    name: "CC + Put Ladder",
    tickers: (tradingDateIso) => planner.tickers(tradingDateIso),
    async contracts(cycle) {
      const plans = await planner.plan(cycle.tradingDateIso, cycle.spotByTicker, cycle.now);
      return [...plans.values()].flatMap((entry) => entry.plan.contracts.map((contract) => ({ tickerId: entry.tickerId, symbol: entry.symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right })));
    },
    onQuote(quote, cycle) {
      buffer.push({ tickerId: quote.contract.tickerId, tradingDateIso: cycle.tradingDateIso, expiry: quote.contract.expiry, strike: quote.contract.strike, right: quote.contract.right, bid: quote.bid, ask: quote.ask, stockPrice: cycle.spotByTicker.get(quote.contract.tickerId) ?? null, errorCode: quote.errorCode, quotedAt: quote.quotedAt, cycleNumber: cycle.cycleNumber });
      if (buffer.length >= bandQuoteWriteBatchSize) void flush().catch((error) => console.error(`option quote band write failed — ${error instanceof Error ? error.message : error}`));
    },
    onCycleComplete: () => flush(),
  };
}
