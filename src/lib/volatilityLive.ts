// The Volatility screen's live state, in memory in the web dyno (Marcelo 2026-10-27): which delta bands open screens are
// asking for, and the market quote loop's latest stock and Call quotes per ticker. Nothing here is persisted: after a
// restart the next cycle fills it again.

export interface DeltaBand {
  min: number;
  max: number;
}

/** A band stays wanted this long after the last request that asked for it (the screen polls every 5 s, Pulse every 30 s). */
export const volatilityDemandLeaseMs = 2 * 60_000;

const leaseExpiryByBand = new Map<string, { band: DeltaBand; expiresAtMs: number }>();

function bandKey(band: DeltaBand): string {
  return `${band.min}|${band.max}`;
}

/** Records that a screen wants Calls for this band; the loop quotes while any band is wanted. */
export function touchVolatilityDemand(band: DeltaBand, nowMs: number = Date.now()): void {
  leaseExpiryByBand.set(bandKey(band), { band, expiresAtMs: nowMs + volatilityDemandLeaseMs });
}

export function activeVolatilityBands(nowMs: number = Date.now()): DeltaBand[] {
  const active: DeltaBand[] = [];
  for (const [key, lease] of leaseExpiryByBand) {
    if (lease.expiresAtMs <= nowMs) leaseExpiryByBand.delete(key);
    else active.push(lease.band);
  }
  return active;
}

export interface LiveCallQuote {
  expiry: string; // ISO date
  strike: number;
  bid: number | null;
  ask: number | null;
  /** The stock price from the same cycle's stock pass. */
  stockPrice: number | null;
  quotedAt: Date;
}

export interface TickerLiveState {
  spotPrice: number | null;
  spotAt: Date | null;
  /** IBKR's 30-day implied volatility (0.35 = 35%). */
  impliedVolatility: number | null;
  impliedVolatilityAt: Date | null;
  callQuotes: Map<string, LiveCallQuote>;
}

let liveTradingDateIso: string | null = null;
const liveByTicker = new Map<string, TickerLiveState>();

function stateFor(tickerId: string, tradingDateIso: string): TickerLiveState {
  if (liveTradingDateIso !== tradingDateIso) {
    liveByTicker.clear();
    liveTradingDateIso = tradingDateIso;
  }
  let state = liveByTicker.get(tickerId);
  if (!state) {
    state = { spotPrice: null, spotAt: null, impliedVolatility: null, impliedVolatilityAt: null, callQuotes: new Map() };
    liveByTicker.set(tickerId, state);
  }
  return state;
}

export function recordLiveStock(tickerId: string, tradingDateIso: string, reading: { spotPrice: number | null; impliedVolatility: number | null; at: Date }): void {
  const state = stateFor(tickerId, tradingDateIso);
  if (reading.spotPrice !== null) {
    state.spotPrice = reading.spotPrice;
    state.spotAt = reading.at;
  }
  if (reading.impliedVolatility !== null) {
    state.impliedVolatility = reading.impliedVolatility;
    state.impliedVolatilityAt = reading.at;
  }
}

export function recordLiveCallQuote(tickerId: string, tradingDateIso: string, quote: LiveCallQuote): void {
  stateFor(tickerId, tradingDateIso).callQuotes.set(`${quote.expiry}|${quote.strike}`, quote);
}

/** Today's live state of a ticker, or null when the loop has not quoted it today. */
export function readTickerLiveState(tickerId: string, tradingDateIso: string): TickerLiveState | null {
  return liveTradingDateIso === tradingDateIso ? (liveByTicker.get(tickerId) ?? null) : null;
}

/** Tests only. */
export function resetVolatilityLiveState(): void {
  leaseExpiryByBand.clear();
  liveByTicker.clear();
  liveTradingDateIso = null;
}
