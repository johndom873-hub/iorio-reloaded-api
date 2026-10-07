import { describe, expect, it } from "vitest";
import { flaggedSymbols, normalizeSystemConcerns, parsePlutoDecision, plutoDecisionJsonSchema, reconcileAgreement } from "./decisionSchema.js";

// Audit B (2026-10-07): per-ticker system concerns, prompt v3.3.
const offered = new Set(["SMCI:cash_secured_put:2026-10-16:40", "NOK:covered_call:2026-10-16:5", "BSBR:close_leg:leg-1"]);
const answer = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ decision: "trade", action_kind: "open_covered_call", candidate_id: "NOK:covered_call:2026-10-16:5", confidence: 0.8, reasons: ["edge"], risks_acknowledged: [], system_concerns: [], ...overrides });

describe("parsePlutoDecision — system concerns", () => {
  it("derives the message's tickers from every kind of offered id (open, roll, close)", () => {
    const parsed = parsePlutoDecision(answer({ system_concerns: [{ symbol: "BSBR", concern: "close action P&L inconsistent" }, { symbol: "SMCI", concern: "x" }] }), offered);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.decision.systemConcerns).toEqual([{ symbol: "BSBR", concern: "close action P&L inconsistent" }, { symbol: "SMCI", concern: "x" }]);
  });

  it("treats a missing or null system_concerns as none", () => {
    const missing = JSON.parse(answer());
    delete missing.system_concerns;
    const parsedMissing = parsePlutoDecision(JSON.stringify(missing), offered);
    expect(parsedMissing.ok && parsedMissing.decision.systemConcerns).toEqual([]);
    const parsedNull = parsePlutoDecision(answer({ system_concerns: null }), offered);
    expect(parsedNull.ok && parsedNull.decision.systemConcerns).toEqual([]);
  });

  it("rejects a concern whose symbol key is missing (the strict schema requires it, so undefined is not null)", () => {
    const parsed = parsePlutoDecision(answer({ system_concerns: [{ concern: "no symbol key" }] }), offered);
    expect(parsed).toEqual({ ok: false, error: "a system concern's symbol must be a ticker or null" });
  });

  it("rejects a whitespace-only concern and a non-string concern", () => {
    expect(parsePlutoDecision(answer({ system_concerns: [{ symbol: null, concern: "   " }] }), offered).ok).toBe(false);
    expect(parsePlutoDecision(answer({ system_concerns: [{ symbol: null, concern: 5 }] }), offered).ok).toBe(false);
  });

  it("rejects more than 10 concerns", () => {
    const many = Array.from({ length: 11 }, () => ({ symbol: null, concern: "c" }));
    expect(parsePlutoDecision(answer({ system_concerns: many }), offered)).toEqual({ ok: false, error: "system_concerns has more than 10 entries" });
  });

  // RISK (characterised): one concern naming a symbol outside this round (SPY from the market block, a ticker from
  // recent_decisions, a lower-case ticker) makes the WHOLE answer invalid, so a valid trade on another ticker is lost and the
  // round is recorded as a model failure (it also counts toward the consecutive-failures breaker).
  it("a concern about SPY or a ticker only in recent_decisions becomes a whole-message concern; a lower-case ticker of the message matches it", () => {
    const spy = parsePlutoDecision(answer({ system_concerns: [{ symbol: "SPY", concern: "spy_day_change_pct looks stale" }] }), offered);
    expect(spy.ok && spy.decision.systemConcerns).toEqual([{ symbol: null, concern: "spy_day_change_pct looks stale" }]);
    const lower = parsePlutoDecision(answer({ system_concerns: [{ symbol: "smci", concern: "x" }] }), offered);
    expect(lower.ok && lower.decision.systemConcerns).toEqual([{ symbol: "SMCI", concern: "x" }]);
    const hood = parsePlutoDecision(answer({ system_concerns: [{ symbol: "HOOD", concern: "recent decision on HOOD makes no sense" }] }), offered);
    expect(hood.ok && hood.decision.systemConcerns).toEqual([{ symbol: null, concern: "recent decision on HOOD makes no sense" }]);
  });

  it("accepts an abstain with every ticker flagged and a trade alongside a whole-message concern (the parser does not tie the verdict to the concerns)", () => {
    const allFlagged = parsePlutoDecision(
      answer({ decision: "abstain_system_concern", action_kind: null, candidate_id: null, system_concerns: [{ symbol: "SMCI", concern: "a" }, { symbol: "NOK", concern: "b" }, { symbol: "BSBR", concern: "c" }] }),
      offered,
    );
    expect(allFlagged.ok && allFlagged.decision.decision).toBe("abstain_system_concern");
    // A null-symbol concern means the whole message is suspect, yet a trade verdict next to it parses and flags nothing by name.
    const tradeWithWholeMessageConcern = parsePlutoDecision(answer({ system_concerns: [{ symbol: null, concern: "account block inconsistent" }] }), offered);
    expect(tradeWithWholeMessageConcern.ok).toBe(true);
    if (tradeWithWholeMessageConcern.ok) {
      expect(tradeWithWholeMessageConcern.decision.decision).toBe("trade");
      expect([...flaggedSymbols(tradeWithWholeMessageConcern.decision)]).toEqual([]);
    }
  });

  it("an empty offer set accepts only null-symbol concerns", () => {
    const none = new Set<string>();
    expect(parsePlutoDecision(answer({ decision: "no_trade", action_kind: null, candidate_id: null, system_concerns: [{ symbol: null, concern: "x" }] }), none).ok).toBe(true);
    const named = parsePlutoDecision(answer({ decision: "no_trade", action_kind: null, candidate_id: null, system_concerns: [{ symbol: "SMCI", concern: "x" }] }), none);
    expect(named.ok && named.decision.systemConcerns).toEqual([{ symbol: null, concern: "x" }]);
  });
});

