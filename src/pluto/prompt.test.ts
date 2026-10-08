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
    tickers: [{ scored, eligible: [], eligibleRolls: [], closeActions: [closeOn("position-human", "SMCI:close_leg:leg-1"), closeOn("position-pluto", "SMCI:close_leg:leg-2")], heldPositions: [] }],
    spreadCostSharePct: 50,
    recentDecisions: [],
    trigger: { kind: "grade_crossing", detail: { heldLeg: [], symbols: ["SMCI"] } },
    plutoOpenedPositionIds: new Set(["position-pluto"]),
    openDaysIso: [],
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

  it("states the grade floor actually in force and explains managed positions and covered calls that buy shares", () => {
    const weak = buildPlutoSystemPrompt(input().settings);
    expect(weak).toContain("Only weak or better reaches you.");
    expect(weak).not.toContain("Only good or better reaches you.");
    expect(buildPlutoSystemPrompt({ ...input().settings, minGrade: "strong" })).toContain("Only strong reaches you.");
    expect(weak).toContain("Pluto manages every position on the tickers it is enabled on, whoever opened it.");
    expect(weak).toContain("code buys the missing 100 shares per contract at the live price in the same order.");
    expect(weak).toContain("In reasons, call it a covered call, never a buy-write.");
    expect(weak).toContain("code never trades a ticker you flagged");
  });

  it("v3.4: lists only the macro releases still to come, and asks for a stronger edge instead of ruling the trade out", () => {
    const macroEvents = [
      { dateIso: "2026-10-06", eventAtIso: "2026-10-06T12:30:00Z", title: "CPI" },
      { dateIso: "2026-10-07", eventAtIso: "2026-10-07T18:00:00Z", title: "Fed rate decision" },
    ];
    const { payload } = buildPlutoUserPayload(input({ tickers: [{ scored: { ...scored, macroEvents } as PlutoPromptTickerInput["scored"], eligible: [], eligibleRolls: [], closeActions: [closeOn("position-human", "SMCI:close_leg:leg-1")], heldPositions: [] }] }));
    expect((payload.tickers as { macro_events?: unknown }[])[0]!.macro_events).toEqual([{ date: "2026-10-07", title: "Fed rate decision" }]);
    const prompt = buildPlutoSystemPrompt(input().settings);
    expect(prompt).toContain("Riskiest: a heavy release in the last one or two sessions of a short contract; ask for a clearly stronger net edge there, or pass.");
    expect(prompt).toContain("Heavy: the Fed rate decision, CPI, the US presidential election. Medium: the US midterm elections. Light: GDP.");
    expect(prompt).not.toContain("no earnings or major macro release falls before expiry");
    expect(prompt).toContain("no earnings falls before expiry, liquidity is real");
    expect(prompt).toContain("Earnings are the heaviest event there is, far above any macro release");
    expect(prompt).toContain("Never open a position, or roll one, so that it is still open when the company reports.");
  });
});

