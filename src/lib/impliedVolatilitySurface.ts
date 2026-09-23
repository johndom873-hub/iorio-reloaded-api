import { standardNormalCdf } from "./blackScholesPop.js";

// Implied-volatility surface for the IORIO Signal Engine (Phase 1 input to
// Edge(K,T) = IV_SVI − RV_forecast). Formulas and every choice below were
// approved by Marcelo on 2026-09-22: per-expiry RAW SVI (option A), quote
// spread cap 50% of the mid, forward = spot minus PV of dividends carried at
// the risk-free rate. See the guiding artifact §03/§13 and PROGRESS.md
// ("SVI exploratory fit") for the evidence (real AAOI chain, 2026-09-21).
//
//   Forward   F = (S − Σ dᵢ·e^(−r·tᵢ)) · e^(r·T)          k = ln(K / F)
//   Mid IV    σ such that Black-Scholes(F,K,T,r,σ) = (bid+ask)/2, OTM side only
//   Raw SVI   w(k) = a + b·[ρ(k−m) + √((k−m)² + σ²)],      w = IV²·T
//   No-arb    butterfly g(k) ≥ 0 (Gatheral & Jacquier 2014); calendar w(k,T₂) ≥ w(k,T₁)
//
// Fit: weighted least squares on total variance with weight 1/max(relSpread, 0.02)².
// For fixed (m, σ) the model is linear in (a, c = bρ, d = b), so those three are
// solved exactly (Zeliade 2009) and (m, σ) are found by a grid search refined once.
// The 3-parameter solution is then projected onto the approved constraints
// (b ≥ 0, |ρ| ≤ 0.98, σ ≥ 0.02, a + bσ√(1−ρ²) ≥ 0), so the reported objective is
// that of a feasible slice, not of an unconstrained one.

export const maximumAbsoluteRho = 0.98;
export const minimumSviSigma = 0.02;
export const maximumSpreadFractionOfMid = 0.5;
export const minimumSpreadWeightFloor = 0.02;
export const minimumPointsPerSlice = 8;
export const maximumSliceRmseVolatility = 0.03; // 3 volatility points
const calendarDaysPerYear = 365;

// --- forward ---------------------------------------------------------------

export interface DiscreteDividend {
  amount: number;
  /** Years from now to the ex-dividend date. */
  yearsToExDividend: number;
}

/** F = (S − PV of dividends going ex before expiry) · e^(rT). Dividends at or after expiry are ignored. */
export function computeForwardPrice(spotPrice: number, riskFreeRate: number, yearsToExpiry: number, dividends: DiscreteDividend[] = []): number {
  const presentValueOfDividends = dividends
    .filter((dividend) => dividend.yearsToExDividend >= 0 && dividend.yearsToExDividend < yearsToExpiry)
    .reduce((sum, dividend) => sum + dividend.amount * Math.exp(-riskFreeRate * dividend.yearsToExDividend), 0);
  return (spotPrice - presentValueOfDividends) * Math.exp(riskFreeRate * yearsToExpiry);
}

