import { standardNormalCdf } from "./blackScholesPop.js";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";
import type { VolatilityModelTables, ValuationGroup } from "./volatilityModelTables.js";

// Builds the two tables the valuation model reads (model review P4 and P5, approved by Marcelo 2026-10-10), from daily
// price history only. Pure: scripts/build-volatility-model-tables.ts loads the rows and writes the generated module.
//
// 1. Standardized returns, per group (ETFs incl. TLT / single stocks) and horizon h = 1..maxHorizon sessions:
//      z = Σ log close-to-close returns over sessions t+1..t+h ÷ √(YZ21 per-session variance at t · h)
//    YZ21 is the approved forecast (P3), computed exactly as production does from the bars up to t. Windows that touch an
//    earnings reaction (the first session on or after the event date and the next one; historical event times are
//    unknown) are left out, as Signals never trades across earnings. Stored as `bucketCount` equal-count bucket means.
// 2. At-the-money calibration (P5): for every earnings-free ticker-day with IBKR's 30-day implied volatility, an ATM
//    straddle priced at that volatility over h sessions against the model's fair value (YZ21 + the group's z table):
//      predicted margin = 1 − fair ÷ premium,  realized margin = (premium − |S_{t+h} ÷ S_t − 1|) ÷ premium
//    bucketed by predicted margin; each bucket stores its mean predicted margin and its premium-weighted realized margin,
//    with a 95% interval from a bootstrap over calendar months. Across a row the realized margins are then fitted
//    monotone (isotonic, approved by Marcelo 2026-10-10): adjacent buckets whose results fall as the predicted margin rises
//    are pooled into their premium-weighted mean, so a richer price never maps to a lower expected result.
//
// Data rules (generic, not per ticker): a bar is usable when its prices are valid and volume ≥ minimumUsableVolume (drops
// the zero-volume bars a trading halt is stored as, and near-empty OTC history); a return needs both bars and no market
// session missing between them; market sessions are the dates on which at least half of the tickers trading then have a
// bar. A ticker's implied volatility is left out when its median sits outside [0.4, 2.5] × its median realized volatility
// (an illiquid chain's quotes).

export const minimumUsableVolume = 1_000;
export const yangZhangForecastWindow = 21;
export const calibrationHorizons = [1, 2, 3, 5, 10, 21] as const;
export const calibrationMarginEdges = [-Infinity, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, Infinity] as const;
export const calibrationBootstrapIterations = 1000;
const implausibleImpliedToRealizedRatio = { low: 0.4, high: 2.5 };

export interface TickerHistoryInput {
  symbol: string;
  group: ValuationGroup;
  /** Ascending by date. */
  bars: (DailyOhlcvBar & { impliedVolatility: number | null })[];
  earningsDatesIso: string[];
}

interface Session {
  dateIso: string;
  /** Index into the ticker's usable bars. */
  barIndex: number;
  /** Master-session index. */
  masterIndex: number;
}

function isUsableBar(bar: DailyOhlcvBar): boolean {
  const { open, high, low, close, volume } = bar;
  if (![open, high, low, close].every((price) => Number.isFinite(price) && price > 0)) return false;
  if (!(volume >= minimumUsableVolume)) return false;
  return high >= Math.max(open, close) && low <= Math.min(open, close);
}

/** Pure: the dates on which at least half of the tickers whose history spans that date have a usable bar. */
export function inferMarketSessions(tickers: Pick<TickerHistoryInput, "bars">[]): string[] {
  const usableDates = tickers.map((ticker) => new Set(ticker.bars.filter(isUsableBar).map((bar) => bar.tradingDate)));
  const spans = tickers.map((ticker) => ({ first: ticker.bars[0]?.tradingDate ?? "9999", last: ticker.bars.at(-1)?.tradingDate ?? "0000" }));
  const allDates = [...new Set(tickers.flatMap((ticker) => ticker.bars.map((bar) => bar.tradingDate)))].sort();
  return allDates.filter((dateIso) => {
    let spanning = 0;
    let present = 0;
    tickers.forEach((_, index) => {
      if (spans[index]!.first <= dateIso && spans[index]!.last >= dateIso) {
        spanning++;
        if (usableDates[index]!.has(dateIso)) present++;
      }
    });
    return spanning > 0 && present * 2 >= spanning;
  });
}

