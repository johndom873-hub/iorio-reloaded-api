import { compareCandidatesByModel, type SignalCandidate, type SignalGrade, type SignalSurfaceSlice } from "../lib/signalCandidates.js";
import { expectedDailyMovePct } from "./moveContext.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import type { PlutoSettings } from "./settingsStore.js";
import { daysToExpiry, describeOptionContract, formatDayMonth, formatStrike } from "../lib/optionContractLabel.js";
import { yieldOnExposure } from "../lib/contractValuation.js";
import { checkCalledAway, commissionPerShare, describeCalledAwayShortfall, type CycleBreakEven } from "./heldShareCalls.js";

// Pluto's deterministic candidate filters (design round 3, item 20, approved 2026-09-28). Since the model review
// (approved by Marcelo 2026-10-10) every value rule reads the valuation model's block (grade, Edge Yield, premium
// yield, both on calendar days); the old Edge fields stay for the Signals screen only. Pure:
// the agent feeds it a scored ticker (every existing Signals filter already applied), the fit
// slices and the settings, and gets back exactly what the model may see, with a reason for
// everything it may not. Nothing here is a judgement call — every rule is a dial on the Pluto
// screen — so the model only ever chooses among contracts a human would also be allowed to trade.

const gradeRank: Record<SignalGrade, number> = { avoid: 0, weak: 1, good: 2, strong: 3 };

export interface PlutoOpenCandidate {
  /** Stable id the model answers with: symbol:strategy:expiry:strike. */
  id: string;
  kind: "open_covered_call" | "open_cash_secured_put";
  symbol: string;
  candidate: SignalCandidate;
  /** Set on a covered call written on shares already held: the contracts it covers and the cycle if it is assigned (heldShareCalls.ts). */
  heldShares?: { contracts: number; breakEvenAfter: number; profitIfCalledAway: number };
}

export interface PlutoRollCandidate {
  /** symbol:roll:<legId>:<expiry>:<strike> */
  id: string;
  kind: "roll";
  symbol: string;
  roll: RollSignalCandidate;
}

/** One stable code per filter rule, for counting why contracts were out; the reason text carries the numbers. */
export type PlutoRejectionCode =
  | "no_model"
  | "grade"
  | "edge_yield"
  | "delta"
  | "dte"
  | "yield"
  | "spread"
  | "open_interest"
  | "volume"
  | "quote_age"
  | "no_slice"
  | "slice_rmse"
  | "slice_points"
  | "calendar_arbitrage"
  | "no_mid_iv"
  | "mid_iv_gap"
  | "iv_shift"
  | "outside_fitted_range"
  | "insufficient_cash"
  | "earnings_unresolved"
  | "not_executable"
  | "same_contract"
  | "opens_blocked"
  | "edge"
  | "below_break_even"
  | "no_break_even"
  | "held_shares_runner_up";

export interface PlutoRejectionReason {
  code: PlutoRejectionCode;
  reason: string;
}

export interface PlutoRejection {
  id: string;
  reasons: string[];
  /** The rule behind each entry of `reasons`, same order. */
  codes: PlutoRejectionCode[];
}

export function plutoRejection(id: string, failures: PlutoRejectionReason[]): PlutoRejection {
  return { id, reasons: failures.map((failure) => failure.reason), codes: failures.map((failure) => failure.code) };
}

export interface PlutoTickerFilterResult {
  symbol: string;
  /** Reasons the whole ticker is out this pass (nothing below it is evaluated). */
  tickerBlocks: string[];
  eligible: PlutoOpenCandidate[];
  eligibleRolls: PlutoRollCandidate[];
  rejected: PlutoRejection[];
  rejectedRolls: PlutoRejection[];
}

