import { easternInstant } from "../../lib/easternIsoDate.js";
import { isRegularDividendCadence } from "../../lib/impliedVolatilitySurface.js";
import { calendarDaysUntilExpiry, captureBothSidesWithinFractionOfSpot, captureMaximumDaysToExpiry, captureMinimumDaysToExpiry, computeStrikeWindow, selectContractsToCapture, type StrikeWindow } from "../../lib/optionChainCaptureWindow.js";
import { chooseReferenceVolatility } from "../../lib/optionChainCaptureReferenceVolatility.js";
import { commissionPerContractDollars } from "../../lib/optionFriction.js";
import { describeOptionContract, describeOrderSize, daysToExpiry } from "../../lib/optionContractLabel.js";
import { computeOrderNotional, evaluateOrderLimitFigures } from "../../lib/orderLimits.js";
import { fitSurfaceForSnapshot, type FittedExpiry } from "../../lib/optionSurfaceFitting.js";
import { computeYangZhangVolatility } from "../../lib/realizedVolatility.js";
import type { SignalCandidate, SignalQuote, SignalSurfaceSlice } from "../../lib/signalCandidates.js";
import { contractKey, scoreTicker } from "../../lib/signalsLiveScoring.js";
import type { SnapshotHeader, TickerSignals, TickerSignalsInputs } from "../../lib/signalsTypes.js";
import { addCalendarDays } from "../../lib/signalsRoadmap.js";
import { computeElevatedVolatilityFlag, computeMomentum, computeSkew, type ElevatedVolatilityFlag } from "../../lib/tiltMeasures.js";
import type { TradingSettings } from "../../lib/tradingSettingsStore.js";
import { primaryForecastWindowDays, selectModelVolatilityForecast, selectRealizedVolatilityForecast } from "../../lib/volatilityEdge.js";
import type { ValuationGroup, VolatilityModelTables } from "../../lib/volatilityModelTables.js";
import { countPlutoRejections } from "../../pluto/rejectionSummary.js";
import { deterministicTopPick, filterTickerForPluto, findSameContractConflict, openCandidateId, type OccupiedContract, type PlutoOpenCandidate } from "../../pluto/candidateFilters.js";
import type { PlutoDecision } from "../../pluto/decisionSchema.js";
import { computeKellyCap, computeStressCap, runPostModelGates, stressCapInputFor, tickerCooldownStatus } from "../../pluto/postModelGates.js";
import type { BacktestSettings } from "../backtestTypes.js";
import { toOhlcvBars, type BacktestBarHistory } from "./backtestBarHistory.js";
import { computeSaleFillPrice, sharesPerContract } from "./backtestBook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import type { BacktestTradingCalendar } from "./backtestTradingCalendar.js";

// One backtest day's decision at 10:00 ET (docs/backtesting/FORMULAS.md): the live pipeline on history. The day's quotes
// go through the capture's own contract selection and the same surface fit (optionSurfaceFitting.ts), the inputs are
// built as loadTickerSignalsInputs builds them (from the bars before today, the file's open interest and the previous
// session's volume), then scoreTicker → Pluto's open filters → the deterministic top pick → Pluto's post-model gates
// (sizing with the session's Kelly fraction) → the order gate's three limits → a fill at mid − λ × half-spread.
//
// What live Pluto checks that a 10:00 replay cannot, and how it is neutralised:
//   - quote age: Pluto decides at the capture instant, so every 10:00 quote is 0 minutes old (nowMs = 10:00)
//   - the fresh re-score and edge drift before the order: the re-score is the same 10:00 data, so it passes unchanged
//   - the model's own choice, its confidence and data concerns: replaced by the deterministic top pick (confidence 1)
//   - market stress (SPY intraday), the daily-loss breaker, the trading window, working orders, in-flight notional:
//     not replayed (no intraday SPY history; one look a day; fills are immediate)

