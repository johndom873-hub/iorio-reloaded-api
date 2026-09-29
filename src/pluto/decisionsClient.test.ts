import { describe, expect, it } from "vitest";
import { jevQuestionsForPayload, plutoDecisionFromJev } from "./decisionsClient.js";

const offered = new Set(["HOOD:cash_secured_put:2026-10-16:100", "HOOD:roll:leg1:2026-10-30:95"]);
const payload = {
  tickers: [{ symbol: "HOOD", candidates: [{ id: "HOOD:cash_secured_put:2026-10-16:100", kind: "open_cash_secured_put", expiry: "2026-10-16", strike: 100 }], rolls: [{ id: "HOOD:roll:leg1:2026-10-30:95", replacement: { strike: 95, expiry: "2026-10-30" } }] }],
};

describe("jevQuestionsForPayload", () => {
  it("offers every id plus no_trade as choice criteria and a stand-aside noul", () => {
    const questions = jevQuestionsForPayload(payload, offered);
    expect(questions.action!.type).toBe("choice");
    expect(Object.keys((questions.action as { criteria: Record<string, string> }).criteria).sort()).toEqual([...offered, "no_trade"].sort());
    expect(questions.system_concern!.type).toBe("noul");
  });
});

describe("plutoDecisionFromJev", () => {
  it("maps a confident choice to a trade, no_trade to no_trade, and a stand-aside noul to an abstain", () => {
    const trade = plutoDecisionFromJev({ action: { type: "choice", choice: "HOOD:cash_secured_put:2026-10-16:100", probabilities: { "HOOD:cash_secured_put:2026-10-16:100": 0.85, no_trade: 0.15 }, confidence: 0.77 }, system_concern: { type: "noul", noul: 0.2 } }, offered);
    expect(trade).toMatchObject({ decision: "trade", actionKind: "open_cash_secured_put", candidateId: "HOOD:cash_secured_put:2026-10-16:100", confidence: 0.77 });
    expect(trade.reasons[0]).toContain("p=0.85");
    expect(plutoDecisionFromJev({ action: { type: "choice", choice: "no_trade", probabilities: { no_trade: 0.9 }, confidence: 0.85 } }, offered).decision).toBe("no_trade");
    expect(plutoDecisionFromJev({ action: { type: "choice", choice: "HOOD:cash_secured_put:2026-10-16:100", probabilities: {}, confidence: 0.9 }, system_concern: { type: "noul", noul: 0.7 } }, offered).decision).toBe("abstain_system_concern");
    expect(plutoDecisionFromJev({ action: { type: "choice", choice: "made_up", probabilities: {}, confidence: 0.9 } }, offered).decision).toBe("no_trade");
  });
});