export interface PlutoTickerFilterInput {
  scored: TickerSignals;
  slices: SignalSurfaceSlice[];
  settings: PlutoSettings;
  todayEasternIso: string;
  nowMs: number;
  botEnabled: boolean;
  /** Contracts on this ticker already held (by anyone) or with a working order: Pluto never opens a second position on one. */
  occupiedContracts?: OccupiedContract[];
  /** Why no open on this ticker may be offered this round (the ticker cooldown); rolls and closes are unaffected. */
  opensBlockedReason?: string | null;
  /**
   * The ticker's open cycle, for the break-even rule on covered calls written on held shares and on covered-call rolls that
   * lower the strike (heldShareCalls.ts). Absent or null blocks exactly those, as an unknown break-even does.
   */
  cycleBreakEven?: CycleBreakEven | null;
}

/** A contract on the ticker that is already taken: an open option leg (anyone's) or a leg of a working order. */
export interface OccupiedContract {
  expiry: string;
  strike: number;
  detail: string;
}

/**
 * One position per ticker, expiry and strike, puts and calls alike (Marcelo, 2026-10-06): the platform keeps one
 * position per contract, so a second order on a held contract would merge into it, possibly a human's.
 */
export function findSameContractConflict(occupied: OccupiedContract[], expiry: string, strike: number): string | null {
  return occupied.find((entry) => entry.expiry === expiry && Math.abs(entry.strike - strike) < 0.0001)?.detail ?? null;
}

export function openCandidateId(symbol: string, candidate: Pick<SignalCandidate, "strategyKey" | "expiry" | "strike">): string {
  return `${symbol}:${candidate.strategyKey}:${candidate.expiry}:${candidate.strike}`;
}

export function rollCandidateId(symbol: string, roll: Pick<RollSignalCandidate, "legId" | "replacement">): string {
  return `${symbol}:roll:${roll.legId}:${roll.replacement.expiry}:${roll.replacement.strike}`;
}

/** A candidate id in the platform's contract wording ("SMCI $47 Call · 9 Oct (2DTE)"); a roll's id names only its new contract, a close only its kind. */
export function describeCandidateId(candidateId: string, todayIso: string): string {
  const [symbol, kind, ...rest] = candidateId.split(":");
  if ((kind === "covered_call" || kind === "cash_secured_put") && rest.length === 2) {
    const [expiry, strike] = rest as [string, string];
    return describeOptionContract({ symbol, strike: Number(strike), right: kind === "covered_call" ? "C" : "P", expiry, dte: daysToExpiry(expiry, todayIso) });
  }
  if (kind === "roll" && rest.length === 3) {
    const [, expiry, strike] = rest as [string, string, string];
    return `${symbol} Roll → ${formatStrike(Number(strike))} · ${formatDayMonth(expiry)} (${daysToExpiry(expiry, todayIso)}DTE)`;
  }
  if (kind === "close_leg") return `${symbol} Buy back`;
  if (kind === "close_shares") return `${symbol} Sell shares`;
  if (kind === "close_position") return `${symbol} Close covered Call`;
  return candidateId;
}

function quoteAgeMinutes(candidate: Pick<SignalCandidate, "quoteSource" | "quotedAt">, snapshotCapturedAt: string | null, nowMs: number): number | null {
  if (candidate.quoteSource === "live" && !candidate.quotedAt) return 0; // a pooled tick received this instant
  const at = candidate.quotedAt ?? (candidate.quoteSource === "snapshot" ? snapshotCapturedAt : null);
  if (!at) return null;
  return Math.max(0, (nowMs - new Date(at).getTime()) / 60_000);
}

type OpenCandidateFilterContext = { scored: TickerSignals; slicesByExpiry: Map<string, SignalSurfaceSlice>; settings: PlutoSettings; nowMs: number };

/** Every reason one open candidate is out; empty means eligible. Shared with the roll path for the replacement leg. */
export function rejectOpenCandidate(candidate: SignalCandidate, context: OpenCandidateFilterContext, options: { onHeldShares?: boolean } = {}): string[] {
  return openCandidateFailures(candidate, context, options).map((failure) => failure.reason);
}

