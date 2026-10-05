import { describe, expect, it } from "vitest";
import { findNonLiveSnapshotQuoteReason } from "../lib/signalSnapshotLiveQuotes.js";
import type { HeldLegScore } from "../lib/rollSignalCandidates.js";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import { signalsSnapshotForOpen, signalsSnapshotForRoll } from "./passRunner.js";

// Pluto's orders go through the same live-quote rule as every Signals order: the routes refuse a snapshot whose
// pricing quotes are not live, or older than 15 s. These cases run Pluto's snapshot shape through that very check.
describe("Pluto's signal snapshot shape", () => {
  const now = new Date("2026-10-05T15:00:00Z");
  const quoted = (source: string, secondsAgo: number | null) => ({ quoteSource: source, quotedAt: secondsAgo === null ? null : new Date(now.getTime() - secondsAgo * 1000).toISOString() });
  const candidate = (source: string, secondsAgo: number | null) => quoted(source, secondsAgo) as unknown as SignalCandidate;
  const heldLeg = (source: string, secondsAgo: number | null) => quoted(source, secondsAgo) as unknown as HeldLegScore;
  const check = (shape: object) => findNonLiveSnapshotQuoteReason({ ...shape, version: "pluto-test", candidateId: "x" }, now);

  it("an open passes only on a live, fresh quote", () => {
    expect(check(signalsSnapshotForOpen(candidate("live", 3)))).toBeNull();
    expect(check(signalsSnapshotForOpen(candidate("day", 3)))).toMatch(/day quote, not a live one/);
    expect(check(signalsSnapshotForOpen(candidate("live", 20)))).toMatch(/older than 15 seconds/);
    expect(check(signalsSnapshotForOpen(null))).toMatch(/no quote recorded/);
  });

  it("a roll needs both the held leg and the new leg live", () => {
    expect(check(signalsSnapshotForRoll(heldLeg("live", 2), candidate("live", 2)))).toBeNull();
    expect(check(signalsSnapshotForRoll(heldLeg("snapshot", null), candidate("live", 2)))).toMatch(/^The leg being closed is priced from a snapshot quote/);
    expect(check(signalsSnapshotForRoll(heldLeg("live", 2), candidate("day", 2)))).toMatch(/^The new leg is priced from a day quote/);
  });
});