/** The live capture's widest strike window (runOptionChainCapture.ts) when no reference volatility exists. */
const widestStrikeWindowHalfWidth = 0.5;
/** Bars the capture's reference volatility reads (runOptionChainCapture.ts). */
const referenceVolatilityBarCount = 40;
/** Bars loadBarsForTilt reads. */
const tiltBarCount = 1500;
/** Rows loadVolatilityForecasts reads. */
const forecastBarRowCount = primaryForecastWindowDays + 1 + 20;
const decisionTimeEt = { hour: 10, minute: 0 };

export interface BacktestTickerProfile {
  tickerId: string;
  symbol: string;
  companyName: string | null;
  sector: string | null;
  valuationGroup: ValuationGroup;
  /** False for an ETF: no earnings or ex-dividend checks (tickerCalendarProfile). */
  calendarChecksApply: boolean;
  earningsCalendarResolved: boolean;
  /** Ascending. event_time "-1" = before the open. */
  earnings: { dateIso: string; eventTime: string | null }[];
  /** Ascending. */
  exDividends: { dateIso: string; amount: number | null }[];
}

export interface BacktestDayMarket {
  todayIso: string;
  /** Every 10:00 quote of the day in the file. */
  quotes: readonly SymbolFileQuote[];
  /** Open interest published for today, by contractKey. */
  openInterestByContract: ReadonlyMap<string, number>;
  /** The previous session's full volume, by contractKey; null when the file has no previous session. */
  previousSessionVolumeByContract: ReadonlyMap<string, number> | null;
  /** The 10:00 stock price (put-call parity). */
  stockPrice: number;
  /** DTB3 known at 10:00 (the latest observation before today), percent. */
  riskFreeRatePercent: number | null;
}

/** The simulated book as Pluto's sizing reads it, at the 10:00 marks. */
export interface BacktestBookView {
  netLiquidationValue: number;
  cash: number;
  freeCash: number;
  cashLockedInPuts: number;
  /** Σ EXP $ at the open of the open positions (Pluto's committed dollars). */
  committedDollars: number;
  /** Σ exposure at today's marks (the live existing ticker exposure). */
  markedExposureDollars: number;
  openPositionCount: number;
  occupiedContracts: OccupiedContract[];
  /** 10:00 of the day of the last open (the ticker cooldown's clock); null before the first. */
  lastOpenedAtMs: number | null;
}

export interface BacktestDayContext {
  profile: BacktestTickerProfile;
  bars: BacktestBarHistory;
  market: BacktestDayMarket;
  book: BacktestBookView;
  settings: BacktestSettings;
  calendar: BacktestTradingCalendar;
  modelTables: VolatilityModelTables;
  /** Precomputed elevated-volatility flag for the day; computed from the bars when absent. */
  elevatedVolatility?: ElevatedVolatilityFlag | null;
}

export interface BacktestOpenOrder {
  candidate: SignalCandidate;
  quantity: number;
  /** Pluto's order limit (mid, rounded, inside the market). */
  limitPrice: number;
  /** The simulated sale price per share. */
  fillPrice: number;
  commissionDollars: number;
  kellyContracts: number | null;
  stressContracts: number | null;
}

export interface BacktestDayDecision {
  open: BacktestOpenOrder | null;
  summary: string;
  /** Why no surface was fitted (skip reason or "error: ..."), when none was. */
  fitIssue: string | null;
  scored: TickerSignals | null;
}

export function decisionInstantMs(todayIso: string): number {
  return easternInstant(todayIso, decisionTimeEt.hour, decisionTimeEt.minute).getTime();
}

