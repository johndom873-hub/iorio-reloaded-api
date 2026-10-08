import { describe, expect, it } from "vitest";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { RollSignalCandidate } from "../lib/rollSignalCandidates.js";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, plutoPromptVersion, recentDecisionsForPrompt, type PlutoPromptInput, type PlutoPromptTickerInput } from "./prompt.js";

// Audit B (2026-10-07): prompt v3.3 → v3.5 payload and wording.
const now = new Date("2026-10-07T15:00:00Z"); // 11:00 ET

function candidate(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
  return {
    strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 40, dte: 9, delta: -0.22, bid: 1.0, ask: 1.1, spreadPercent: 4.9, openInterest: 1200, volume: 300, bidSize: 40, askSize: 35,
    surfaceImpliedVolatility: 0.62, midImpliedVolatility: 0.61, forecastVolatility: 0.5, edge: 0.12, frictionVolatility: 0.02, netEdge: 0.1, edgeDollars: 80, vega: 0.08,
    dollarRisk: 3900, riskAdjustedRatio: 0.008, annualizedYield: 0.83, uncompensatedSharePercent: null,
    quoteSource: "live", quotedAt: "2026-10-07T14:59:00Z", flags: [], executable: true, grade: "strong", ...overrides,
  } as SignalCandidate;
}

const scored = { symbol: "SMCI", sector: "Technology", spotPrice: 43.46, dayChangePercent: 0.6, atmImpliedVolatility: 0.8, forecast: { volatility: 0.7 }, momentum: 0.1, skew: null, elevatedVolatility: null, nextEarningsDateIso: null, macroEvents: [], snapshotCapturedAt: null } as unknown as PlutoPromptTickerInput["scored"];

function roll(positionId: string, legId: string): RollSignalCandidate {
  return { legId, positionId, strategyKey: "cash_secured_put", quantity: 2, replacement: candidate({ expiry: "2026-10-23", strike: 38 }), netRollEdge: 0.05, netRollEdgeDollars: 40, netCreditPerShare: 0.2, deltaChange: -0.05, grade: "good", flags: [] } as unknown as RollSignalCandidate;
}

function input(overrides: Partial<PlutoPromptInput> = {}): PlutoPromptInput {
  return {
    now,
    todayEasternIso: "2026-10-07",
    minutesToWindowEnd: 200,
    spyDayChangePct: 0.2,
    account: { netLiquidationValue: 1_000_000, freeCash: 700_000, plutoBudgetPct: 50, plutoBudgetUsedPct: 10, managedPositions: 4, maxOpenPositions: 15, actionsToday: 1, maxActionsPerSession: 10, openPositionsBySymbol: {} },
    settings: { minGrade: "good", maxAbsDelta: 0.4, minDte: 1, maxDte: 45, maxTickerExposurePct: 10, orderSizePctOfBudget: 10, confidenceFloor: 0.6 } as PlutoPromptInput["settings"],
    tickers: [{ scored, eligible: [{ id: "SMCI:cash_secured_put:2026-10-16:40", kind: "open_cash_secured_put", symbol: "SMCI", candidate: candidate() }], eligibleRolls: [], closeActions: [], heldPositions: [] }],
    spreadCostSharePct: 50,
    recentDecisions: [],
    trigger: { kind: "day_signals_update", detail: { symbols: ["SMCI"], secret: "internal detail" } },
    plutoOpenedPositionIds: new Set<string>(),
    openDaysIso: [],
    ...overrides,
  };
}

const tickerOf = (payload: Record<string, unknown>, index = 0) => (payload.tickers as Record<string, unknown>[])[index]!;

describe("prompt version", () => {
  it("is v3.8, matching the v3.8 migration", () => {
    expect(plutoPromptVersion).toBe("v3.8");
  });
});

