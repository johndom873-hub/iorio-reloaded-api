import { describe, expect, it } from "vitest";
import { recentDecisionsForPrompt } from "./prompt.js";

describe("recentDecisionsForPrompt", () => {
  const at = new Date("2026-10-06T14:16:27.572Z");

  it("gives a trade the outcome of the action its pass produced, with the block reason", () => {
    const [entry] = recentDecisionsForPrompt(
      [{ passId: "pass-1", createdAt: at, parsedOutput: { decision: "trade", candidate_id: "SMCI:close_leg:leg-1", reasons: ["Buying back locks in a $278 profit.", "FOMC before expiry."] } }],
      new Map([["pass-1", { outcome: "blocked", blockReason: "offer_fresh: holding is still worth $1 per contract more than buying back" }]]),
    );
    expect(entry).toEqual({
      at: "2026-10-06T14:16:27.572Z",
      verdict: "trade",
      candidateId: "SMCI:close_leg:leg-1",
      reason: "Buying back locks in a $278 profit.",
      outcome: "blocked",
      outcomeDetail: "offer_fresh: holding is still worth $1 per contract more than buying back",
    });
  });

  it("marks a trade whose pass recorded no action as not executed", () => {
    const [entry] = recentDecisionsForPrompt([{ passId: "pass-2", createdAt: at, parsedOutput: { decision: "trade", candidate_id: "X:open:1", reasons: [] } }], new Map());
    expect(entry?.outcome).toBe("not_executed");
    expect(entry?.outcomeDetail).toBeNull();
    expect(entry?.reason).toBeNull();
  });

  it("leaves the outcome off every verdict other than trade, even when its pass has an action", () => {
    const entries = recentDecisionsForPrompt(
      [
        { passId: "pass-3", createdAt: at, parsedOutput: { decision: "no_trade", reasons: ["Weak edge."] } },
        { passId: "pass-4", createdAt: at, parsedOutput: null },
      ],
      new Map([["pass-3", { outcome: "filled", blockReason: null }]]),
    );
    expect(entries.map((entry) => [entry.verdict, entry.outcome, entry.outcomeDetail])).toEqual([
      ["no_trade", null, null],
      ["invalid", null, null],
    ]);
  });
});
