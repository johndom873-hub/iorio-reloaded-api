// MA/RSI/MACD/support-resistance formulas approved 2026-09-01, adapted from
// a trading-indicator reference doc (MA Trade Analyzer) a friend of the
// user's shared — reused as pure math only, not the doc's directional
// buy/short scoring engine, which targets spot entries and doesn't fit
// Iorio's premium-selling strategies. Consumed by streamTickerDetail.ts
// (context on the Ticker Detail screen) and generateTradeAlertCandidates.ts
// (Slice 2A rationale annotation) — never used to reorder or filter trade
// alerts itself; see PROGRESS.md.
//
// Pure functions only — no DB/IBKR imports, so callers supply plain bar
// arrays already read from daily_price_bars / intraday_price_bars. All bar
// arrays are expected oldest-first (ascending time), matching every existing
// price-bar read in priceBarCache.ts.

export interface OhlcvBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface MovingAverages {
  ma7: number | null;
  ma25: number | null;
  ma99: number | null;
}

function meanOfLatest(closes: number[], count: number): number | null {
  if (closes.length < count) return null;
  const window = closes.slice(-count);
  return window.reduce((sum, value) => sum + value, 0) / count;
}

export function computeMovingAverages(closes: number[]): MovingAverages {
  return {
    ma7: meanOfLatest(closes, 7),
    ma25: meanOfLatest(closes, 25),
    ma99: meanOfLatest(closes, 99),
  };
}

// 14-period RSI from the latest 15 closes (14 changes). Insufficient data
// (fewer than 15 closes) returns 50 (neutral), not null — matches the
// approved spec exactly, which treats "no signal yet" as neutral rather than
// propagating null through the UI.
export function computeRsi(closes: number[]): number {
  if (closes.length < 15) return 50;
  const window = closes.slice(-15);
  let totalGain = 0;
  let totalLoss = 0;
  for (let i = 1; i < window.length; i++) {
    const change = window[i]! - window[i - 1]!;
    if (change > 0) totalGain += change;
    else totalLoss += -change;
  }
  const avgGain = totalGain / 14;
  const avgLoss = totalLoss / 14;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Simple EMA series (SMA-seeded), aligned so result[0] corresponds to
// values[period - 1]. Matches the approved spec's plain arithmetic style
// (e.g. RSI's un-smoothed 14-change average) rather than Wilder smoothing.
function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
  const result = [seed];
  for (let i = period; i < values.length; i++) {
    result.push(values[i]! * k + result[result.length - 1]! * (1 - k));
  }
  return result;
}

export type MacdSignal = "Bullish" | "Bearish" | "Neutral";

// EMA12/EMA26 -> MACD line -> 9-period EMA signal line, latest MACD vs
// signal. Needs at least 35 closes (26 for EMA26 to seed + 9 for the signal
// line's own warmup) per the approved spec; fewer returns Neutral.
export function computeMacd(closes: number[]): MacdSignal {
  if (closes.length < 35) return "Neutral";

  const ema12 = emaSeries(closes, 12); // ema12[j] <-> closes[11 + j]
  const ema26 = emaSeries(closes, 26); // ema26[j] <-> closes[25 + j]

  const macdLine: number[] = [];
  for (let j = 0; j < ema26.length; j++) {
    macdLine.push(ema12[14 + j]! - ema26[j]!);
  }

  const signalLine = emaSeries(macdLine, 9);
  if (signalLine.length === 0) return "Neutral";

  const latestMacd = macdLine[macdLine.length - 1]!;
  const latestSignal = signalLine[signalLine.length - 1]!;
  if (latestMacd > latestSignal) return "Bullish";
  if (latestMacd < latestSignal) return "Bearish";
  return "Neutral";
}