describe("plutoDecisionJsonSchema — system_concerns items", () => {
  it("are strict objects with symbol (string or null) and concern both required", () => {
    const items = plutoDecisionJsonSchema.properties.system_concerns.items;
    expect(items.additionalProperties).toBe(false);
    expect([...items.required].sort()).toEqual(["concern", "symbol"]);
    expect(items.properties.symbol.type).toEqual(["string", "null"]);
  });
});

describe("normalizeSystemConcerns — stored shapes", () => {
  it("non-arrays become no concerns", () => {
    expect(normalizeSystemConcerns(undefined)).toEqual([]);
    expect(normalizeSystemConcerns(null)).toEqual([]);
    expect(normalizeSystemConcerns("a concern")).toEqual([]);
    expect(normalizeSystemConcerns({ symbol: "X", concern: "y" })).toEqual([]);
  });

  it("drops unreadable entries, keeps a non-string symbol as null, and keeps mixed old/new shapes in order", () => {
    expect(
      normalizeSystemConcerns(["old string", { symbol: "SMCI", concern: "new" }, { symbol: 7, concern: "numeric symbol" }, { concern: "no symbol" }, { symbol: "X" }, 42, null, ["nested"]]),
    ).toEqual([
      { symbol: null, concern: "old string" },
      { symbol: "SMCI", concern: "new" },
      { symbol: null, concern: "numeric symbol" },
      { symbol: null, concern: "no symbol" },
    ]);
  });
});

describe("flaggedSymbols", () => {
  it("dedupes and ignores whole-message concerns", () => {
    expect([...flaggedSymbols({ systemConcerns: [{ symbol: "SMCI", concern: "a" }, { symbol: "SMCI", concern: "b" }, { symbol: null, concern: "c" }, { symbol: "NOK", concern: "d" }] })].sort()).toEqual(["NOK", "SMCI"]);
  });
});

describe("reconcileAgreement keeps the first call's concerns", () => {
  it("two agreeing trades keep call 1's concerns only (call 2's flagged tickers are lost)", () => {
    const first = { decision: "trade" as const, actionKind: "open_covered_call" as const, candidateId: "NOK:covered_call:2026-10-16:5", confidence: 0.8, reasons: ["a"], risksAcknowledged: [], systemConcerns: [] };
    const second = { ...first, systemConcerns: [{ symbol: "NOK", concern: "flagged by call 2" }] };
    // Only matters if the two-call mode comes back (one call per decision since 2026-10-06).
    expect(reconcileAgreement(first, second).decision.systemConcerns).toEqual([]);
  });
});
