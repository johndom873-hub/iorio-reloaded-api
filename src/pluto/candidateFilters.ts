import type { SignalCandidate, SignalGrade, SignalSurfaceSlice } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import type { PlutoSettings } from "./settingsStore.js";

// Pluto's deterministic candidate filters (design round 3, item 20, approved 2026-09-28). Pure:
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
}

export interface PlutoRollCandidate {
  /** symbol:roll:<legId>:<expiry>:<strike> */
  id: string;
  kind: "roll";
  symbol: string;
  roll: RollSignalCandidate;
}

export interface PlutoRejection {
  id: string;
  reasons: string[];
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
}

export function openCandidateId(symbol: string, candidate: Pick<SignalCandidate, "strategyKey" | "expiry" | "strike">): string {
  return `${symbol}:${candidate.strategyKey}:${candidate.expiry}:${candidate.strike}`;
}

export function rollCandidateId(symbol: string, roll: Pick<RollSignalCandidate, "legId" | "replacement">): string {
  return `${symbol}:roll:${roll.legId}:${roll.replacement.expiry}:${roll.replacement.strike}`;
}

function quoteAgeMinutes(candidate: Pick<SignalCandidate, "quoteSource" | "quotedAt">, snapshotCapturedAt: string | null, nowMs: number): number | null {
  if (candidate.quoteSource === "live" && !candidate.quotedAt) return 0; // a pooled tick received this instant
  const at = candidate.quotedAt ?? (candidate.quoteSource === "snapshot" ? snapshotCapturedAt : null);
  if (!at) return null;
  return Math.max(0, (nowMs - new Date(at).getTime()) / 60_000);
}

/** Every reason one open candidate is out; empty means eligible. Shared with the roll path for the replacement leg. */
export function rejectOpenCandidate(candidate: SignalCandidate, context: { scored: TickerSignals; slicesByExpiry: Map<string, SignalSurfaceSlice>; settings: PlutoSettings; nowMs: number }): string[] {
  const { settings, scored } = context;
  const reasons: string[] = [];
  if (gradeRank[candidate.grade] < gradeRank[settings.minGrade]) reasons.push(`grade ${candidate.grade} below ${settings.minGrade}`);
  if (candidate.edgeDollars < settings.minEdgeDollars) reasons.push(`Edge $${candidate.edgeDollars.toFixed(0)} below $${settings.minEdgeDollars}`);
  if (Math.abs(candidate.delta) > settings.maxAbsDelta) reasons.push(`|delta| ${Math.abs(candidate.delta).toFixed(2)} above ${settings.maxAbsDelta}`);
  if (candidate.dte < settings.minDte || candidate.dte > settings.maxDte) reasons.push(`DTE ${candidate.dte} outside ${settings.minDte}–${settings.maxDte}`);
  if (candidate.annualizedYield * 100 < settings.minAnnualizedYieldPct) reasons.push(`annualized yield ${(candidate.annualizedYield * 100).toFixed(0)}% below ${settings.minAnnualizedYieldPct}%`);
  if (candidate.spreadPercent > settings.maxSpreadPct) reasons.push(`spread ${candidate.spreadPercent.toFixed(1)}% above ${settings.maxSpreadPct}%`);
  if (candidate.openInterest === null || candidate.openInterest < settings.minOpenInterest) reasons.push(`open interest ${candidate.openInterest ?? "unknown"} below ${settings.minOpenInterest}`);
  if (candidate.volume === null || candidate.volume < settings.minSessionVolume) reasons.push(`session volume ${candidate.volume ?? "unknown"} below ${settings.minSessionVolume}`);

  const ageMinutes = quoteAgeMinutes(candidate, scored.snapshotCapturedAt, context.nowMs);
  if (ageMinutes === null) reasons.push("quote age unknown");
  else if (ageMinutes > settings.maxQuoteAgeMinutes) reasons.push(`quote ${ageMinutes.toFixed(0)} min old (${candidate.quoteSource}), max ${settings.maxQuoteAgeMinutes}`);

  const slice = context.slicesByExpiry.get(candidate.expiry);
  if (!slice) reasons.push("no fitted slice for the expiry");
  else {
    if (slice.rmseVolatility === null || slice.rmseVolatility * 100 > settings.maxSliceRmseVp) reasons.push(`slice RMSE ${slice.rmseVolatility === null ? "unknown" : (slice.rmseVolatility * 100).toFixed(1) + " vp"} above ${settings.maxSliceRmseVp} vp`);
    if (slice.pointCount < settings.minSlicePointCount) reasons.push(`slice fitted on ${slice.pointCount} points, min ${settings.minSlicePointCount}`);
    if (slice.calendarViolations > 0) reasons.push(`slice has ${slice.calendarViolations} calendar-arbitrage violation(s)`);
  }

  if (candidate.midImpliedVolatility === null) reasons.push("no mid IV to check the surface against");
  else {
    const gapVp = Math.abs(candidate.midImpliedVolatility - candidate.surfaceImpliedVolatility) * 100;
    if (gapVp > settings.maxMidVsSurfaceIvVp) reasons.push(`mid IV is ${gapVp.toFixed(1)} vp from the surface, max ${settings.maxMidVsSurfaceIvVp}`);
  }
  const shift = scored.ivShiftByExpiry[candidate.expiry];
  if (shift && Math.abs(shift.shiftVolatilityPoints) > settings.maxIvShiftVp) reasons.push(`intraday IV shift ${shift.shiftVolatilityPoints.toFixed(1)} vp beyond ±${settings.maxIvShiftVp}`);

  if (candidate.flags.includes("outside_fitted_range")) reasons.push("strike outside the fitted range (extrapolated surface)");
  if (candidate.flags.includes("insufficient_cash")) reasons.push("insufficient free cash");
  if (candidate.flags.includes("earnings_calendar_unresolved")) reasons.push("earnings calendar unresolved for this ticker");
  if (!candidate.executable) reasons.push("not executable");
  return reasons;
}