// True-range ATR, plain 14-period moving average (not Wilder-smoothed, same
// reasoning as emaSeries above). atrSeries[0] corresponds to bars[period]
// (the first bar with 14 prior true-range values available).
export function computeAtrSeries(bars: OhlcvBar[], period = 14): number[] {
  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i]!;
    const prevClose = bars[i - 1]!.close;
    trueRanges.push(Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose)));
  }
  if (trueRanges.length < period) return [];
  const atrSeries: number[] = [];
  for (let i = period - 1; i < trueRanges.length; i++) {
    const window = trueRanges.slice(i - period + 1, i + 1);
    atrSeries.push(window.reduce((sum, value) => sum + value, 0) / period);
  }
  return atrSeries;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

interface Pivot {
  index: number; // index into closedBars
  price: number; // low for a support pivot, high for a resistance pivot
  prominence: number;
  rejection: number;
  volumeRatio: number;
}

// Two-candles-on-each-side local pivot scan. `getExtreme` returns the value
// being compared (low for support, high for resistance); `isBetterOrEqual`
// encodes "no greater than all neighbors" (support) / "no less than all
// neighbors" (resistance); `isStrictlyBetter` encodes the "strictly beyond
// at least one neighbor" half of the pivot definition.
function findPivots(
  closedBars: OhlcvBar[],
  atr: number,
  getExtreme: (bar: OhlcvBar) => number,
  isBetterOrEqual: (candidate: number, neighbor: number) => boolean,
  isStrictlyBetter: (candidate: number, neighbor: number) => boolean,
  wickRejection: (bar: OhlcvBar, extreme: number, atr: number) => number,
): Pivot[] {
  const pivots: Pivot[] = [];
  for (let i = 2; i < closedBars.length - 2; i++) {
    const candidate = getExtreme(closedBars[i]!);
    const neighborIndexes = [i - 2, i - 1, i + 1, i + 2];
    const neighborValues = neighborIndexes.map((n) => getExtreme(closedBars[n]!));

    const qualifies = neighborValues.every((n) => isBetterOrEqual(candidate, n)) && neighborValues.some((n) => isStrictlyBetter(candidate, n));
    if (!qualifies) continue;

    // Prominence: how far the pivot stands from its nearest "wall" —
    // the smallest neighbor distance, since a pivot barely distinguishable
    // from one neighbor is a weak pivot regardless of the other three.
    const prominence = Math.min(...neighborValues.map((n) => Math.abs(n - candidate)));
    if (prominence < 0.75 * atr) continue;

    const precedingVolumes = closedBars.slice(Math.max(0, i - 20), i).map((b) => b.volume);
    const avgVolume = precedingVolumes.length > 0 ? precedingVolumes.reduce((sum, v) => sum + v, 0) / precedingVolumes.length : closedBars[i]!.volume;

    pivots.push({
      index: i,
      price: candidate,
      prominence,
      rejection: clamp01(wickRejection(closedBars[i]!, candidate, atr) / atr / 2),
      volumeRatio: avgVolume > 0 ? closedBars[i]!.volume / avgVolume : 1,
    });
  }
  return pivots;
}

