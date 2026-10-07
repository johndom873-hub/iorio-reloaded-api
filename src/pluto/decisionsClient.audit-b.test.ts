import { describe, expect, it } from "vitest";
import { plutoDecisionFromJev } from "./decisionsClient.js";

// Audit B (2026-10-07): Jev's stand-aside answer in the per-ticker concern shape.
const offered = new Set(["SMCI:cash_secured_put:2026-10-16:40"]);

describe("plutoDecisionFromJev — system concerns", () => {
  it("a stand-aside probability of 0.5 or more is a whole-message concern (symbol null)", () => {
    const decision = plutoDecisionFromJev({ action: { type: "choice", choice: "SMCI:cash_secured_put:2026-10-16:40", probabilities: { "SMCI:cash_secured_put:2026-10-16:40": 0.7 }, confidence: 0.7 }, system_concern: { type: "noul", noul: 0.5 } }, offered);
    expect(decision.decision).toBe("abstain_system_concern");
    expect(decision.systemConcerns).toEqual([{ symbol: null, concern: "jev stand-aside probability 0.50" }]);
  });

  it("below 0.5 a trade carries no concerns", () => {
    const decision = plutoDecisionFromJev({ action: { type: "choice", choice: "SMCI:cash_secured_put:2026-10-16:40", probabilities: { "SMCI:cash_secured_put:2026-10-16:40": 0.7 }, confidence: 0.7 }, system_concern: { type: "noul", noul: 0.49 } }, offered);
    expect(decision.decision).toBe("trade");
    expect(decision.systemConcerns).toEqual([]);
  });
});