/**
 * As rejectOpenCandidate, with the rule behind each reason. `skipValueRules` leaves out the grade and Edge Yield rules: a
 * roll's replacement is judged on the roll's own grade and net Edge Yield instead. `onHeldShares` (a covered call on shares
 * already held, Marcelo 2026-10-12) leaves out the grade, Edge Yield and premium-yield minimums and asks only for a positive
 * Edge: the call lowers the risk of shares the book already carries, and the break-even rule guards its strike.
 */
export function openCandidateFailures(candidate: SignalCandidate, context: OpenCandidateFilterContext, options: { skipValueRules?: boolean; onHeldShares?: boolean } = {}): PlutoRejectionReason[] {
  const { settings, scored } = context;
  const failures: PlutoRejectionReason[] = [];
  const fail = (code: PlutoRejectionCode, reason: string) => failures.push({ code, reason });
  const model = candidate.model;
  if (!model) fail("no_model", "not valued by the model (no YZ21 forecast or no variance time left)");
  else if (options.onHeldShares) {
    if (!(model.expectedPnlDollars > 0)) fail("edge", `Edge $${model.expectedPnlDollars.toFixed(0)}/contract not above 0`);
  } else {
    if (!options.skipValueRules && gradeRank[model.grade] < gradeRank[settings.minGrade]) fail("grade", `grade ${model.grade} (edge margin ${(model.edgeMargin * 100).toFixed(0)}%) below ${settings.minGrade}`);
    if (!options.skipValueRules && model.expectedAnnualizedReturn * 100 < settings.minEdgeYieldPct) fail("edge_yield", `Edge Yield ${(model.expectedAnnualizedReturn * 100).toFixed(0)}% below ${settings.minEdgeYieldPct}%`);
    if (model.premiumYield * 100 < settings.minAnnualizedYieldPct) fail("yield", `premium yield ${(model.premiumYield * 100).toFixed(0)}% a year below ${settings.minAnnualizedYieldPct}%`);
  }
  if (Math.abs(candidate.delta) > settings.maxAbsDelta) fail("delta", `|delta| ${Math.abs(candidate.delta).toFixed(2)} above ${settings.maxAbsDelta}`);
  if (candidate.dte < settings.minDte || candidate.dte > settings.maxDte) fail("dte", `DTE ${candidate.dte} outside ${settings.minDte}–${settings.maxDte}`);
  if (candidate.spreadPercent > settings.maxSpreadPct) fail("spread", `spread ${candidate.spreadPercent.toFixed(1)}% above ${settings.maxSpreadPct}%`);
  if (candidate.openInterest === null || candidate.openInterest < settings.minOpenInterest) fail("open_interest", `open interest ${candidate.openInterest ?? "unknown"} below ${settings.minOpenInterest}`);
  if (candidate.volume === null || candidate.volume < settings.minSessionVolume) fail("volume", `session volume ${candidate.volume ?? "unknown"} below ${settings.minSessionVolume}`);

  const ageMinutes = quoteAgeMinutes(candidate, scored.snapshotCapturedAt, context.nowMs);
  if (ageMinutes === null) fail("quote_age", "quote age unknown");
  else if (ageMinutes > settings.maxQuoteAgeMinutes) fail("quote_age", `quote ${ageMinutes.toFixed(0)} min old (${candidate.quoteSource}), max ${settings.maxQuoteAgeMinutes}`);

  const slice = context.slicesByExpiry.get(candidate.expiry);
  if (!slice) fail("no_slice", "no fitted slice for the expiry");
  else {
    if (slice.rmseVolatility === null || slice.rmseVolatility * 100 > settings.maxSliceRmseVp) fail("slice_rmse", `slice RMSE ${slice.rmseVolatility === null ? "unknown" : (slice.rmseVolatility * 100).toFixed(1) + " vp"} above ${settings.maxSliceRmseVp} vp`);
    if (slice.pointCount < settings.minSlicePointCount) fail("slice_points", `slice fitted on ${slice.pointCount} points, min ${settings.minSlicePointCount}`);
    if (slice.calendarViolations > 0) fail("calendar_arbitrage", `slice has ${slice.calendarViolations} calendar-arbitrage violation(s)`);
  }

  if (candidate.midImpliedVolatility === null) fail("no_mid_iv", "no mid IV to check the surface against");
  else {
    const gapVp = Math.abs(candidate.midImpliedVolatility - candidate.surfaceImpliedVolatility) * 100;
    if (gapVp > settings.maxMidVsSurfaceIvVp) fail("mid_iv_gap", `mid IV is ${gapVp.toFixed(1)} vp from the surface, max ${settings.maxMidVsSurfaceIvVp}`);
  }
  const shift = scored.ivShiftByExpiry[candidate.expiry];
  if (shift && Math.abs(shift.shiftVolatilityPoints) > settings.maxIvShiftVp) fail("iv_shift", `intraday IV shift ${shift.shiftVolatilityPoints.toFixed(1)} vp beyond ±${settings.maxIvShiftVp}`);

  if (candidate.flags.includes("outside_fitted_range")) fail("outside_fitted_range", "strike outside the fitted range (extrapolated surface)");
  if (candidate.flags.includes("insufficient_cash")) fail("insufficient_cash", "insufficient free cash");
  if (candidate.flags.includes("earnings_calendar_unresolved")) fail("earnings_unresolved", "earnings calendar unresolved for this ticker");
  if (!candidate.executable) fail("not_executable", "not executable");
  return failures;
}