/** The contracts the live 10:00 capture would have requested on this day (runOptionChainCapture.ts prepareTicker). */
export function selectCapturedQuotes(quotes: readonly SymbolFileQuote[], todayIso: string, stockPrice: number, referenceVolatility: number | null): SymbolFileQuote[] {
  const strikesByExpiry = new Map<string, Set<number>>();
  for (const quote of quotes) strikesByExpiry.set(quote.expiry, (strikesByExpiry.get(quote.expiry) ?? new Set()).add(quote.strike));
  const selected = new Set<string>();
  for (const [expiry, strikes] of strikesByExpiry) {
    const daysToExpiryCount = calendarDaysUntilExpiry(todayIso, expiry.replaceAll("-", ""));
    if (daysToExpiryCount < captureMinimumDaysToExpiry || daysToExpiryCount > captureMaximumDaysToExpiry) continue;
    const window: StrikeWindow | null =
      referenceVolatility !== null
        ? computeStrikeWindow({ spotPrice: stockPrice, atmImpliedVolatility: referenceVolatility, daysToExpiry: daysToExpiryCount })
        : { halfWidth: widestStrikeWindowHalfWidth, lowerBound: stockPrice * Math.exp(-widestStrikeWindowHalfWidth), upperBound: stockPrice * Math.exp(widestStrikeWindowHalfWidth) };
    if (!window) continue;
    for (const contract of selectContractsToCapture([...strikes], stockPrice, window, { bothSidesWithinFractionOfSpot: captureBothSidesWithinFractionOfSpot })) selected.add(contractKey({ expiry, ...contract }));
  }
  return quotes.filter((quote) => selected.has(contractKey(quote)));
}

/** The capture's reference volatility from the bars before today (loadReferenceVolatility + chooseReferenceVolatility). */
export function referenceVolatilityBefore(bars: BacktestBarHistory, todayIso: string): number | null {
  const rows = bars.rowsBefore(todayIso, referenceVolatilityBarCount);
  const latestWithImpliedVolatility = [...rows].reverse().find((row) => row.impliedVolatility !== null);
  const yangZhang = computeYangZhangVolatility(toOhlcvBars(rows), 21);
  return chooseReferenceVolatility({
    todayIso,
    latestImpliedVolatility: latestWithImpliedVolatility?.impliedVolatility ?? null,
    latestImpliedVolatilityDateIso: latestWithImpliedVolatility?.tradingDate ?? null,
    yangZhang21DayVolatility: yangZhang.available ? yangZhang.annualizedVolatility : null,
  }).volatility;
}

/** A fitted expiry as the Signals loader reads it back from option_surface_fits (optionSurfaceStore.ts → signalsStore.ts loadSlices). */
export function fittedExpiryToSlice(fitted: FittedExpiry): SignalSurfaceSlice {
  return {
    expiry: fitted.expiry,
    status: fitted.slice.status,
    yearsToExpiry: fitted.yearsToExpiry,
    forwardPrice: fitted.forwardPrice,
    fitUnderlyingPrice: fitted.underlyingPrice,
    kMin: fitted.slice.kMin,
    kMax: fitted.slice.kMax,
    parameters: fitted.slice.parameters,
    pointCount: fitted.slice.pointCount,
    rmseVolatility: fitted.slice.rmseVolatility,
    minButterflyDensity: fitted.slice.minimumButterflyDensity,
    droppedCounts: fitted.dropped,
    calendarChecks: fitted.calendarChecks,
    calendarViolations: fitted.calendarViolations,
  };
}

/** Earnings the Signals exclusion checks on a day: from today on, except a report today before the open (loadEarningsDatesNotYetReported). */
export function earningsNotYetReported(earnings: BacktestTickerProfile["earnings"], todayIso: string): string[] {
  return earnings.filter((event) => event.dateIso >= todayIso && !(event.dateIso === todayIso && event.eventTime === "-1")).map((event) => event.dateIso);
}