/** Contiguous runs of the ticker's usable bars on consecutive market sessions (a missing session breaks the run). */
function contiguousSegments(ticker: TickerHistoryInput, masterIndexByDate: Map<string, number>): Session[][] {
  const segments: Session[][] = [];
  let current: Session[] = [];
  ticker.bars.forEach((bar, barIndex) => {
    const masterIndex = masterIndexByDate.get(bar.tradingDate);
    if (masterIndex === undefined || !isUsableBar(bar)) {
      if (current.length > 0) segments.push(current);
      current = [];
      return;
    }
    const previous = current.at(-1);
    if (previous && masterIndex !== previous.masterIndex + 1) {
      segments.push(current);
      current = [];
    }
    current.push({ dateIso: bar.tradingDate, barIndex, masterIndex });
  });
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Master indexes of the earnings reaction sessions: the first session on or after each event date, and the next one. */
function earningsReactionSessions(earningsDatesIso: string[], masterSessions: string[]): Set<number> {
  const result = new Set<number>();
  for (const eventDate of earningsDatesIso) {
    const first = masterSessions.findIndex((dateIso) => dateIso >= eventDate);
    if (first < 0) continue;
    result.add(first);
    if (first + 1 < masterSessions.length) result.add(first + 1);
  }
  return result;
}

export interface WindowObservation {
  symbol: string;
  group: ValuationGroup;
  dateIso: string;
  horizon: number;
  /** YZ21 per-session variance at t (bars up to and including t). */
  forecastVariance: number;
  /** Σ log returns over t+1..t+h. */
  logReturn: number;
  /** IBKR 30-day implied volatility at t (annualized), when present and plausible. */
  impliedVolatility: number | null;
}

/** Pure: every earnings-free window (t, t+h] of every ticker with a YZ21 forecast at t, for h = 1..maxHorizon. */
export function collectWindows(tickers: TickerHistoryInput[], maxHorizon: number): WindowObservation[] {
  const masterSessions = inferMarketSessions(tickers);
  const masterIndexByDate = new Map(masterSessions.map((dateIso, index) => [dateIso, index]));
  const observations: WindowObservation[] = [];
  for (const ticker of tickers) {
    const reactions = earningsReactionSessions(ticker.earningsDatesIso, masterSessions);
    const impliedUsable = impliedVolatilityIsPlausible(ticker);
    for (const segment of contiguousSegments(ticker, masterIndexByDate)) {
      const segmentBars = segment.map((session) => ticker.bars[session.barIndex]!);
      for (let t = yangZhangForecastWindow; t < segment.length - 1; t++) {
        const yz = computeYangZhangVolatility(segmentBars, yangZhangForecastWindow, t + 1);
        if (!yz.available || !(yz.annualizedVolatility > 0)) continue;
        const forecastVariance = yz.annualizedVolatility ** 2 / 252;
        const implied = impliedUsable ? segmentBars[t]!.impliedVolatility : null;
        let logReturn = 0;
        for (let h = 1; h <= maxHorizon && t + h < segment.length; h++) {
          if (reactions.has(segment[t + h]!.masterIndex)) break; // every longer window contains it too
          logReturn += Math.log(segmentBars[t + h]!.close / segmentBars[t + h - 1]!.close);
          observations.push({ symbol: ticker.symbol, group: ticker.group, dateIso: segment[t]!.dateIso, horizon: h, forecastVariance, logReturn, impliedVolatility: implied !== null && implied > 0 ? implied : null });
        }
      }
    }
  }
  return observations;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? NaN : sorted[Math.floor(sorted.length / 2)]!;
}

/** A ticker's IBKR implied volatility is usable when its median is within [0.4, 2.5] × its median 21-day realized volatility. */
export function impliedVolatilityIsPlausible(ticker: TickerHistoryInput): boolean {
  const implied = ticker.bars.map((bar) => bar.impliedVolatility).filter((value): value is number => value !== null && value > 0);
  if (implied.length === 0) return false;
  const usable = ticker.bars.filter(isUsableBar);
  const realized: number[] = [];
  for (let end = yangZhangForecastWindow + 1; end <= usable.length; end += 5) {
    const result = computeYangZhangVolatility(usable, yangZhangForecastWindow, end);
    if (result.available) realized.push(result.annualizedVolatility);
  }
  if (realized.length === 0) return false;
  const ratio = median(implied) / median(realized);
  return ratio >= implausibleImpliedToRealizedRatio.low && ratio <= implausibleImpliedToRealizedRatio.high;
}

/** Pure: sort and split into `bucketCount` equal-count buckets; each bucket's mean. Needs at least bucketCount values. */
export function equalCountBucketMeans(values: number[], bucketCount: number): number[] {
  if (values.length < bucketCount) throw new Error(`need at least ${bucketCount} values, got ${values.length}`);
  const sorted = [...values].sort((a, b) => a - b);
  const means: number[] = [];
  for (let bucket = 0; bucket < bucketCount; bucket++) {
    const start = Math.floor((bucket * sorted.length) / bucketCount);
    const end = Math.floor(((bucket + 1) * sorted.length) / bucketCount);
    let sum = 0;
    for (let index = start; index < end; index++) sum += sorted[index]!;
    means.push(sum / (end - start));
  }
  return means;
}

/** Fair ATM straddle per unit forward under standardized-return buckets z at total standard deviation s (zero drift on the forward). */
export function fairAtmStraddle(buckets: readonly number[], totalStandardDeviation: number): number {
  let normalizer = 0;
  for (const z of buckets) normalizer += Math.exp(totalStandardDeviation * z);
  normalizer /= buckets.length;
  let sum = 0;
  for (const z of buckets) sum += Math.abs(Math.exp(totalStandardDeviation * z) / normalizer - 1);
  return sum / buckets.length;
}

/** ATM straddle per unit spot at annualized volatility σ over h sessions (σ²/252 per session), zero rate. */
export function blackScholesAtmStraddle(annualizedVolatility: number, horizonSessions: number): number {
  const totalStandardDeviation = Math.sqrt((annualizedVolatility ** 2 / 252) * horizonSessions);
  return 2 * (2 * standardNormalCdf(totalStandardDeviation / 2) - 1);
}

/**
 * Pure: weighted isotonic (non-decreasing) fit by pooling adjacent violators. Each output is the weighted mean of the
 * block its input was pooled into; inputs already in order come back unchanged.
 */
export function monotoneFit(values: readonly number[], weights: readonly number[]): number[] {
  const blocks: { value: number; weight: number; size: number }[] = [];
  values.forEach((value, index) => {
    blocks.push({ value, weight: weights[index]!, size: 1 });
    while (blocks.length > 1 && blocks.at(-2)!.value > blocks.at(-1)!.value) {
      const last = blocks.pop()!;
      const previous = blocks.pop()!;
      const weight = previous.weight + last.weight;
      blocks.push({ value: (previous.value * previous.weight + last.value * last.weight) / weight, weight, size: previous.size + last.size });
    }
  });
  return blocks.flatMap((block) => Array<number>(block.size).fill(block.value));
}

/** Deterministic uniform [0, 1) generator, so a rebuild on the same data gives the same intervals. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function quantileOf(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
}

/**
 * Pure: per bucket, the 95% interval of the premium-weighted realized margin, resampling calendar months with
 * replacement. `sums[month][bucket]` holds that month's premium total and premium × realized total.
 */
export function bootstrapBucketIntervals(sums: Map<string, { premium: number; weighted: number }[]>, bucketCount: number, iterations: number, seed: number): { low: number; high: number }[] {
  const months = [...sums.keys()].sort();
  const random = seededRandom(seed);
  const samples: number[][] = Array.from({ length: bucketCount }, () => []);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const premium = new Array<number>(bucketCount).fill(0);
    const weighted = new Array<number>(bucketCount).fill(0);
    for (let draw = 0; draw < months.length; draw++) {
      const month = sums.get(months[Math.floor(random() * months.length)]!)!;
      for (let bucket = 0; bucket < bucketCount; bucket++) {
        premium[bucket] = premium[bucket]! + month[bucket]!.premium;
        weighted[bucket] = weighted[bucket]! + month[bucket]!.weighted;
      }
    }
    for (let bucket = 0; bucket < bucketCount; bucket++) if (premium[bucket]! > 0) samples[bucket]!.push(weighted[bucket]! / premium[bucket]!);
  }
  return samples.map((values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? { low: NaN, high: NaN } : { low: quantileOf(sorted, 0.025), high: quantileOf(sorted, 0.975) };
  });
}

