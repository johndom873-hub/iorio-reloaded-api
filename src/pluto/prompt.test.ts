import { describe, expect, it } from "vitest";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, recentDecisionsForPrompt, type PlutoPromptInput, type PlutoPromptTickerInput } from "./prompt.js";

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

describe("prompt v3.3 payload and wording (2026-10-07)", () => {
  const scored = { symbol: "SMCI", sector: "Technology", spotPrice: 43.46, dayChangePercent: 0.6, atmImpliedVolatility: 0.8, forecast: { volatility: 0.7 }, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: null, macroEvents: [], snapshotCapturedAt: null } as unknown as PlutoPromptTickerInput["scored"];
  const closeOn = (positionId: string, id: string) => ({ id, kind: "close_leg" as const, symbol: "SMCI", positionId, description: "Buy back 10× SMCI $42.5P", cycle_pnl: 218, detail: {} });
  const input = (overrides: Partial<PlutoPromptInput> = {}): PlutoPromptInput => ({
    now: new Date("2026-10-06T18:43:46Z"),
    todayEasternIso: "2026-10-06",
    minutesToWindowEnd: 46,
    spyDayChangePct: 0.6,
    account: { netLiquidationValue: 1_044_000, freeCash: 762_000, plutoBudgetPct: 50, plutoBudgetUsedPct: 11.7, managedPositions: 3, maxOpenPositions: 15, actionsToday: 0, maxActionsPerSession: 10, openPositionsBySymbol: { SMCI: ["cash_secured_put"] } },
    settings: { minGrade: "weak", maxAbsDelta: 0.4, minDte: 1, maxDte: 45, maxTickerExposurePct: 10, orderSizePctOfBudget: 10, confidenceFloor: 0.6 } as PlutoPromptInput["settings"],
    tickers: [{ scored, eligible: [], eligibleRolls: [], closeActions: [closeOn("position-human", "SMCI:close_leg:leg-1"), closeOn("position-pluto", "SMCI:close_leg:leg-2")] }],
    spreadCostSharePct: 50,
    recentDecisions: [],
    trigger: { kind: "grade_crossing", detail: { heldLeg: [], symbols: ["SMCI"] } },
    plutoOpenedPositionIds: new Set(["position-pluto"]),
    ...overrides,
  });

  it("counts every managed position, labels who opened each close action, and sends the trigger's kind only", () => {
    const { payload } = buildPlutoUserPayload(input());
    const account = payload.account as Record<string, unknown>;
    expect(account.managed_positions).toBe(3);
    expect(account).not.toHaveProperty("open_pluto_positions");
    const closes = (payload.tickers as { close_actions: { id: string; opened_by: string }[] }[])[0]!.close_actions;
    expect(closes.map((close) => [close.id, close.opened_by])).toEqual([["SMCI:close_leg:leg-1", "a person"], ["SMCI:close_leg:leg-2", "pluto"]]);
    expect(payload.trigger).toEqual({ kind: "grade_crossing" });
  });

  it("states the grade floor actually in force and explains managed positions and buy-writes", () => {
    const weak = buildPlutoSystemPrompt(input().settings);
    expect(weak).toContain("Only weak or better reaches you.");
    expect(weak).not.toContain("Only good or better reaches you.");
    expect(buildPlutoSystemPrompt({ ...input().settings, minGrade: "strong" })).toContain("Only strong reaches you.");
    expect(weak).toContain("Pluto manages every position on the tickers it is enabled on, whoever opened it.");
    expect(weak).toContain("(a buy-write)");
    expect(weak).toContain("code never trades a ticker you flagged");
  });

  it("v3.4: lists only the macro releases still to come, and asks for a stronger edge instead of ruling the trade out", () => {
    const macroEvents = [
      { dateIso: "2026-10-06", eventAtIso: "2026-10-06T12:30:00Z", title: "Core PCE Price Index MoM" },
      { dateIso: "2026-10-07", eventAtIso: "2026-10-07T18:00:00Z", title: "FOMC Minutes" },
    ];
    const { payload } = buildPlutoUserPayload(input({ tickers: [{ scored: { ...scored, macroEvents } as PlutoPromptTickerInput["scored"], eligible: [], eligibleRolls: [], closeActions: [closeOn("position-human", "SMCI:close_leg:leg-1")] }] }));
    expect((payload.tickers as { macro_events?: unknown }[])[0]!.macro_events).toEqual([{ date: "2026-10-07", title: "FOMC Minutes" }]);
    const prompt = buildPlutoSystemPrompt(input().settings);
    expect(prompt).toContain("ask for a clearly stronger net edge before trading through one");
    expect(prompt).toContain("Light: FOMC Minutes, PPI, GDP.");
    expect(prompt).not.toContain("no earnings or major macro release falls before expiry");
    expect(prompt).toContain("no earnings falls before expiry, liquidity is real");
    expect(prompt).toContain("Earnings are the heaviest event there is, far above any macro release");
    expect(prompt).toContain("Never open a position, or roll one, so that it is still open when the company reports.");
  });
});