/** Reasons the whole ticker is out this pass. */
export function rejectTicker(input: PlutoTickerFilterInput): string[] {
  const { scored, settings, todayEasternIso } = input;
  const reasons: string[] = [];
  if (!input.botEnabled) reasons.push("ticker not enabled for Pluto");
  if (scored.unscoredReason) reasons.push(`not scored: ${scored.unscoredReason}`);
  if (scored.snapshotDateIso !== todayEasternIso) reasons.push(`surface is from ${scored.snapshotDateIso ?? "no snapshot"}, Pluto requires today's fit`);
  if (scored.forecast && scored.forecast.windowDays !== 63) reasons.push(`forecast window is ${scored.forecast.windowDays} days, not the 63-day one`);
  if (scored.dayChangePercent !== null && Math.abs(scored.dayChangePercent) > settings.maxAbsDayChangePct) reasons.push(`day change ${scored.dayChangePercent.toFixed(1)}% beyond ±${settings.maxAbsDayChangePct}%`);
  if (scored.priceSource !== "live") reasons.push(`spot price is ${scored.priceSource}, not live`);
  return reasons;
}

export function filterTickerForPluto(input: PlutoTickerFilterInput): PlutoTickerFilterResult {
  const { scored } = input;
  const result: PlutoTickerFilterResult = { symbol: scored.symbol, tickerBlocks: rejectTicker(input), eligible: [], eligibleRolls: [], rejected: [], rejectedRolls: [] };
  if (result.tickerBlocks.length > 0) return result;

  const slicesByExpiry = new Map(input.slices.map((slice) => [slice.expiry, slice]));
  const context = { scored, slicesByExpiry, settings: input.settings, nowMs: input.nowMs };

  for (const candidate of scored.candidates) {
    const id = openCandidateId(scored.symbol, candidate);
    const reasons = rejectOpenCandidate(candidate, context);
    if (reasons.length === 0) result.eligible.push({ id, kind: candidate.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", symbol: scored.symbol, candidate });
    else result.rejected.push({ id, reasons });
  }

  for (const roll of scored.rolls) {
    const id = rollCandidateId(scored.symbol, roll);
    const reasons: string[] = [];
    if (gradeRank[roll.grade] < gradeRank[input.settings.minGrade]) reasons.push(`roll grade ${roll.grade} below ${input.settings.minGrade}`);
    if (roll.netRollEdgeDollarsPerContract < input.settings.minEdgeDollars) reasons.push(`net roll Edge $${roll.netRollEdgeDollarsPerContract.toFixed(0)}/contract below $${input.settings.minEdgeDollars}`);
    // The replacement leg must be tradeable on its own terms, minus the grade/Edge $ rules already judged on the roll.
    const replacementReasons = rejectOpenCandidate({ ...roll.replacement, grade: "strong", edgeDollars: Number.MAX_SAFE_INTEGER }, context);
    reasons.push(...replacementReasons.map((reason) => `replacement: ${reason}`));
    if (reasons.length === 0) result.eligibleRolls.push({ id, kind: "roll", symbol: scored.symbol, roll });
    else result.rejectedRolls.push({ id, reasons });
  }
  return result;
}

/** Edge $ ranking, ties by net Edge — the deterministic pick the ledger logs next to the model's. */
export function deterministicTopPick(eligible: PlutoOpenCandidate[]): PlutoOpenCandidate | null {
  if (eligible.length === 0) return null;
  return [...eligible].sort((a, b) => b.candidate.edgeDollars - a.candidate.edgeDollars || b.candidate.netEdge - a.candidate.netEdge)[0]!;
}