export function yearsBetweenIsoDates(fromIso: string, toIso: string): number {
  return (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000 / calendarDaysPerYear;
}

export interface KnownExDividend {
  date: string; // ISO YYYY-MM-DD
  amount: number;
}

// Approved 2026-09-23: only the *next* ex-dividend date is captured per ticker
// (no dividend-schedule data source chosen), which understates the forward for
// payers with another ex-div date before a 60-90 day expiry (common for
// monthly/quarterly payers). Rather than integrate a new data source, project
// additional ex-dividends by repeating the gap to the most recently known past
// ex-dividend (same amount, no growth assumption) until the furthest expiry
// being fit. Falls back to the single next dividend, unchanged, when there's
// no past record or the gap doesn't look like a regular cadence.
export const minimumRegularDividendCadenceDays = 20;
export const maximumRegularDividendCadenceDays = 400;
export const maximumProjectedDividends = 6;

/** Whether the gap between two known ex-dividend dates looks like a regular cadence worth projecting forward. */
export function isRegularDividendCadence(next: KnownExDividend | null, past: KnownExDividend | null): boolean {
  if (next === null || past === null) return false;
  const cadenceDays = Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${past.date}T00:00:00Z`)) / 86_400_000);
  return cadenceDays >= minimumRegularDividendCadenceDays && cadenceDays <= maximumRegularDividendCadenceDays;
}

/** Builds the dividend list for computeForwardPrice, projecting a regular cadence forward when possible. */
export function projectDividendSchedule(tradingDateIso: string, next: KnownExDividend | null, past: KnownExDividend | null, horizonEndDateIso: string): DiscreteDividend[] {
  if (next === null) return [];
  const nextDividend: DiscreteDividend = { amount: next.amount, yearsToExDividend: yearsBetweenIsoDates(tradingDateIso, next.date) };
  if (!isRegularDividendCadence(next, past)) return [nextDividend];

  const cadenceDays = Math.round((Date.parse(`${next.date}T00:00:00Z`) - Date.parse(`${past!.date}T00:00:00Z`)) / 86_400_000);
  const dividends: DiscreteDividend[] = [nextDividend];
  let projectedDateMs = Date.parse(`${next.date}T00:00:00Z`);
  for (let i = 0; i < maximumProjectedDividends; i++) {
    projectedDateMs += cadenceDays * 86_400_000;
    const projectedIso = new Date(projectedDateMs).toISOString().slice(0, 10);
    if (projectedIso >= horizonEndDateIso) break;
    dividends.push({ amount: next.amount, yearsToExDividend: yearsBetweenIsoDates(tradingDateIso, projectedIso) });
  }
  return dividends;
}

// --- Black-Scholes and implied volatility from a price -----------------------

/** Discounted Black-Scholes value written on the forward (Black-76). */
export function blackScholesPriceOnForward(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number, isCall: boolean): number {
  const totalStandardDeviation = volatility * Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * totalStandardDeviation * totalStandardDeviation) / totalStandardDeviation;
  const d2 = d1 - totalStandardDeviation;
  const discount = Math.exp(-riskFreeRate * yearsToExpiry);
  return discount * (isCall ? forward * standardNormalCdf(d1) - strike * standardNormalCdf(d2) : strike * standardNormalCdf(-d2) - forward * standardNormalCdf(-d1));
}

/** Black-76 delta, discounted: e^(-rT)N(d1) for a call, -e^(-rT)N(-d1) for a put. */
export function blackScholesDelta(forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, volatility: number, isCall: boolean): number {
  const totalStandardDeviation = volatility * Math.sqrt(yearsToExpiry);
  const d1 = (Math.log(forward / strike) + 0.5 * totalStandardDeviation * totalStandardDeviation) / totalStandardDeviation;
  const discount = Math.exp(-riskFreeRate * yearsToExpiry);
  return isCall ? discount * standardNormalCdf(d1) : -discount * standardNormalCdf(-d1);
}

const impliedVolatilityLowerBound = 0.01;
const impliedVolatilityUpperBound = 5;

/** Bisection; null when the price lies outside what volatilities in [1%, 500%] can produce (below intrinsic, or absurdly high). */
export function impliedVolatilityFromPrice(price: number, forward: number, strike: number, yearsToExpiry: number, riskFreeRate: number, isCall: boolean): number | null {
  if (!(price > 0) || !(yearsToExpiry > 0) || !(forward > 0) || !(strike > 0)) return null;
  let low = impliedVolatilityLowerBound;
  let high = impliedVolatilityUpperBound;
  if (price <= blackScholesPriceOnForward(forward, strike, yearsToExpiry, riskFreeRate, low, isCall)) return null;
  if (price >= blackScholesPriceOnForward(forward, strike, yearsToExpiry, riskFreeRate, high, isCall)) return null;
  for (let iteration = 0; iteration < 80; iteration++) {
    const middle = (low + high) / 2;
    if (blackScholesPriceOnForward(forward, strike, yearsToExpiry, riskFreeRate, middle, isCall) > price) high = middle;
    else low = middle;
  }
  return (low + high) / 2;
}

// --- fit points from quotes --------------------------------------------------

export interface SurfaceQuote {
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
}

export interface SviFitPoint {
  /** ln(K/F). */
  logMoneyness: number;
  /** Implied total variance IV²·T. */
  totalVariance: number;
  weight: number;
}

export interface FitPointDropCounts {
  inTheMoney: number;
  noTwoSidedQuote: number;
  spreadTooWide: number;
  noImpliedVolatility: number;
}

/** OTM quotes only (puts below the forward, calls at or above), bid > 0, ask > bid, spread ≤ 50% of the mid, solvable IV. */
export function buildSviFitPoints(quotes: SurfaceQuote[], forward: number, yearsToExpiry: number, riskFreeRate: number): { points: SviFitPoint[]; dropped: FitPointDropCounts } {
  const dropped: FitPointDropCounts = { inTheMoney: 0, noTwoSidedQuote: 0, spreadTooWide: 0, noImpliedVolatility: 0 };
  const points: SviFitPoint[] = [];
  for (const quote of quotes) {
    const isCall = quote.right === "C";
    if (isCall !== quote.strike >= forward) {
      dropped.inTheMoney++;
      continue;
    }
    if (quote.bid === null || quote.ask === null || !(quote.bid > 0) || !(quote.ask > quote.bid)) {
      dropped.noTwoSidedQuote++;
      continue;
    }
    const mid = (quote.bid + quote.ask) / 2;
    const relativeSpread = (quote.ask - quote.bid) / mid;
    if (relativeSpread > maximumSpreadFractionOfMid) {
      dropped.spreadTooWide++;
      continue;
    }
    const impliedVolatility = impliedVolatilityFromPrice(mid, forward, quote.strike, yearsToExpiry, riskFreeRate, isCall);
    if (impliedVolatility === null) {
      dropped.noImpliedVolatility++;
      continue;
    }
    points.push({
      logMoneyness: Math.log(quote.strike / forward),
      totalVariance: impliedVolatility * impliedVolatility * yearsToExpiry,
      weight: 1 / Math.max(relativeSpread, minimumSpreadWeightFloor) ** 2,
    });
  }
  return { points, dropped };
}

// --- raw SVI ----------------------------------------------------------------

export interface RawSviParameters {
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
}

export function sviTotalVariance(parameters: RawSviParameters, logMoneyness: number): number {
  const shifted = logMoneyness - parameters.m;
  return parameters.a + parameters.b * (parameters.rho * shifted + Math.sqrt(shifted * shifted + parameters.sigma * parameters.sigma));
}

/** The density function g(k) of Gatheral & Jacquier (2014); g(k) ≥ 0 for all k means no butterfly arbitrage. */
export function sviButterflyDensity(parameters: RawSviParameters, logMoneyness: number): number {
  const shifted = logMoneyness - parameters.m;
  const root = Math.sqrt(shifted * shifted + parameters.sigma * parameters.sigma);
  const w = sviTotalVariance(parameters, logMoneyness);
  const firstDerivative = parameters.b * (parameters.rho + shifted / root);
  const secondDerivative = (parameters.b * parameters.sigma * parameters.sigma) / (root * root * root);
  return (1 - (logMoneyness * firstDerivative) / (2 * w)) ** 2 - ((firstDerivative * firstDerivative) / 4) * (1 / w + 0.25) + secondDerivative / 2;
}

/** Minimum of g(k) on a 401-point grid over [kMin, kMax]. */
export function minimumButterflyDensity(parameters: RawSviParameters, kMin: number, kMax: number): number {
  let minimum = Infinity;
  for (let step = 0; step <= 400; step++) minimum = Math.min(minimum, sviButterflyDensity(parameters, kMin + ((kMax - kMin) * step) / 400));
  return minimum;
}

function solveThreeByThree(matrix: number[][], rightHandSide: number[]): number[] | null {
  const augmented = matrix.map((row, index) => [...row, rightHandSide[index] as number]);
  for (let pivotColumn = 0; pivotColumn < 3; pivotColumn++) {
    let pivotRow = pivotColumn;
    for (let row = pivotColumn + 1; row < 3; row++) if (Math.abs(augmented[row]![pivotColumn]!) > Math.abs(augmented[pivotRow]![pivotColumn]!)) pivotRow = row;
    [augmented[pivotColumn], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[pivotColumn]!];
    const pivot = augmented[pivotColumn]![pivotColumn]!;
    if (Math.abs(pivot) < 1e-14) return null;
    for (let column = pivotColumn; column <= 3; column++) augmented[pivotColumn]![column]! /= pivot;
    for (let row = 0; row < 3; row++) {
      if (row === pivotColumn) continue;
      const factor = augmented[row]![pivotColumn]!;
      for (let column = pivotColumn; column <= 3; column++) augmented[row]![column]! -= factor * augmented[pivotColumn]![column]!;
    }
  }
  return augmented.map((row) => row[3] as number);
}

interface InnerFit {
  parameters: RawSviParameters;
  weightedSquaredError: number;
}

/** For fixed (m, σ): exact weighted LS for (a, c, d), then projection onto the approved constraints. */
function fitInner(points: SviFitPoint[], m: number, sigma: number): InnerFit | null {
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const target = [0, 0, 0];
  for (const point of points) {
    const shifted = point.logMoneyness - m;
    const basis = [1, shifted, Math.sqrt(shifted * shifted + sigma * sigma)];
    for (let row = 0; row < 3; row++) {
      target[row]! += point.weight * basis[row]! * point.totalVariance;
      for (let column = 0; column < 3; column++) normal[row]![column]! += point.weight * basis[row]! * basis[column]!;
    }
  }
  const solution = solveThreeByThree(normal, target);
  if (!solution) return null;
  let [a, c, d] = solution as [number, number, number];
  d = Math.max(d, 1e-9); // b >= 0
  c = Math.max(-maximumAbsoluteRho * d, Math.min(maximumAbsoluteRho * d, c)); // |rho| <= 0.98
  a = Math.max(a, -sigma * Math.sqrt(Math.max(d * d - c * c, 0))); // a + b*sigma*sqrt(1-rho^2) >= 0
  const parameters: RawSviParameters = { a, b: d, rho: c / d, m, sigma };
  let weightedSquaredError = 0;
  for (const point of points) weightedSquaredError += point.weight * (sviTotalVariance(parameters, point.logMoneyness) - point.totalVariance) ** 2;
  return { parameters, weightedSquaredError };
}

/** Grid search over (m, σ) with one refinement pass; null if the points cannot be fitted at all. */
export function fitRawSvi(points: SviFitPoint[]): RawSviParameters | null {
  if (points.length < 3) return null;
  const logMoneyness = points.map((point) => point.logMoneyness);
  const kMin = Math.min(...logMoneyness);
  const kMax = Math.max(...logMoneyness);
  const sigmaLow = minimumSviSigma;
  const sigmaHigh = 0.6;

  const search = (mLow: number, mHigh: number, sLow: number, sHigh: number, steps: number): InnerFit | null => {
    let best: InnerFit | null = null;
    for (let mIndex = 0; mIndex <= steps; mIndex++) {
      for (let sIndex = 0; sIndex <= steps; sIndex++) {
        const m = mLow + ((mHigh - mLow) * mIndex) / steps;
        const sigma = sLow * Math.pow(sHigh / sLow, sIndex / steps);
        const candidate = fitInner(points, m, sigma);
        if (candidate && (!best || candidate.weightedSquaredError < best.weightedSquaredError)) best = candidate;
      }
    }
    return best;
  };

  const coarseSteps = 40;
  const coarse = search(kMin, kMax, sigmaLow, sigmaHigh, coarseSteps);
  if (!coarse) return null;
  const mStep = (kMax - kMin) / coarseSteps;
  const sigmaRatio = Math.pow(sigmaHigh / sigmaLow, 1 / coarseSteps);
  const fine = search(
    Math.max(kMin, coarse.parameters.m - mStep),
    Math.min(kMax, coarse.parameters.m + mStep),
    Math.max(sigmaLow, coarse.parameters.sigma / sigmaRatio),
    Math.min(sigmaHigh, coarse.parameters.sigma * sigmaRatio),
    coarseSteps,
  );
  return (fine && fine.weightedSquaredError < coarse.weightedSquaredError ? fine : coarse).parameters;
}

// --- slice quality and arbitrage flags ----------------------------------------

export type SviSliceStatus = "ok" | "insufficient_points" | "fit_failed" | "poor_fit" | "butterfly_arbitrage";

export interface SviSliceFit {
  status: SviSliceStatus;
  parameters: RawSviParameters | null;
  pointCount: number;
  /** Root-mean-square miss in implied-volatility units (0.01 = one volatility point). */
  rmseVolatility: number | null;
  minimumButterflyDensity: number | null;
  kMin: number | null;
  kMax: number | null;
}

/** Fits one expiry and applies the approved gates: ≥ 8 points, RMSE ≤ 3 vol points, no butterfly arbitrage (flagged, never silently used). */
export function fitSviSlice(points: SviFitPoint[], yearsToExpiry: number): SviSliceFit {
  const empty = (status: SviSliceStatus, parameters: RawSviParameters | null = null): SviSliceFit => ({ status, parameters, pointCount: points.length, rmseVolatility: null, minimumButterflyDensity: null, kMin: null, kMax: null });
  if (points.length < minimumPointsPerSlice) return empty("insufficient_points");
  const parameters = fitRawSvi(points);
  if (!parameters) return empty("fit_failed");

  const squaredMisses = points.map((point) => {
    const fittedVolatility = Math.sqrt(Math.max(sviTotalVariance(parameters, point.logMoneyness), 0) / yearsToExpiry);
    const marketVolatility = Math.sqrt(point.totalVariance / yearsToExpiry);
    return (fittedVolatility - marketVolatility) ** 2;
  });
  const rmseVolatility = Math.sqrt(squaredMisses.reduce((sum, value) => sum + value, 0) / squaredMisses.length);
  const logMoneyness = points.map((point) => point.logMoneyness);
  const kMin = Math.min(...logMoneyness);
  const kMax = Math.max(...logMoneyness);
  const minimumDensity = minimumButterflyDensity(parameters, kMin, kMax);

  let status: SviSliceStatus = "ok";
  if (rmseVolatility > maximumSliceRmseVolatility) status = "poor_fit";
  else if (minimumDensity < 0) status = "butterfly_arbitrage";
  return { status, parameters, pointCount: points.length, rmseVolatility, minimumButterflyDensity: minimumDensity, kMin, kMax };
}

export interface CalendarSlice {
  yearsToExpiry: number;
  parameters: RawSviParameters;
  kMin: number;
  kMax: number;
}

/** Counts violations of w(k, T₂) ≥ w(k, T₁) on 21 points of each adjacent pair's shared log-moneyness range. */
export function checkCalendarArbitrage(slices: CalendarSlice[]): { checks: number; violations: number } {
  const ordered = [...slices].sort((first, second) => first.yearsToExpiry - second.yearsToExpiry);
  let checks = 0;
  let violations = 0;
  for (let index = 1; index < ordered.length; index++) {
    const earlier = ordered[index - 1]!;
    const later = ordered[index]!;
    const low = Math.max(earlier.kMin, later.kMin);
    const high = Math.min(earlier.kMax, later.kMax);
    if (low > high) continue;
    for (let step = 0; step <= 20; step++) {
      const k = low + ((high - low) * step) / 20;
      checks++;
      if (sviTotalVariance(later.parameters, k) < sviTotalVariance(earlier.parameters, k) - 1e-9) violations++;
    }
  }
  return { checks, violations };
}