/** Reasons the whole ticker is out this pass. */
export function rejectTicker(input: PlutoTickerFilterInput): string[] {
  const { scored, settings, todayEasternIso } = input;
  const reasons: string[] = [];
  if (!input.botEnabled) reasons.push("ticker not enabled for Pluto");
  if (scored.unscoredReason) reasons.push(`not scored: ${scored.unscoredReason}`);
  if (scored.snapshotDateIso !== todayEasternIso) reasons.push(`surface is from ${scored.snapshotDateIso ?? "no snapshot"}, Pluto requires today's fit`);
  if (!scored.modelForecast) reasons.push("no 21-day volatility forecast for the valuation model (fewer than 22 daily bars before today)");
  // Each stock against its own normal day (Marcelo, 2026-10-07): 3 × NOK's 4.2% is 12.7%, 3 × BSBR's 2.4% is 7.2%.
  // The normal day is the valuation model's forecast (YZ21) since the model review (2026-10-10).
  const normalDayMovePct = expectedDailyMovePct(scored.modelForecast?.annualizedVolatility ?? null);
  // No usable forecast (zero or missing volatility) means no normal day to measure against: the ticker is out, not unlimited.
  if (scored.dayChangePercent !== null && normalDayMovePct === null) reasons.push("no volatility forecast to judge today's move against");
  else if (scored.dayChangePercent !== null && normalDayMovePct !== null && Math.abs(scored.dayChangePercent) > settings.maxDayMoveMultiple * normalDayMovePct) reasons.push(`day change ${scored.dayChangePercent.toFixed(1)}% is ${(Math.abs(scored.dayChangePercent) / normalDayMovePct).toFixed(2)}× its normal ${normalDayMovePct.toFixed(2)}% day, beyond ${settings.maxDayMoveMultiple}×`);
  if (scored.priceSource !== "live") reasons.push(`spot price is ${scored.priceSource}, not live`);
  return reasons;
}

