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

export function candidateSetFingerprint(eligible: PlutoOpenCandidate[], rolls: PlutoRollCandidate[]): string {
  const parts = [
    ...eligible.map((entry) => `${entry.id}|${entry.candidate.grade}|${bucket(entry.candidate.edgeDollars, edgeDollarsStep)}|${bucket(entry.candidate.netEdge * 100, netEdgeStepVp)}`),
    ...rolls.map((entry) => `${entry.id}|${entry.roll.grade}|${bucket(entry.roll.netRollEdgeDollars, edgeDollarsStep)}`),
  ].sort();
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}