/** Builds the day's TickerSignalsInputs the way loadTickerSignalsInputs does, from history. */
export function buildHistoricalTickerInputs(context: BacktestDayContext): { inputs: TickerSignalsInputs; fitIssue: string | null } {
  const { profile, bars, market } = context;
  const todayIso = market.todayIso;
  const capturedAtIso = new Date(decisionInstantMs(todayIso)).toISOString();

  const nextExDividend = profile.exDividends.find((event) => event.dateIso >= todayIso) ?? null;
  const pastExDividend = [...profile.exDividends].reverse().find((event) => event.dateIso < todayIso) ?? null;
  const captured = selectCapturedQuotes(market.quotes, todayIso, market.stockPrice, referenceVolatilityBefore(bars, todayIso));
  let slices: SignalSurfaceSlice[] = [];
  let fitIssue: string | null = null;
  try {
    const outcome = fitSurfaceForSnapshot({
      tradingDate: todayIso,
      spotPrice: market.stockPrice,
      riskFreeRatePercent: market.riskFreeRatePercent,
      nextExDividendDate: nextExDividend?.dateIso ?? null,
      nextExDividendAmount: nextExDividend?.amount ?? null,
      pastExDividendDate: pastExDividend?.dateIso ?? null,
      pastExDividendAmount: pastExDividend?.amount ?? null,
      quotes: captured.map((quote) => ({ expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask })),
    });
    if (outcome.kind === "skipped") fitIssue = outcome.reason;
    else slices = outcome.expiries.map(fittedExpiryToSlice);
  } catch (error) {
    fitIssue = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  const header: SnapshotHeader = { snapshotId: `backtest:${todayIso}`, tradingDateIso: todayIso, capturedAt: capturedAtIso, underlyingPrice: market.stockPrice, riskFreeRatePercent: market.riskFreeRatePercent, fitCompletedAt: capturedAtIso, fitIssue };
  const quotes: SignalQuote[] = captured.map((quote) => {
    const key = contractKey(quote);
    return { expiry: quote.expiry, strike: quote.strike, right: quote.right, bid: quote.bid, ask: quote.ask, source: "snapshot", openInterest: market.openInterestByContract.get(key) ?? null, volume: market.previousSessionVolumeByContract?.get(key) ?? null, bidSize: quote.bidSize, askSize: quote.askSize };
  });

  const forecastBars = toOhlcvBars(bars.rowsBefore(todayIso, forecastBarRowCount));
  const tiltBars = toOhlcvBars(bars.rowsBefore(todayIso, tiltBarCount));
  const earningsDatesIso = profile.calendarChecksApply ? earningsNotYetReported(profile.earnings, todayIso) : [];
  const furthestExpiry = slices.map((slice) => slice.expiry).sort().at(-1);

  const inputs: TickerSignalsInputs = {
    tickerId: profile.tickerId,
    symbol: profile.symbol,
    companyName: profile.companyName,
    sector: profile.sector,
    header,
    slices,
    quotes,
    dayQuotes: [],
    forecast: selectRealizedVolatilityForecast(forecastBars),
    modelForecast: selectModelVolatilityForecast(forecastBars),
    openSessionDatesIso: furthestExpiry && furthestExpiry > todayIso ? context.calendar.openDaysBetween(addCalendarDays(todayIso, 1), furthestExpiry) : [],
    tradingSessions: furthestExpiry ? context.calendar.sessionsBetween(todayIso, furthestExpiry) : [],
    valuationGroup: profile.valuationGroup,
    earningsDatesIso,
    earningsCalendarResolved: profile.earningsCalendarResolved,
    macroEvents: [],
    momentum: computeMomentum(tiltBars.map((bar) => bar.close)),
    elevatedVolatility: context.elevatedVolatility !== undefined ? context.elevatedVolatility : computeElevatedVolatilityFlag(tiltBars),
    skew: computeSkew(slices),
    nextEarningsDateIso: profile.calendarChecksApply ? (earningsDatesIso[0] ?? null) : null,
    previousClose: bars.previousClose(todayIso),
    freeShares: 0,
    openShortLegs: [],
    dailyBarCount: bars.countBefore(todayIso),
    // loadDividendCadenceUnknown: an upcoming ex-dividend with no regular cadence to project later ones from.
    dividendCadenceUnknown: nextExDividend !== null && !isRegularDividendCadence({ date: nextExDividend.dateIso, amount: Number(nextExDividend.amount) }, pastExDividend ? { date: pastExDividend.dateIso, amount: Number(pastExDividend.amount) } : null),
    todayEasternIso: todayIso,
  };
  return { inputs, fitIssue };
}

function describeSale(symbol: string, candidate: SignalCandidate, todayIso: string, quantity: number, price: number): string {
  const right = candidate.strategyKey === "covered_call" ? "C" : "P";
  return `${symbol} Sell ${describeOptionContract({ strike: candidate.strike, right, expiry: candidate.expiry, dte: daysToExpiry(candidate.expiry, todayIso) })}${describeOrderSize(quantity, price)}`;
}

function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

/** "grade 40, edge_yield 30" — the rules that rejected the most contracts, most first. */
function describeRejectionCounts(counts: Partial<Record<string, number>>, limit = 4): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
    .slice(0, limit)
    .map(([code, count]) => `${code} ${count}`)
    .join(", ");
}