export function filterTickerForPluto(input: PlutoTickerFilterInput): PlutoTickerFilterResult {
  const { scored } = input;
  const result: PlutoTickerFilterResult = { symbol: scored.symbol, tickerBlocks: rejectTicker(input), eligible: [], eligibleRolls: [], rejected: [], rejectedRolls: [] };
  if (result.tickerBlocks.length > 0) return result;

  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const context = { scored, slicesByExpiry, settings: input.settings, nowMs: input.nowMs };

  const occupied = input.occupiedContracts ?? [];
  const cycle = input.cycleBreakEven ?? null;
  // Round lots only: fewer than 100 free shares cover no contract (the odd lot is P1's to sell).
  const heldShareContracts = Math.floor(scored.freeShares / 100);
  for (const candidate of scored.candidates) {
    const id = openCandidateId(scored.symbol, candidate);
    const onHeldShares = candidate.strategyKey === "covered_call" && heldShareContracts > 0;
    const failures = openCandidateFailures(candidate, context, { onHeldShares });
    let heldShares: PlutoOpenCandidate["heldShares"];
    if (onHeldShares) {
      const cashPerShareCovered = (candidate.bid + candidate.ask) / 2 - commissionPerShare(candidate.commissionPerContractDollars);
      const calledAway = checkCalledAway({ cycle, strike: candidate.strike, contracts: heldShareContracts, cashPerShareCovered, settings: input.settings });
      if (!calledAway.check) failures.push({ code: "no_break_even", reason: `no cycle break-even for the held shares: ${calledAway.unavailableReason}` });
      else if (!calledAway.check.passes) failures.push({ code: "below_break_even", reason: describeCalledAwayShortfall(candidate.strike, heldShareContracts, calledAway.check) });
      else heldShares = { contracts: heldShareContracts, breakEvenAfter: calledAway.check.breakEvenAfter, profitIfCalledAway: calledAway.check.profitIfCalledAway };
    }
    const conflict = findSameContractConflict(occupied, candidate.expiry, candidate.strike);
    if (conflict) failures.push({ code: "same_contract", reason: `same contract: ${conflict}` });
    if (input.opensBlockedReason) failures.push({ code: "opens_blocked", reason: input.opensBlockedReason });
    if (failures.length === 0) result.eligible.push({ id, kind: candidate.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", symbol: scored.symbol, candidate, ...(heldShares ? { heldShares } : {}) });
    else result.rejected.push(plutoRejection(id, failures));
  }

  // The held shares get one call, the best by Edge Yield among those that pass (Marcelo, 2026-10-12).
  const [bestHeldShareCall, ...runnersUp] = rankEligibleOpens(result.eligible.filter((entry) => entry.heldShares));
  if (bestHeldShareCall && runnersUp.length > 0) {
    const runnerUpIds = new Set(runnersUp.map((entry) => entry.id));
    result.eligible = result.eligible.filter((entry) => !runnerUpIds.has(entry.id));
    for (const entry of runnersUp) result.rejected.push(plutoRejection(entry.id, [{ code: "held_shares_runner_up", reason: `the held shares are offered one call, the best by Edge Yield: ${bestHeldShareCall.id}` }]));
  }

  for (const roll of scored.rolls) {
    const id = rollCandidateId(scored.symbol, roll);
    const failures: PlutoRejectionReason[] = [];
    if (!roll.model) failures.push({ code: "no_model", reason: "roll not valued by the model (a leg has no model score)" });
    else {
      if (gradeRank[roll.model.grade] < gradeRank[input.settings.minGrade]) failures.push({ code: "grade", reason: `roll grade ${roll.model.grade} (edge margin ${(roll.model.edgeMargin * 100).toFixed(0)}%) below ${input.settings.minGrade}` });
      const rollEdgeYield = roll.replacement.model ? yieldOnExposure(roll.model.netExpectedPnlPerContract, roll.replacement.model.capitalAtRiskDollars, roll.replacement.model.calendarYears) : Number.NEGATIVE_INFINITY;
      if (rollEdgeYield * 100 < input.settings.minEdgeYieldPct) failures.push({ code: "edge_yield", reason: `net roll Edge Yield ${(rollEdgeYield * 100).toFixed(0)}% below ${input.settings.minEdgeYieldPct}%` });
    }
    // The replacement leg must be tradeable on its own terms, minus the grade/Edge Yield rules already judged on the roll.
    const replacementFailures = openCandidateFailures(roll.replacement, context, { skipValueRules: true });
    failures.push(...replacementFailures.map((failure) => ({ code: failure.code, reason: `replacement: ${failure.reason}` })));
    const breakEvenFailure = coveredCallRollBreakEvenFailure(roll, scored, cycle, input.settings);
    if (breakEvenFailure) failures.push(breakEvenFailure);
    const conflict = findSameContractConflict(occupied, roll.replacement.expiry, roll.replacement.strike);
    if (conflict) failures.push({ code: "same_contract", reason: `replacement: same contract: ${conflict}` });
    if (failures.length === 0) result.eligibleRolls.push({ id, kind: "roll", symbol: scored.symbol, roll });
    else result.rejectedRolls.push(plutoRejection(id, failures));
  }
  return result;
}

/**
 * The break-even rule on a covered-call roll (Marcelo, 2026-10-12): a roll that lowers the strike must, if the new call is
 * assigned, close the shares at or above the cycle break-even plus the minimum profit, counting the buyback. A roll that
 * keeps or raises the strike is always allowed, so a call already below break-even can still be rolled up or out.
 */
export function coveredCallRollBreakEvenFailure(roll: RollSignalCandidate, scored: TickerSignals, cycle: CycleBreakEven | null, settings: PlutoSettings): PlutoRejectionReason | null {
  if (roll.strategyKey !== "covered_call") return null;
  const heldLeg = scored.heldLegs.find((leg) => leg.legId === roll.legId);
  if (heldLeg && roll.replacement.strike >= heldLeg.strike) return null;
  const cashPerShareCovered = roll.netCreditPerShare - 2 * commissionPerShare(roll.replacement.commissionPerContractDollars);
  const calledAway = checkCalledAway({ cycle, strike: roll.replacement.strike, contracts: roll.quantity, cashPerShareCovered, settings });
  if (!calledAway.check) return { code: "no_break_even", reason: `replacement lowers the strike and the cycle has no break-even: ${calledAway.unavailableReason}` };
  if (!calledAway.check.passes) return { code: "below_break_even", reason: `replacement: ${describeCalledAwayShortfall(roll.replacement.strike, roll.quantity, calledAway.check)}` };
  return null;
}

/** Eligible opens in the deterministic order (compareCandidatesByModel: Edge Yield, then Edge $). */
export function rankEligibleOpens(eligible: PlutoOpenCandidate[]): PlutoOpenCandidate[] {
  return [...eligible].sort((a, b) => compareCandidatesByModel(a.candidate, b.candidate));
}

/** The best eligible open by compareCandidatesByModel — the deterministic pick the ledger logs next to the model's. */
export function deterministicTopPick(eligible: PlutoOpenCandidate[]): PlutoOpenCandidate | null {
  return rankEligibleOpens(eligible)[0] ?? null;
}

/**
 * What the ledger keeps of the top pick (and the one after it, for the screen's "next"): the model's figures, and which
 * figure ranked them (rows before 2026-10-12 carry no rankedBy and were ranked by Hist Yield).
 */
export function summarizeTopPick(eligible: PlutoOpenCandidate[]) {
  const [topPick, runnerUp] = rankEligibleOpens(eligible);
  const model = topPick?.candidate.model;
  if (!topPick || !model) return null;
  return {
    id: topPick.id,
    edgeDollars: model.expectedPnlDollars,
    edgeMargin: model.edgeMargin,
    grade: model.grade,
    calibratedAnnualizedReturn: model.calibratedAnnualizedReturn,
    expectedAnnualizedReturn: model.expectedAnnualizedReturn,
    capitalAtRiskDollars: model.capitalAtRiskDollars,
    rankedBy: "edge_yield" as const,
    runnerUp: runnerUp?.candidate.model ? { id: runnerUp.id, calibratedAnnualizedReturn: runnerUp.candidate.model.calibratedAnnualizedReturn, expectedAnnualizedReturn: runnerUp.candidate.model.expectedAnnualizedReturn } : null,
  };
}
