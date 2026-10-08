import { describe, expect, it } from "vitest";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, recentDecisionsForPrompt, type PlutoPromptInput, type PlutoPromptTickerInput } from "./prompt.js";

// Audit (G3, 2026-10-07): the recent_decisions block the model reads, from the decision rows to the payload.

const at = (minute: number) => new Date(Date.UTC(2026, 9, 7, 14, minute));

describe("recentDecisionsForPrompt (audit)", () => {
  it("keeps the order it is given (newest first, as passRunner queries it) and one entry per decision", () => {
    const entries = recentDecisionsForPrompt(
      [
        { passId: "p3", createdAt: at(3), parsedOutput: { decision: "trade", candidate_id: "A:open:1", reasons: ["r3"] } },
        { passId: "p2", createdAt: at(2), parsedOutput: { decision: "no_trade", candidate_id: null, reasons: ["r2"] } },
        { passId: "p1", createdAt: at(1), parsedOutput: { decision: "trade", candidate_id: "B:open:1", reasons: [] } },
      ],
      new Map([
        ["p3", { outcome: "filled", blockReason: null }],
        ["p1", { outcome: "cancelled", blockReason: "unfilled after 10 minutes" }],
      ]),
    );
    expect(entries.map((entry) => [entry.at, entry.verdict, entry.outcome, entry.outcomeDetail])).toEqual([
      [at(3).toISOString(), "trade", "filled", null],
      [at(2).toISOString(), "no_trade", null, null],
      [at(1).toISOString(), "trade", "cancelled", "unfilled after 10 minutes"],
    ]);
  });

  it("never carries a block reason onto a verdict other than trade", () => {
    const [entry] = recentDecisionsForPrompt([{ passId: "p", createdAt: at(0), parsedOutput: { decision: "abstain", reasons: ["quiet day"] } }], new Map([["p", { outcome: "blocked", blockReason: "should not show" }]]));
    expect(entry).toMatchObject({ verdict: "abstain", outcome: null, outcomeDetail: null, reason: "quiet day" });
  });

  it("reads a decision with no candidate or reasons as nulls, not undefined", () => {
    const [entry] = recentDecisionsForPrompt([{ passId: "p", createdAt: at(0), parsedOutput: { decision: "trade" } }], new Map());
    expect(entry).toEqual({ at: at(0).toISOString(), verdict: "trade", candidateId: null, reason: null, outcome: "not_executed", outcomeDetail: null });
  });
});

describe("recent_decisions in the user payload (audit)", () => {
  const scored = { symbol: "SMCI", sector: "Technology", spotPrice: 43.46, dayChangePercent: 0.6, atmImpliedVolatility: 0.8, forecast: { volatility: 0.7 }, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: null, macroEvents: [], snapshotCapturedAt: null } as unknown as PlutoPromptTickerInput["scored"];
  const input = (recentDecisions: PlutoPromptInput["recentDecisions"]): PlutoPromptInput => ({
    now: new Date("2026-10-07T18:43:46Z"),
    todayEasternIso: "2026-10-07",
    minutesToWindowEnd: 46,
    spyDayChangePct: 0.6,
    account: { netLiquidationValue: 1_000_000, freeCash: 700_000, plutoBudgetPct: 50, plutoBudgetUsedPct: 10, managedPositions: 1, maxOpenPositions: 15, actionsToday: 0, maxActionsPerSession: 10, openPositionsBySymbol: {} },
    settings: { minGrade: "weak", maxAbsDelta: 0.4, minDte: 1, maxDte: 45, maxTickerExposurePct: 10, orderSizePctOfBudget: 10, confidenceFloor: 0.6 } as PlutoPromptInput["settings"],
    tickers: [{ scored, eligible: [], eligibleRolls: [], closeActions: [], heldPositions: [] }],
    spreadCostSharePct: 50,
    recentDecisions,
    trigger: { kind: "opening_look", detail: {} },
    plutoOpenedPositionIds: new Set(),
    openDaysIso: [],
  });

  it("sends a blocked trade with its outcome and why, and leaves the keys off a no-trade", () => {
    const recent = recentDecisionsForPrompt(
      [
        { passId: "p2", createdAt: at(2), parsedOutput: { decision: "trade", candidate_id: "SMCI:close_leg:leg-1", reasons: ["Lock the profit."] } },
        { passId: "p1", createdAt: at(1), parsedOutput: { decision: "no_trade", reasons: ["Weak edge."] } },
      ],
      new Map([["p2", { outcome: "blocked", blockReason: "offer_fresh: no longer offered" }]]),
    );
    const { payload } = buildPlutoUserPayload(input(recent));
    expect(payload.recent_decisions).toEqual([
      { at: at(2).toISOString(), verdict: "trade", candidate_id: "SMCI:close_leg:leg-1", outcome: "blocked", outcome_detail: "offer_fresh: no longer offered", reason: "Lock the profit." },
      { at: at(1).toISOString(), verdict: "no_trade", reason: "Weak edge." },
    ]);
  });

  it("omits recent_decisions entirely when there are none", () => {
    const { payload } = buildPlutoUserPayload(input([]));
    expect(payload).not.toHaveProperty("recent_decisions");
  });

  it("names every outcome the code can store in the system prompt", () => {
    const prompt = buildPlutoSystemPrompt(input([]).settings);
    // Outcomes pluto_actions.outcome takes for a trade (ledger / executor / order watch), plus the prompt's own not_executed.
    for (const outcome of ["blocked", "validated", "order_built", "confirmed", "filled", "partially_filled", "cancelled", "rejected", "error", "not_executed"]) expect(prompt).toContain(outcome);
  });

  it("names cancelled_partially_filled, a final order status the watch stores as the outcome, as one that changed the book", () => {
    // finalOrderRequestStatuses (lib/orderRequestStatuses.ts) includes cancelled_partially_filled; watchPlutoOrder stores the status as the outcome.
    const prompt = buildPlutoSystemPrompt(input([]).settings);
    expect(prompt).toContain("cancelled_partially_filled");
  });
});