describe("buildPlutoUserPayload — opened_by", () => {
  it("labels a roll pluto when its position is Pluto-opened, a person otherwise", () => {
    const { payload, offeredIds } = buildPlutoUserPayload(
      input({
        plutoOpenedPositionIds: new Set(["pos-pluto"]),
        openDaysIso: [],
        tickers: [{ scored, eligible: [], closeActions: [], heldPositions: [], eligibleRolls: [{ id: "SMCI:roll:leg-a:2026-10-23:38", kind: "roll", symbol: "SMCI", roll: roll("pos-pluto", "leg-a") }, { id: "SMCI:roll:leg-b:2026-10-23:38", kind: "roll", symbol: "SMCI", roll: roll("pos-human", "leg-b") }] }],
      }),
    );
    const rolls = tickerOf(payload).rolls as { id: string; opened_by: string }[];
    expect(rolls.map((entry) => [entry.id, entry.opened_by])).toEqual([["SMCI:roll:leg-a:2026-10-23:38", "pluto"], ["SMCI:roll:leg-b:2026-10-23:38", "a person"]]);
    expect([...offeredIds].sort()).toEqual(["SMCI:roll:leg-a:2026-10-23:38", "SMCI:roll:leg-b:2026-10-23:38"]);
  });

  it("a close action without a positionId is labelled a person", () => {
    const { payload } = buildPlutoUserPayload(input({ plutoOpenedPositionIds: new Set(["pos-pluto"]), tickers: [{ scored, eligible: [], eligibleRolls: [], closeActions: [{ id: "SMCI:close_shares:pos-pluto", kind: "close_shares", symbol: "SMCI", description: "Sell 100 SMCI", cycle_pnl: 10, detail: {} }], heldPositions: [] }] }));
    expect((tickerOf(payload).close_actions as { opened_by: string }[])[0]!.opened_by).toBe("a person");
  });

  it("a close action's detail is merged after opened_by (no current detail key collides with it)", () => {
    const { payload } = buildPlutoUserPayload(input({ plutoOpenedPositionIds: new Set(["pos-pluto"]), tickers: [{ scored, eligible: [], eligibleRolls: [], closeActions: [{ id: "SMCI:close_leg:leg-1", positionId: "pos-pluto", kind: "close_leg", symbol: "SMCI", description: "Buy back", cycle_pnl: 10, detail: { remaining_edge_dollars: -3 } }], heldPositions: [] }] }));
    const close = (tickerOf(payload).close_actions as Record<string, unknown>[])[0]!;
    expect(close.opened_by).toBe("pluto");
    expect(close.remaining_edge_dollars).toBe(-3);
  });
});

describe("buildPlutoUserPayload — trigger, macro events, recent decisions", () => {
  it("sends only the trigger's kind, never its detail", () => {
    const { payload } = buildPlutoUserPayload(input());
    expect(payload.trigger).toEqual({ kind: "day_signals_update" });
    expect(JSON.stringify(payload)).not.toContain("internal detail");
  });

  it("a release at exactly now is already out; one a second later is still to come; an unparseable time is dropped", () => {
    const macroEvents = [
      { dateIso: "2026-10-07", eventAtIso: "2026-10-07T15:00:00Z", title: "At now" },
      { dateIso: "2026-10-07", eventAtIso: "2026-10-07T15:00:01Z", title: "One second later" },
      { dateIso: "2026-10-08", eventAtIso: "not-a-time", title: "Broken" },
    ];
    const { payload } = buildPlutoUserPayload(input({ tickers: [{ ...input().tickers[0]!, scored: { ...scored, macroEvents } as PlutoPromptTickerInput["scored"] }] }));
    expect(tickerOf(payload).macro_events).toEqual([{ date: "2026-10-07", title: "One second later" }]);
  });

  it("omits macro_events entirely when every release is already out", () => {
    const macroEvents = [{ dateIso: "2026-10-07", eventAtIso: "2026-10-07T12:30:00Z", title: "CPI" }];
    const { payload } = buildPlutoUserPayload(input({ tickers: [{ ...input().tickers[0]!, scored: { ...scored, macroEvents } as PlutoPromptTickerInput["scored"] }] }));
    expect(tickerOf(payload)).not.toHaveProperty("macro_events");
  });

  it("recent decisions carry outcome and outcome_detail only for trades, and drop nulls", () => {
    const recentDecisions = recentDecisionsForPrompt(
      [
        { passId: "p1", createdAt: new Date("2026-10-07T14:00:00Z"), parsedOutput: { decision: "trade", candidate_id: "SMCI:cash_secured_put:2026-10-16:40", reasons: ["edge"] } },
        { passId: "p2", createdAt: new Date("2026-10-07T13:00:00Z"), parsedOutput: { decision: "no_trade", candidate_id: null, reasons: ["weak"] } },
        { passId: "p3", createdAt: new Date("2026-10-07T12:00:00Z"), parsedOutput: { decision: "trade", candidate_id: "NOK:covered_call:2026-10-16:5", reasons: ["edge"] } },
      ],
      new Map([["p1", { outcome: "blocked", blockReason: "flagged_ticker: the model flagged SMCI's data in the same answer" }], ["p3", { outcome: "filled", blockReason: null }]]),
    );
    const { payload } = buildPlutoUserPayload(input({ recentDecisions }));
    expect(payload.recent_decisions).toEqual([
      { at: "2026-10-07T14:00:00.000Z", verdict: "trade", candidate_id: "SMCI:cash_secured_put:2026-10-16:40", outcome: "blocked", outcome_detail: "flagged_ticker: the model flagged SMCI's data in the same answer", reason: "edge" },
      { at: "2026-10-07T13:00:00.000Z", verdict: "no_trade", reason: "weak" },
      { at: "2026-10-07T12:00:00.000Z", verdict: "trade", candidate_id: "NOK:covered_call:2026-10-16:5", outcome: "filled", reason: "edge" },
    ]);
  });

  it("an abstain whose pass has a blocked action is still reported without an outcome", () => {
    const [entry] = recentDecisionsForPrompt([{ passId: "p1", createdAt: now, parsedOutput: { decision: "abstain_system_concern", candidate_id: null, reasons: ["data"] } }], new Map([["p1", { outcome: "no_trade", blockReason: "x" }]]));
    expect(entry).toMatchObject({ verdict: "abstain_system_concern", outcome: null, outcomeDetail: null });
  });

  it("managed_positions replaces open_pluto_positions", () => {
    const { payload } = buildPlutoUserPayload(input());
    expect(payload.account).toMatchObject({ managed_positions: 4 });
    expect(payload.account).not.toHaveProperty("open_pluto_positions");
  });

  it("a ticker with nothing offered is left out, so it cannot be named in a concern", () => {
    const { payload, offeredIds } = buildPlutoUserPayload(input({ tickers: [input().tickers[0]!, { scored: { ...scored, symbol: "NOK" } as PlutoPromptTickerInput["scored"], eligible: [], eligibleRolls: [], closeActions: [], heldPositions: [] }] }));
    expect((payload.tickers as { symbol: string }[]).map((ticker) => ticker.symbol)).toEqual(["SMCI"]);
    expect([...offeredIds].every((id) => id.startsWith("SMCI:"))).toBe(true);
  });
});

