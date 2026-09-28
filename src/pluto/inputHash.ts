import { createHash } from "node:crypto";
import type { PlutoOpenCandidate, PlutoRollCandidate } from "./candidateFilters.js";

// The model is called only when the filtered set changed materially (design round 4, 2026-09-28).
// "Materially" = a candidate entered or left, its grade moved, or its Edge $ / net Edge moved
// past a coarse step; sub-step quote noise never re-triggers a call. The hash is the pass row's
// input_hash and the trigger engine's memory of what the model last saw.

const edgeDollarsStep = 5;
const netEdgeStepVp = 0.5;

function bucket(value: number, step: number): number {
  return Math.round(value / step) * step;
}

export type FingerprintChangeKind = "grade_crossing" | "held_leg";

/**
 * A ticker's fingerprint keeps the open-candidate part and the held-leg part (rolls, close offers)
 * separable, so a change can be labelled as the trigger it really was (design round 4: grade
 * crossing vs held leg). Hex hashes never contain "|".
 */
export function tickerFingerprint(eligible: PlutoOpenCandidate[], rolls: PlutoRollCandidate[], closeOfferIds: string[] = []): string {
  return `${candidateSetFingerprint(eligible, [])}|${candidateSetFingerprint([], rolls)}|closes:${[...closeOfferIds].sort().join(",")}`;
}

/** Pure: what moved between two fingerprints of the same ticker — the held-leg part only, or the open candidates. */
export function classifyFingerprintChange(previous: string | undefined, current: string): FingerprintChangeKind {
  if (previous === undefined) return "grade_crossing";
  const [previousOpen, ...previousHeld] = previous.split("|");
  const [currentOpen, ...currentHeld] = current.split("|");
  if (previousOpen === currentOpen && previousHeld.join("|") !== currentHeld.join("|")) return "held_leg";
  return "grade_crossing";
}

export function candidateSetFingerprint(eligible: PlutoOpenCandidate[], rolls: PlutoRollCandidate[]): string {
  const parts = [
    ...eligible.map((entry) => `${entry.id}|${entry.candidate.grade}|${bucket(entry.candidate.edgeDollars, edgeDollarsStep)}|${bucket(entry.candidate.netEdge * 100, netEdgeStepVp)}`),
    ...rolls.map((entry) => `${entry.id}|${entry.roll.grade}|${bucket(entry.roll.netRollEdgeDollars, edgeDollarsStep)}`),
  ].sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
