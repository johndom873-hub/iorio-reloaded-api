import type { BaselineForwardAnchor } from "../backtest/engine/baselineSaleSteps.js";
import { loadStoredOptionChain, type StoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { loadOpenDaysBetween, loadTradingSessionsBetween } from "../lib/marketSessionStatus.js";
import { loadLastSeenImpliedVolatilityByContract, loadSessionVolumeByContract } from "../lib/optionSessionVolumeStore.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { addCalendarDays } from "../lib/signalsRoadmap.js";
import { loadLatestSnapshot, loadSlices } from "../lib/signalsStore.js";
import type { DayLoopLadderBand } from "../lib/daySignalsLoop.js";
import { loadLadderBandQuotes, upsertLadderBandQuotes, type LadderBandQuote } from "./ladderBandQuotes.js";
import { ladderDayUniverse, planLadderBand, type LadderBandPlan, type LadderClock, type LadderUniverseContract } from "./ladderBandPlan.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadEnabledPlutoTickerSettings, type PlutoTickerSettings } from "./tickerSettingsStore.js";

// The ladder band's inputs for the Day Signals loop (ladderBandPlan.ts). The day's part (universe, last night's IVs,
// Pluto's 10:00 forwards, the clock) is read once per trading day and ticker; the band quotes and the price per cycle.

export interface LadderBandTicker {
  tickerId: string;
  symbol: string;
}

export interface LadderBandPlanner {
  /** The tickers whose band the loop quotes today: Pluto's enabled tickers while the CC + Put Ladder is the active strategy. */
  tickers(tradingDateIso: string): Promise<LadderBandTicker[]>;
  /** Each ladder ticker's contracts for this cycle, at its live price; a ticker without a price is left out. */
  plan(tradingDateIso: string, spotByTicker: ReadonlyMap<string, number | null>, now: Date): Promise<Map<string, LadderBandTicker & { plan: LadderBandPlan }>>;
}

interface TickerDay {
  universe: LadderUniverseContract[];
  overnightImpliedVolatilityByContract: Map<string, number>;
  /** Empty until today's fit exists (read again each cycle until then). */
  anchors: Map<string, BaselineForwardAnchor>;
  deltaRange: Pick<PlutoSettings, "ladderMinAbsDelta" | "ladderMaxAbsDelta">;
}

export interface LadderBandPlannerDependencies {
  loadSettings(): Promise<PlutoSettings>;
  loadEnabledTickers(): Promise<PlutoTickerSettings[]>;
  loadChain(tickerId: string): Promise<StoredOptionChain>;
  loadPreviousSessionVolume(tickerId: string, tradingDateIso: string): Promise<Map<string, number> | null>;
  loadOvernightImpliedVolatility(tickerId: string, tradingDateIso: string): Promise<Map<string, number>>;
  /** Today's 10:00 forwards by expiry (forward and the stock price it was fitted at); empty before today's fit. */
  loadForwardAnchors(tickerId: string, tradingDateIso: string): Promise<Map<string, BaselineForwardAnchor>>;
  loadClock(tradingDateIso: string): Promise<LadderClock>;
  loadBandQuotes(tickerId: string, tradingDateIso: string): Promise<LadderBandQuote[]>;
}

export const defaultLadderBandPlannerDependencies: LadderBandPlannerDependencies = {
  loadSettings: () => loadPlutoSettings(),
  loadEnabledTickers: () => loadEnabledPlutoTickerSettings(),
  loadChain: loadStoredOptionChain,
  loadPreviousSessionVolume: async (tickerId, tradingDateIso) => {
    const openDays = await loadOpenDaysBetween(addCalendarDays(tradingDateIso, -14), addCalendarDays(tradingDateIso, -1));
    const previousSession = openDays[openDays.length - 1];
    return previousSession === undefined ? null : loadSessionVolumeByContract(tickerId, previousSession);
  },
  loadOvernightImpliedVolatility: (tickerId, tradingDateIso) => loadLastSeenImpliedVolatilityByContract(tickerId, tradingDateIso),
  loadForwardAnchors: async (tickerId, tradingDateIso) => {
    const snapshot = await loadLatestSnapshot(tickerId);
    if (!snapshot || snapshot.tradingDateIso !== tradingDateIso || snapshot.fitCompletedAt === null) return new Map();
    const anchors = new Map<string, BaselineForwardAnchor>();
    for (const slice of await loadSlices(snapshot.snapshotId)) {
      const spotPrice = slice.fitUnderlyingPrice ?? snapshot.underlyingPrice;
      if (spotPrice !== null && spotPrice > 0 && slice.forwardPrice > 0) anchors.set(slice.expiry, { forward: slice.forwardPrice, spotPrice });
    }
    return anchors;
  },
  loadClock: async (tradingDateIso) => {
    const [session] = await loadTradingSessionsBetween(tradingDateIso, tradingDateIso);
    const riskFreeRate = await getRiskFreeRate();
    if (!session) throw new Error(`${tradingDateIso} is not a trading session in the market calendar`);
    if (riskFreeRate === null) throw new Error("no risk-free rate available");
    return { todayIso: tradingDateIso, closeMinutesEt: session.closeMinutesEt, riskFreeRate };
  },
  loadBandQuotes: loadLadderBandQuotes,
};

export function createLadderBandPlanner(dependencies: LadderBandPlannerDependencies = defaultLadderBandPlannerDependencies): LadderBandPlanner {
  let day: { tradingDateIso: string; clock: LadderClock; byTicker: Map<string, TickerDay> } | null = null;

  const ladderTickers = async (): Promise<{ settings: PlutoSettings; tickers: PlutoTickerSettings[] }> => {
    const settings = await dependencies.loadSettings();
    return { settings, tickers: settings.executionStrategy === "cc_put_ladder" ? await dependencies.loadEnabledTickers() : [] };
  };

  const tickerDay = async (ticker: PlutoTickerSettings, settings: PlutoSettings, tradingDateIso: string): Promise<TickerDay> => {
    const cached = day!.byTicker.get(ticker.tickerId);
    const deltaRange = { ladderMinAbsDelta: ticker.ladderMinAbsDelta ?? settings.ladderMinAbsDelta, ladderMaxAbsDelta: ticker.ladderMaxAbsDelta ?? settings.ladderMaxAbsDelta };
    if (cached) {
      if (cached.anchors.size === 0) cached.anchors = await dependencies.loadForwardAnchors(ticker.tickerId, tradingDateIso);
      cached.deltaRange = deltaRange;
      return cached;
    }
    const [chain, volume, overnight, anchors] = await Promise.all([
      dependencies.loadChain(ticker.tickerId),
      dependencies.loadPreviousSessionVolume(ticker.tickerId, tradingDateIso),
      dependencies.loadOvernightImpliedVolatility(ticker.tickerId, tradingDateIso),
      dependencies.loadForwardAnchors(ticker.tickerId, tradingDateIso),
    ]);
    // No volume captured for the previous session: every volume is unknown and the 20% rule sells nothing, so nothing is quoted.
    const universe = volume === null ? [] : ladderDayUniverse({ expirations: chain.expirations, strikesByExpiry: chain.strikesByExpiry, todayIso: tradingDateIso, settings, previousSessionVolumeByContract: volume });
    const entry: TickerDay = { universe, overnightImpliedVolatilityByContract: overnight, anchors, deltaRange };
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
      const plans = new Map<string, LadderBandTicker & { plan: LadderBandPlan }>();
      if (tickers.length === 0) return plans;
      if (day?.tradingDateIso !== tradingDateIso) day = { tradingDateIso, clock: await dependencies.loadClock(tradingDateIso), byTicker: new Map() };
      const clock = day.clock;
      await Promise.all(
        tickers.map(async (ticker) => {
          const stockPrice = spotByTicker.get(ticker.tickerId) ?? null;
          if (stockPrice === null || !(stockPrice > 0)) return;
          const [inputs, todaysQuotes] = await Promise.all([tickerDay(ticker, settings, tradingDateIso), dependencies.loadBandQuotes(ticker.tickerId, tradingDateIso)]);
          plans.set(ticker.tickerId, { tickerId: ticker.tickerId, symbol: ticker.symbol, plan: planLadderBand({ ...inputs, todaysQuotes, clock, now, stockPrice }) });
        }),
      );
      return plans;
    },
  };
}

/** The ladder's band as the Day Signals loop takes it (server.ts wires it in). */
export function createDayLoopLadderBand(planner: LadderBandPlanner = createLadderBandPlanner()): DayLoopLadderBand {
  return {
    tickers: (tradingDateIso) => planner.tickers(tradingDateIso),
    contractsFor: async (tradingDateIso, spotByTicker, now) => new Map([...(await planner.plan(tradingDateIso, spotByTicker, now))].map(([tickerId, entry]) => [tickerId, { symbol: entry.symbol, contracts: entry.plan.contracts }])),
    store: (writes) => upsertLadderBandQuotes(writes),
  };
}