describe("buildPlutoSystemPrompt — v3.3 to v3.5 wording", () => {
  const settings = input().settings;
  it("the grade sentence follows minGrade", () => {
    expect(buildPlutoSystemPrompt(settings)).toContain("Only good or better reaches you.");
    expect(buildPlutoSystemPrompt({ ...settings, minGrade: "weak" })).toContain("Only weak or better reaches you.");
    expect(buildPlutoSystemPrompt({ ...settings, minGrade: "strong" })).toContain("Only strong reaches you.");
  });

  it("rule 3: concerns per ticker, null only for the whole message, abstain only then or when every ticker is flagged", () => {
    const prompt = buildPlutoSystemPrompt(settings);
    expect(prompt).toContain("list it in system_concerns with the ticker's symbol");
    expect(prompt).toContain("Use symbol null only for a problem with the whole message");
    expect(prompt).toContain("Answer abstain_system_concern only when a null-symbol concern applies or every ticker is flagged.");
    expect(prompt).not.toContain("say why in system_concerns. Doubts");
  });

  it("v3.5 macro weights: heavy Fed/CPI/presidential, medium midterms, light GDP; no jobs/PCE/PPI weights left", () => {
    const prompt = buildPlutoSystemPrompt(settings);
    expect(prompt).toContain("Heavy: the Fed rate decision, CPI, the US presidential election. Medium: the US midterm elections. Light: GDP.");
    expect(prompt).not.toMatch(/\bPPI\b|\bPCE\b|jobs|Minutes/);
  });

  it("explains recent_decisions outcomes with every action outcome the ledger can record", () => {
    const prompt = buildPlutoSystemPrompt(settings);
    for (const outcome of ["blocked", "validated", "order_built", "confirmed", "filled", "cancelled_partially_filled", "cancelled", "rejected", "error", "not_executed"]) expect(prompt).toContain(outcome);
  });

  it("confidence floor is interpolated", () => {
    expect(buildPlutoSystemPrompt({ ...settings, confidenceFloor: 0.72 })).toContain("Confidence below 0.72 is treated as no_trade");
  });
});