describe("prompt v3.8: held positions and event timing (2026-10-08)", () => {
  const eventAt = (dateIso: string, hourUtc: number) => `${dateIso}T${String(hourUtc).padStart(2, "0")}:00:00.000Z`;
  // Thu 2026-10-08 14:30 UTC; CPI Wed 10-14 08:30 ET (12:30 UTC).
  const macroEvents = [{ dateIso: "2026-10-14", eventAtIso: "2026-10-14T12:30:00.000Z", title: "CPI" }];
  const scored = { symbol: "SMCI", sector: "Technology", spotPrice: 43.46, dayChangePercent: 0.6, atmImpliedVolatility: 0.8, forecast: { volatility: 0.7 }, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: null, macroEvents, snapshotCapturedAt: null } as unknown as PlutoPromptTickerInput["scored"];
  const candidate = { strategyKey: "cash_secured_put", expiry: "2026-10-16", dte: 8, strike: 40, delta: -0.2, bid: 0.5, ask: 0.55, spreadPercent: 9, surfaceImpliedVolatility: 0.8, midImpliedVolatility: 0.8, edge: 0.1, netEdge: 0.09, edgeDollars: 20, annualizedYield: 0.5, dollarRisk: 3950, riskAdjustedRatio: 0.005, openInterest: 500, volume: 300, grade: "good", quoteSource: "day", quotedAt: eventAt("2026-10-08", 14), flags: ["macro_event_before_expiry"] };
  const heldPut = {
    legId: "leg-1", positionId: "position-pluto", strategy: "cash_secured_put" as const, strike: 40, expiry: "2026-10-16", dte: 8, delta: -0.1, quantity: 2, entryCredit: 1, bid: 0.12, ask: 0.16,
    capturedPct: 84, maxRemainingGainDollars: 28, closeCostDollars: 5.36, strikeDistanceDays: 1.83, eventStressLossDollars: 61.4,
    event: { title: "CPI", weight: "heavy" as const, dateIso: "2026-10-14", sessionIso: "2026-10-14", sessionsUntil: 4, sessionsAfter: 3, stressNormalDays: 2 },
  };
  const input = (tickers: PlutoPromptTickerInput[]): PlutoPromptInput => ({
    now: new Date("2026-10-08T14:30:00Z"),
    todayEasternIso: "2026-10-08",
    minutesToWindowEnd: 200,
    spyDayChangePct: 0.2,
    account: { netLiquidationValue: 1_000_000, freeCash: 700_000, plutoBudgetPct: 50, plutoBudgetUsedPct: 10, managedPositions: 1, maxOpenPositions: 15, actionsToday: 0, maxActionsPerSession: 10, openPositionsBySymbol: { SMCI: ["cash_secured_put"] } },
    settings: { minGrade: "good", maxAbsDelta: 0.4, minDte: 1, maxDte: 45, maxTickerExposurePct: 10, orderSizePctOfBudget: 10, confidenceFloor: 0.6 } as PlutoPromptInput["settings"],
    tickers,
    spreadCostSharePct: 50,
    recentDecisions: [],
    trigger: { kind: "held_leg", detail: {} },
    plutoOpenedPositionIds: new Set(["position-pluto"]),
    openDaysIso: ["2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"],
  });

  it("an open candidate names the heaviest release in its life with the sessions until and after it", () => {
    const { payload } = buildPlutoUserPayload(input([{ scored, eligible: [{ id: "SMCI:cash_secured_put:2026-10-16:40", kind: "open_cash_secured_put", symbol: "SMCI", candidate: candidate as never }], eligibleRolls: [], closeActions: [], heldPositions: [] }]));
    const [offered] = (payload.tickers as { candidates: { event: unknown }[] }[])[0]!.candidates;
    expect(offered!.event).toEqual({ title: "CPI", weight: "heavy", date: "2026-10-14", sessions_until: 4, sessions_after: 3 });
  });

  it("held_positions lists every held put with its figures and who opened it, even when nothing is on offer for the ticker", () => {
    const { payload, offeredIds } = buildPlutoUserPayload(input([{ scored, eligible: [], eligibleRolls: [], closeActions: [], heldPositions: [heldPut] }]));
    const ticker = (payload.tickers as Record<string, unknown>[])[0]!;
    expect(ticker.held_positions).toEqual([
      {
        leg_id: "leg-1", strategy: "cash_secured_put", opened_by: "pluto", strike: 40, expiry: "2026-10-16", dte: 8, delta: -0.1, quantity: 2, entry_credit: 1, bid: 0.12, ask: 0.16,
        captured_pct: 84, max_remaining_gain_dollars: 28, close_cost_dollars: 5, strike_distance_days: 1.8,
        event: { title: "CPI", weight: "heavy", date: "2026-10-14", sessions_until: 4, sessions_after: 3, stress_normal_days: 2 },
        event_stress_loss_dollars: 61,
      },
    ]);
    // Nothing to trade on it: the ticker is shown, no id is offered.
    expect(offeredIds.size).toBe(0);
  });

  it("a ticker with nothing on offer and nothing held is left out", () => {
    const { payload } = buildPlutoUserPayload(input([{ scored, eligible: [], eligibleRolls: [], closeActions: [], heldPositions: [] }]));
    expect(payload.tickers).toEqual([]);
  });

  it("explains the held figures, the event timing and the event closes, puts and whole covered calls", () => {
    const prompt = buildPlutoSystemPrompt(input([]).settings);
    expect(prompt).toContain("sessions_until is how many sessions away it is, sessions_after how many sessions the contract is still open");
    expect(prompt).toContain("- held_positions: every short put and covered call Pluto manages on the ticker, whatever Signals thinks of it.");
    expect(prompt).toContain("so it is a ceiling, not an expectation");
    expect(prompt).toContain("event_stress_loss_dollars is how much worse the position would be right after a move of that many normal days against it on the release");
    expect(prompt).toContain("closing a short put (a buyback) or a whole covered call (the call bought back and the shares sold together, kind close_position)");
    expect(prompt).toContain("Code never offers an event close at a loss and never sends one itself");
    expect(prompt).toContain("held_leg_id is the leg_id of the position in held_positions");
  });
});