export interface BuildOptions {
  maxHorizon: number;
  bucketCount: number;
  builtAtIso: string;
  source: string;
}

export function buildVolatilityModelTables(tickers: TickerHistoryInput[], options: BuildOptions): VolatilityModelTables {
  const observations = collectWindows(tickers, options.maxHorizon);
  const groups: ValuationGroup[] = ["etf", "stock"];
  const standardizedReturnBuckets = {} as VolatilityModelTables["standardizedReturnBuckets"];
  const sampleCounts = {} as VolatilityModelTables["sampleCounts"];
  for (const group of groups) {
    standardizedReturnBuckets[group] = [];
    sampleCounts[group] = [];
    for (let h = 1; h <= options.maxHorizon; h++) {
      const z = observations.filter((o) => o.group === group && o.horizon === h).map((o) => o.logReturn / Math.sqrt(o.forecastVariance * h));
      standardizedReturnBuckets[group].push(equalCountBucketMeans(z, options.bucketCount).map((value) => Math.round(value * 1e5) / 1e5));
      sampleCounts[group].push(z.length);
    }
  }

  const calibration: VolatilityModelTables["calibration"] = [];
  for (const horizon of calibrationHorizons) {
    if (horizon > options.maxHorizon) continue;
    const rows = observations
      .filter((o) => o.horizon === horizon && o.impliedVolatility !== null)
      .map((o) => {
        const premium = blackScholesAtmStraddle(o.impliedVolatility!, horizon);
        const fair = fairAtmStraddle(standardizedReturnBuckets[o.group][horizon - 1]!, Math.sqrt(o.forecastVariance * horizon));
        return { premium, predicted: 1 - fair / premium, realized: (premium - Math.abs(Math.exp(o.logReturn) - 1)) / premium, month: o.dateIso.slice(0, 7) };
      });
    const bucketIndexOf = (predicted: number) => calibrationMarginEdges.findIndex((edge, index) => index + 1 < calibrationMarginEdges.length && predicted >= edge && predicted < calibrationMarginEdges[index + 1]!);
    const bucketCount = calibrationMarginEdges.length - 1;
    const buckets = Array.from({ length: bucketCount }, () => ({ predictedSum: 0, premium: 0, weighted: 0, count: 0 }));
    const sumsByMonth = new Map<string, { premium: number; weighted: number }[]>();
    for (const row of rows) {
      const index = bucketIndexOf(row.predicted);
      if (index < 0) continue;
      const bucket = buckets[index]!;
      bucket.predictedSum += row.predicted;
      bucket.premium += row.premium;
      bucket.weighted += row.realized * row.premium;
      bucket.count += 1;
      const month = sumsByMonth.get(row.month) ?? Array.from({ length: bucketCount }, () => ({ premium: 0, weighted: 0 }));
      month[index]!.premium += row.premium;
      month[index]!.weighted += row.realized * row.premium;
      sumsByMonth.set(row.month, month);
    }
    const intervals = bootstrapBucketIntervals(sumsByMonth, bucketCount, calibrationBootstrapIterations, horizon);
    const present = buckets.map((bucket, index) => ({ bucket, interval: intervals[index]! })).filter((entry) => entry.bucket.count > 0);
    const raw = present.map((entry) => entry.bucket.weighted / entry.bucket.premium);
    const fitted = monotoneFit(raw, present.map((entry) => entry.bucket.premium));
    const round = (value: number) => Math.round(value * 1e4) / 1e4;
    const points: VolatilityModelTables["calibration"][number]["points"] = present.map((entry, index) => ({
      predictedMargin: round(entry.bucket.predictedSum / entry.bucket.count),
      realizedMargin: round(fitted[index]!),
      rawRealizedMargin: round(raw[index]!),
      realizedLow: round(entry.interval.low),
      realizedHigh: round(entry.interval.high),
      count: entry.bucket.count,
    }));
    calibration.push({ horizon, points });
  }

  const dates = observations.map((o) => o.dateIso).sort();
  return {
    builtAtIso: options.builtAtIso,
    source: options.source,
    sampleFromIso: dates[0] ?? "",
    sampleToIso: dates.at(-1) ?? "",
    bucketCount: options.bucketCount,
    maxHorizon: options.maxHorizon,
    standardizedReturnBuckets,
    sampleCounts,
    calibration,
  };
}