function noOpen(summary: string, fitIssue: string | null, scored: TickerSignals | null): BacktestDayDecision {
  return { open: null, summary: `No open: ${summary}`, fitIssue, scored };
}

/** The day's 10:00 look: at most one opening sale (Pluto's ticker cooldown allows one per symbol per look). */
export function decideBacktestDay(context: BacktestDayContext): BacktestDayDecision {
  const { profile, market, book, settings } = context;
  const pluto = settings.pluto;
  const trading = settings.trading as TradingSettings;
  const todayIso = market.todayIso;
  const nowMs = decisionInstantMs(todayIso);
  if (pluto.maxActionsPerSession <= 0) return noOpen(`actions cap: 0 of ${pluto.maxActionsPerSession} actions a session allowed`, null, null);

  const { inputs, fitIssue } = buildHistoricalTickerInputs(context);
  const scored = scoreTicker(inputs, { freeCash: book.freeCash }, trading, { spotPrice: market.stockPrice, priceSource: "live", liveQuotes: [] }, undefined, { modelTables: context.modelTables, scoredAtMs: nowMs });

  const cooldown = tickerCooldownStatus(book.lastOpenedAtMs === null ? null : new Date(book.lastOpenedAtMs), nowMs, pluto.tickerCooldownMinutes);
  const filtered = filterTickerForPluto({ scored, slices: inputs.slices, settings: pluto, todayEasternIso: todayIso, nowMs, botEnabled: true, occupiedContracts: book.occupiedContracts, opensBlockedReason: cooldown.cooledDown ? null : `ticker cooldown: ${cooldown.detail}` });
  if (filtered.tickerBlocks.length > 0) return noOpen(filtered.tickerBlocks.join("; ") + (fitIssue ? ` (${fitIssue})` : ""), fitIssue, scored);

  const topPick: PlutoOpenCandidate | null = deterministicTopPick(filtered.eligible);
  if (!topPick) {
    if (scored.candidates.length === 0) {
      const reason = scored.noCandidatesReason;
      const detail = reason ? `${reason.kind === "filtered" ? "all filtered by the trading settings" : "nothing scorable"}: delta below ${reason.deltaTargetMin} ${reason.belowMinDeltaCount}, above ${reason.deltaTargetMax} ${reason.aboveMaxDeltaCount}, yield below ${reason.minAnnualizedYieldPct}% ${reason.belowMinYieldCount}${reason.spansEarningsExpiries.length > 0 ? `, ${reason.spansEarningsExpiries.length} expiries span earnings ${reason.earningsDateIso ?? ""}` : ""}${reason.surfaceFitRejectedExpiries.length > 0 ? `, ${reason.surfaceFitRejectedExpiries.length} expiries without a usable fit` : ""}` : "";
      return noOpen(`no candidates${detail ? ` (${detail.trim()})` : ""}`, fitIssue, scored);
    }
    const counts = countPlutoRejections(filtered.rejected);
    return noOpen(`${scored.candidates.length} candidates, none eligible (rejected by ${describeRejectionCounts(counts.rejectedBy)}; only blocker ${describeRejectionCounts(counts.onlyBlocker) || "none"})`, fitIssue, scored);
  }

  const candidate = topPick.candidate;
  const model = candidate.model!;
  const decision: PlutoDecision = { decision: "trade", actionKind: topPick.kind, candidateId: topPick.id, confidence: 1, reasons: ["deterministic top pick (backtest)"], risksAcknowledged: [], systemConcerns: [] };
  const stress = stressCapInputFor(scored);
  const gates = runPostModelGates({
    decision,
    candidate,
    roll: null,
    freshRejectionReasons: [],
    marginAtDecision: model.edgeMargin,
    settings: pluto,
    sector: profile.sector,
    book: {
      netLiquidationValue: book.netLiquidationValue,
      freeCash: book.freeCash,
      committedDollars: book.committedDollars,
      inFlight: { totalNotional: 0, tickerNotional: 0, managedNotional: 0 },
      openPositionCount: book.openPositionCount,
      existingTickerExposure: book.markedExposureDollars,
      existingSectorExposure: profile.sector === null ? 0 : book.markedExposureDollars,
      freeShares: 0,
      spotPrice: market.stockPrice,
      workingOrderOnSymbol: false,
      lastFilledActionAt: book.lastOpenedAtMs === null ? null : new Date(book.lastOpenedAtMs),
      nowMs,
      sameContractConflict: findSameContractConflict(book.occupiedContracts, candidate.expiry, candidate.strike),
    },
    stress,
    kellyFraction: settings.kellyFraction,
  });
  if (!gates.ok || !gates.plan) {
    const failed = gates.gates.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | ");
    return noOpen(`top pick ${openCandidateId(profile.symbol, candidate)} blocked by ${failed}`, fitIssue, scored);
  }

  const plan = gates.plan;
  const orderNotional = computeOrderNotional({ strategyKey: candidate.strategyKey, strike: candidate.strike, quantity: plan.quantity, premium: plan.limitPrice }, market.stockPrice, 0);
  const limits = evaluateOrderLimitFigures({ symbol: profile.symbol, orderNotional, totalPortfolioValue: book.netLiquidationValue, totalCashValue: book.cash, cashLockedInCsps: book.cashLockedInPuts, existingTickerExposure: book.markedExposureDollars, inFlight: { totalNotional: 0, tickerNotional: 0 }, settings: trading });
  if (limits.blocked) return noOpen(`top pick ${describeSale(profile.symbol, candidate, todayIso, plan.quantity, plan.limitPrice)} blocked by the order gate: ${limits.reasons.join(" ")}`, fitIssue, scored);

  const fillPrice = computeSaleFillPrice(candidate.bid, candidate.ask, trading.spreadCostChargedPct / 100);
  const commissionDollars = (candidate.commissionPerContractDollars ?? commissionPerContractDollars) * plan.quantity;
  const kellyCap = computeKellyCap(pluto, candidate, book.netLiquidationValue, settings.kellyFraction);
  const stressCap = computeStressCap(pluto, stress, candidate, market.stockPrice, book.netLiquidationValue);
  const sharesNote = candidate.strategyKey === "covered_call" ? ` with ${plan.quantity * sharesPerContract} shares bought @ ${market.stockPrice.toFixed(2)}` : "";
  return {
    open: {
      candidate,
      quantity: plan.quantity,
      limitPrice: plan.limitPrice,
      fillPrice,
      commissionDollars,
      kellyContracts: Number.isFinite(kellyCap.contracts) ? kellyCap.contracts : null,
      stressContracts: Number.isFinite(stressCap.contracts) ? stressCap.contracts : null,
    },
    summary: `Opened ${describeSale(profile.symbol, candidate, todayIso, plan.quantity, fillPrice)}${sharesNote} (grade ${model.grade}, Edge Yield ${formatPercent(model.expectedAnnualizedReturn)}, Hist Yield ${formatPercent(model.calibratedAnnualizedReturn)}; ${filtered.eligible.length} of ${scored.candidates.length} eligible)`,
    fitIssue,
    scored,
  };
}
