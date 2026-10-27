import { formatExpiryAsIsoDate } from "./expiryFormat.js";
import { loadStoredOptionChain, type StoredOptionChain } from "../ibkr/fetchOptionChain.js";
import { blackScholesDelta } from "./impliedVolatilitySurface.js";
import type { MarketQuoteConsumer, QuoteLoopContract, QuoteLoopCycle } from "./marketQuoteLoop.js";
import { loadTradingSessionsBetween } from "./marketSessionStatus.js";
import { calendarDaysUntilExpiry } from "./optionChainCaptureWindow.js";
import { loadOptionDataUniverse, type OptionDataTicker } from "./optionDataUniverse.js";
import { yearsToSessionClose } from "./quoteOwnDelta.js";
import { getRiskFreeRate } from "./riskFreeRate.js";
import { activeVolatilityBands, recordLiveCallQuote, recordLiveStock, type DeltaBand } from "./volatilityLive.js";
import { loadCloseImpliedVolatilities } from "./volatilityScreen.js";

// The market quote loop's Volatility user (Marcelo 2026-10-27): while a Volatility screen or Pulse is open (a band is
// wanted, volatilityLive.ts), every option-data ticker's stock is quoted with IBKR's 30-day IV, and per expiry out to
// volatilityMaximumDaysToExpiry the 2 Calls nearest each wanted band's Delta max: the highest strike estimated at or
// under it and the next one below. Within an expiry a Call's yield rises with its delta, so the best Call in a band sits
// at its top edge (checked on 14 days of staging chains 2026-10-27: 99% at Delta max 0.50, the misses being junk quotes).
// The estimate is Black-Scholes on the forward spot × e^(rT) at the 30-day IV; the screen judges each quote by its own delta.

export const volatilityMaximumDaysToExpiry = 45;

export interface VolatilityConsumerDependencies {
  activeBands(): DeltaBand[];
  loadTickers(): Promise<OptionDataTicker[]>;
  loadChain(tickerId: string): Promise<StoredOptionChain>;
  loadCloseImpliedVolatilities(tickerIds: string[]): Promise<Map<string, number>>;
  riskFreeRate(): Promise<number | null>;
  sessionCloseMinutesEt(dateIso: string): Promise<number>;
}

const defaultDependencies: VolatilityConsumerDependencies = {
  activeBands: () => activeVolatilityBands(),
  loadTickers: () => loadOptionDataUniverse(),
  loadChain: loadStoredOptionChain,
  loadCloseImpliedVolatilities,
  riskFreeRate: () => getRiskFreeRate(),
  sessionCloseMinutesEt: async (dateIso) => (await loadTradingSessionsBetween(dateIso, dateIso))[0]?.closeMinutesEt ?? 16 * 60,
};

/** Per expiry, the 2 strikes nearest each band's Delta max by estimated Call delta (pure; exported for tests). */
export function selectBandEdgeCallStrikes(input: { strikes: readonly number[]; forward: number; yearsToExpiry: number; riskFreeRate: number; impliedVolatility: number; bands: readonly DeltaBand[] }): number[] {
  const strikes = [...input.strikes].sort((a, b) => a - b);
  const deltas = strikes.map((strike) => blackScholesDelta(input.forward, strike, input.yearsToExpiry, input.riskFreeRate, input.impliedVolatility, true));
  const picked = new Set<number>();
  for (const band of input.bands) {
    // Call delta falls as the strike rises: the first strike at or under Delta max is the band's top edge.
    const edgeIndex = deltas.findIndex((delta) => delta <= band.max);
    if (edgeIndex === -1) continue;
    picked.add(strikes[edgeIndex]!);
    if (edgeIndex > 0) picked.add(strikes[edgeIndex - 1]!);
  }
  return [...picked].sort((a, b) => a - b);
}

export function createVolatilityConsumer(deps: VolatilityConsumerDependencies = defaultDependencies): MarketQuoteConsumer {
  let tickers: OptionDataTicker[] = [];
  let bands: DeltaBand[] = [];
  let chainDay: { tradingDateIso: string; byTicker: Map<string, StoredOptionChain>; closeImpliedVolatility: Map<string, number> } | null = null;
  return {
    name: "Volatility",
    wantsImpliedVolatility: true,
    async tickers() {
      bands = deps.activeBands();
      tickers = bands.length === 0 ? [] : await deps.loadTickers();
      return tickers.map((ticker) => ({ tickerId: ticker.tickerId, symbol: ticker.symbol }));
    },
    onStockPass(cycle) {
      for (const ticker of tickers) {
        recordLiveStock(ticker.tickerId, cycle.tradingDateIso, { spotPrice: cycle.spotByTicker.get(ticker.tickerId) ?? null, impliedVolatility: cycle.impliedVolatilityByTicker.get(ticker.tickerId) ?? null, at: cycle.now });
      }
    },
    async contracts(cycle: QuoteLoopCycle) {
      if (chainDay?.tradingDateIso !== cycle.tradingDateIso) chainDay = { tradingDateIso: cycle.tradingDateIso, byTicker: new Map(), closeImpliedVolatility: await deps.loadCloseImpliedVolatilities(tickers.map((ticker) => ticker.tickerId)) };
      const riskFreeRate = (await deps.riskFreeRate()) ?? 0;
      const yearsToTodaysClose = yearsToSessionClose(cycle.now, await deps.sessionCloseMinutesEt(cycle.tradingDateIso));
      const contracts: QuoteLoopContract[] = [];
      for (const ticker of tickers) {
        const spotPrice = cycle.spotByTicker.get(ticker.tickerId) ?? null;
        const impliedVolatility = cycle.impliedVolatilityByTicker.get(ticker.tickerId) ?? chainDay.closeImpliedVolatility.get(ticker.tickerId) ?? null;
        if (spotPrice === null || !(spotPrice > 0) || impliedVolatility === null || !(impliedVolatility > 0)) continue;
        let chain = chainDay.byTicker.get(ticker.tickerId);
        if (!chain) {
          chain = await deps.loadChain(ticker.tickerId);
          chainDay.byTicker.set(ticker.tickerId, chain);
        }
        for (const [expiry, strikes] of chain.strikesByExpiry) {
          const daysToExpiry = calendarDaysUntilExpiry(cycle.tradingDateIso, expiry);
          if (daysToExpiry < 0 || daysToExpiry > volatilityMaximumDaysToExpiry) continue;
          const yearsToExpiry = daysToExpiry === 0 ? yearsToTodaysClose : daysToExpiry / 365;
          if (!(yearsToExpiry > 0)) continue;
          const forward = spotPrice * Math.exp(riskFreeRate * yearsToExpiry);
          for (const strike of selectBandEdgeCallStrikes({ strikes, forward, yearsToExpiry, riskFreeRate, impliedVolatility, bands })) {
            contracts.push({ tickerId: ticker.tickerId, symbol: ticker.symbol, expiry: formatExpiryAsIsoDate(expiry), strike, right: "C" });
          }
        }
      }
      return contracts;
    },
    onQuote(quote, cycle) {
      recordLiveCallQuote(quote.contract.tickerId, cycle.tradingDateIso, { expiry: quote.contract.expiry, strike: quote.contract.strike, bid: quote.bid, ask: quote.ask, stockPrice: cycle.spotByTicker.get(quote.contract.tickerId) ?? null, quotedAt: quote.quotedAt });
    },
  };
}