function buildFourHourCandles(closedBars: OhlcvBar[]): OhlcvBar[] {
  const groupCount = Math.floor(closedBars.length / 4);
  const candles: OhlcvBar[] = [];
  for (let g = 0; g < groupCount; g++) {
    const group = closedBars.slice(g * 4, g * 4 + 4);
    candles.push({
      time: group[0]!.time,
      open: group[0]!.open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1]!.close,
      volume: group.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return candles;
}

// One-neighbor-each-side local pivots on the 4h series, for confluence only
// — no prominence/rejection filtering, just "is this a local extreme."
function findFourHourPivotPrices(fourHourBars: OhlcvBar[], getExtreme: (bar: OhlcvBar) => number, isLocalExtreme: (candidate: number, left: number, right: number) => boolean): number[] {
  const prices: number[] = [];
  for (let i = 1; i < fourHourBars.length - 1; i++) {
    const candidate = getExtreme(fourHourBars[i]!);
    if (isLocalExtreme(candidate, getExtreme(fourHourBars[i - 1]!), getExtreme(fourHourBars[i + 1]!))) {
      prices.push(candidate);
    }
  }
  return prices;
}

interface Cluster {
  center: number;
  touches: Pivot[];
}

// Greedy single-pass clustering by cluster tolerance — pivots are already
// processed in ascending price order per direction, so each pivot either
// joins the running cluster (within tolerance of its current mean) or starts
// a new one.
function clusterPivots(pivots: Pivot[], tolerance: number): Cluster[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: Cluster[] = [];
  for (const pivot of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(pivot.price - last.center) <= tolerance) {
      last.touches.push(pivot);
      last.center = last.touches.reduce((sum, p) => sum + p.price, 0) / last.touches.length;
    } else {
      clusters.push({ center: pivot.price, touches: [pivot] });
    }
  }
  return clusters;
}

// Pivots within 4 bars of each other count as one touch, not two — keeps
// the stronger-rejection pivot when a pair collides. Touches are already
// sorted by index (ascending) coming out of findPivots.
function dedupeIndependentTouches(touches: Pivot[]): Pivot[] {
  const sortedByIndex = [...touches].sort((a, b) => a.index - b.index);
  const independent: Pivot[] = [];
  for (const touch of sortedByIndex) {
    const last = independent[independent.length - 1];
    if (last && touch.index - last.index < 4) {
      if (touch.rejection > last.rejection) independent[independent.length - 1] = touch;
    } else {
      independent.push(touch);
    }
  }
  return independent;
}

export interface SupportResistanceZone {
  price: number;
  qualityPct: number; // 0-100, one decimal
  touches: number;
  atr: number; // pivot ATR used to find this zone — Slice 2A reuses this to express strike distance in ATR units
}

export interface SupportResistanceResult {
  support: SupportResistanceZone | null;
  resistance: SupportResistanceZone | null;
}

const minClosedBarsRequired = 30; // enough room for 2-sided pivots + a 14-period ATR with margin
const freshPivotWindow = 24;

function evaluateDirection(
  closedBars: OhlcvBar[],
  fourHourBars: OhlcvBar[],
  pivotAtr: number,
  clusterTolerance: number,
  currentPrice: number,
  side: "support" | "resistance",
): SupportResistanceZone | null {
  const isSupport = side === "support";
  const pivots = findPivots(
    closedBars,
    pivotAtr,
    (bar) => (isSupport ? bar.low : bar.high),
    (candidate, neighbor) => (isSupport ? candidate <= neighbor : candidate >= neighbor),
    (candidate, neighbor) => (isSupport ? candidate < neighbor : candidate > neighbor),
    (bar, extreme) => (isSupport ? Math.min(bar.open, bar.close) - extreme : extreme - Math.max(bar.open, bar.close)),
  );

  const fourHourPivotPrices = findFourHourPivotPrices(
    fourHourBars,
    (bar) => (isSupport ? bar.low : bar.high),
    (candidate, left, right) => (isSupport ? candidate <= left && candidate <= right && (candidate < left || candidate < right) : candidate >= left && candidate >= right && (candidate > left || candidate > right)),
  );

  const clusters = clusterPivots(pivots, clusterTolerance);
  const candleCount = closedBars.length;

  const qualifiedZones: { center: number; quality: number; touches: number }[] = [];
  for (const cluster of clusters) {
    const independentTouches = dedupeIndependentTouches(cluster.touches);
    const touchCount = independentTouches.length;

    if (touchCount < 2) {
      const single = independentTouches[0];
      const isFresh = single !== undefined && single.index >= candleCount - freshPivotWindow && single.prominence >= 1.25 * pivotAtr && single.rejection >= 0.4;
      if (!isFresh) continue;
    }

    const center = independentTouches.reduce((sum, p) => sum + p.price, 0) / independentTouches.length;
    const touchScore = Math.min(touchCount / 4, 1);
    const avgRejection = independentTouches.reduce((sum, p) => sum + p.rejection, 0) / independentTouches.length;
    const avgVolumeRatio = independentTouches.reduce((sum, p) => sum + p.volumeRatio, 0) / independentTouches.length;
    const normalizedVolume = Math.min(avgVolumeRatio / 1.5, 1);
    const hasConfluence = fourHourPivotPrices.some((price) => Math.abs(price - center) <= clusterTolerance);
    const mostRecentIndex = Math.max(...independentTouches.map((p) => p.index));
    const recency = (mostRecentIndex + 1) / candleCount;
    const distanceScore = Math.max(0, 1 - Math.abs(currentPrice - center) / Math.max(currentPrice * 0.1, pivotAtr));

    const quality = 0.3 * touchScore + 0.2 * avgRejection + 0.15 * normalizedVolume + 0.15 * (hasConfluence ? 1 : 0) + 0.1 * recency + 0.1 * distanceScore;
    if (quality >= 0.4) qualifiedZones.push({ center, quality, touches: touchCount });
  }

  const onCorrectSide = qualifiedZones.filter((z) => (isSupport ? z.center < currentPrice : z.center > currentPrice));
  const selected = onCorrectSide.length > 0 ? onCorrectSide.reduce((best, z) => (isSupport ? (z.center > best.center ? z : best) : z.center < best.center ? z : best)) : null;

  if (selected) {
    return {
      price: Math.round(selected.center * 100) / 100,
      qualityPct: Math.round(selected.quality * 1000) / 10,
      touches: selected.touches,
      atr: pivotAtr,
    };
  }

  // Fallback: no valid zone — min low / max high of closed candles, quality 0.
  if (closedBars.length === 0) return null;
  const fallbackPrice = isSupport ? Math.min(...closedBars.map((b) => b.low)) : Math.max(...closedBars.map((b) => b.high));
  return { price: Math.round(fallbackPrice * 100) / 100, qualityPct: 0, touches: 0, atr: pivotAtr };
}

/**
 * ATR-clustered support/resistance from 1h candles (up to the latest 200),
 * per the approved spec. `currentCandleIsOpen` excludes the still-forming
 * bar from pivot discovery, per point 2 of the spec — pass `false` once the
 * latest bar in `hourlyBars` is confirmed closed.
 */
export function computeSupportResistance(hourlyBars: OhlcvBar[], currentPrice: number, currentCandleIsOpen: boolean): SupportResistanceResult {
  const bars = hourlyBars.slice(-200);
  const closedBars = currentCandleIsOpen ? bars.slice(0, -1) : bars;

  if (closedBars.length < minClosedBarsRequired) {
    if (closedBars.length === 0) return { support: null, resistance: null };
    return {
      support: { price: Math.round(Math.min(...closedBars.map((b) => b.low)) * 100) / 100, qualityPct: 0, touches: 0, atr: currentPrice * 0.01 },
      resistance: { price: Math.round(Math.max(...closedBars.map((b) => b.high)) * 100) / 100, qualityPct: 0, touches: 0, atr: currentPrice * 0.01 },
    };
  }

  const atrSeries = computeAtrSeries(closedBars, 14);
  const pivotAtr = atrSeries.length > 0 ? median(atrSeries.slice(-20)) : currentPrice * 0.01;
  const clusterTolerance = Math.max(0.35 * pivotAtr, currentPrice * 0.001);
  const fourHourBars = buildFourHourCandles(closedBars);

  return {
    support: evaluateDirection(closedBars, fourHourBars, pivotAtr, clusterTolerance, currentPrice, "support"),
    resistance: evaluateDirection(closedBars, fourHourBars, pivotAtr, clusterTolerance, currentPrice, "resistance"),
  };
}
