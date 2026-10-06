import { describe, expect, it } from "vitest";
import { kindFromCandidateId, parsePlutoDecision, reconcileAgreement, type PlutoDecision } from "./decisionSchema.js";

const offered = new Set(["HOOD:cash_secured_put:2026-10-16:100", "COIN:roll:leg1:2026-10-23:250"]);

function parsed(text: string) {
  return parsePlutoDecision(text, offered);
}

describe("parsePlutoDecision", () => {
  it("accepts a well-formed trade on an offered id", () => {
    const result = parsed(JSON.stringify({ decision: "trade", action_kind: "open_cash_secured_put", candidate_id: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.8, reasons: ["strong net edge"], risks_acknowledged: ["macro event before expiry"], system_concerns: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision.candidateId).toBe("HOOD:cash_secured_put:2026-10-16:100");
  });
  it("accepts a no_trade and clears the action fields", () => {
    const result = parsed(JSON.stringify({ decision: "no_trade", action_kind: "roll", candidate_id: "whatever", confidence: 0.9, reasons: ["nothing compelling"], risks_acknowledged: [], system_concerns: [] }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.decision).toMatchObject({ decision: "no_trade", actionKind: null, candidateId: null });
  });
  it("tolerates a code fence around the JSON", () => {
    const result = parsed("```json\n" + JSON.stringify({ decision: "no_trade", action_kind: null, candidate_id: null, confidence: 1, reasons: ["x"], risks_acknowledged: [], system_concerns: [] }) + "\n```");
    expect(result.ok).toBe(true);
  });
  it("rejects a trade on an id that was not offered, a kind mismatch, or missing fields", () => {
    const base = { decision: "trade", action_kind: "open_cash_secured_put", candidate_id: "HOOD:cash_secured_put:2026-10-16:105", confidence: 0.7, reasons: ["r"], risks_acknowledged: [], system_concerns: [] };
    expect(parsed(JSON.stringify(base))).toMatchObject({ ok: false, error: expect.stringMatching(/not offered/) });
    expect(parsed(JSON.stringify({ ...base, candidate_id: "COIN:roll:leg1:2026-10-23:250" }))).toMatchObject({ ok: false, error: expect.stringMatching(/does not match/) });
    expect(parsed(JSON.stringify({ ...base, candidate_id: "HOOD:cash_secured_put:2026-10-16:100", reasons: [] }))).toMatchObject({ ok: false, error: expect.stringMatching(/reasons/) });
    expect(parsed(JSON.stringify({ ...base, candidate_id: "HOOD:cash_secured_put:2026-10-16:100", confidence: 1.4 }))).toMatchObject({ ok: false, error: expect.stringMatching(/confidence/) });
  });
  it("rejects non-JSON and unknown verdicts", () => {
    expect(parsed("I think we should buy").ok).toBe(false);
    expect(parsed(JSON.stringify({ decision: "maybe", confidence: 0.5, reasons: ["x"] })).ok).toBe(false);
  });
});

describe("kindFromCandidateId", () => {
  it("reads the kind out of the id", () => {
    expect(kindFromCandidateId("HOOD:cash_secured_put:2026-10-16:100")).toBe("open_cash_secured_put");
    expect(kindFromCandidateId("HOOD:covered_call:2026-10-16:130")).toBe("open_covered_call");
    expect(kindFromCandidateId("COIN:roll:leg1:2026-10-23:250")).toBe("roll");
    expect(kindFromCandidateId("AAOI:close_shares:pos1")).toBe("close_shares");
    expect(kindFromCandidateId("garbage")).toBeNull();
  });
});

describe("reconcileAgreement", () => {
  const trade = (candidateId: string, confidence = 0.8): PlutoDecision => ({ decision: "trade", actionKind: "open_cash_secured_put", candidateId, confidence, reasons: ["r"], risksAcknowledged: ["a"], systemConcerns: [] });
  const none: PlutoDecision = { decision: "no_trade", actionKind: null, candidateId: null, confidence: 0.9, reasons: ["quiet"], risksAcknowledged: [], systemConcerns: [] };
  it("agrees on the same candidate and takes the smaller confidence", () => {
    const result = reconcileAgreement(trade("HOOD:cash_secured_put:2026-10-16:100", 0.9), trade("HOOD:cash_secured_put:2026-10-16:100", 0.7));
    expect(result.agreed).toBe(true);
    expect(result.decision.confidence).toBe(0.7);
  });
  it("two no_trades agree", () => {
    expect(reconcileAgreement(none, none).agreed).toBe(true);
  });
  it("a verdict or candidate mismatch becomes a no_trade", () => {
    expect(reconcileAgreement(trade("HOOD:cash_secured_put:2026-10-16:100"), none)).toMatchObject({ agreed: false, decision: { decision: "no_trade" } });
    expect(reconcileAgreement(trade("HOOD:cash_secured_put:2026-10-16:100"), trade("COIN:roll:leg1:2026-10-23:250"))).toMatchObject({ agreed: false, decision: { decision: "no_trade" } });
  });
});
