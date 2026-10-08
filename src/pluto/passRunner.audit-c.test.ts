import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit C (2026-10-07): how a round uses buildCloseOffersForTicker's automatic offers (Formula P1 odd lots, P3 earnings
// buybacks): executed by code once per round (never again by the re-score after the burst), labelled with their rule, and
// kept off the model's menu. Same mocking approach as passRunner.burstOrder.test.ts.

const harness = vi.hoisted(() => ({
  closeBuilds: [] as { todayIso: string }[],
  closeOffers: [] as Record<string, unknown>[],
  promptCloseActionIds: [] as string[][],
  recordedActions: [] as { kind: string; gateResults: { gate: string; ok: boolean; detail: string }[] }[],
  modelAnswer: null as Record<string, unknown> | null,
}));

vi.mock("../db/connection.js", () => {
  const rowsFor = (table: string) => (table.startsWith("shortlist_entries") ? [{ ticker_id: "t-aaa" }] : []);
  const chain = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["whereNull", "where", "whereNot", "whereNotNull", "whereIn", "orderBy", "limit"]) query[method] = () => query;
    query.select = async () => rowsFor(table);
    return query;
  };
  return { db: Object.assign((table: string) => chain(table), { raw: () => "" }) };
});
vi.mock("./settingsStore.js", () => ({
  loadPlutoSettings: async () => ({ perTickerModelCooldownMinutes: 5, burstLines: 10, spyStressBreakerPct: 3, modelId: "test/model", reasoningEffort: "low", callTimeoutSeconds: 10, promptVersion: "test", confidenceFloor: 0.6, telegramVerbosity: "off", maxOpenPositions: 15, maxActionsPerSession: 10, capitalBudgetPct: 50 }),
}));
vi.mock("./ledger.js", () => ({
  startPlutoPass: async () => "pass-1",
  finishPlutoPass: vi.fn(),
  recordPlutoEvent: vi.fn(),
  relabelPlutoPass: vi.fn(),
  recordPlutoAction: async (input: { kind: string; gateResults: { gate: string; ok: boolean; detail: string }[] }) => {
    harness.recordedActions.push(input);
    return `action-${harness.recordedActions.length}`;
  },
  recordPlutoDecision: vi.fn(),
  updatePlutoAction: vi.fn(),
}));
vi.mock("./stateStore.js", () => ({ loadPlutoState: async () => ({ breakers: {} }), recordPlutoPass: vi.fn(), tripPlutoBreaker: vi.fn() }));
vi.mock("./systemChecks.js", () => ({
  runPlutoSystemChecks: async () => ({ ok: true, failures: [], checks: {}, context: { state: { stressOverrideDate: null }, todayEasternIso: "2026-10-07", session: { cancelByMs: 0, windowEndEt: "15:30" }, netLiquidationValue: 1_000_000, counters: { actionsToday: 0 } } }),
}));
vi.mock("../lib/signalsStore.js", () => ({
  loadSignalsUniverseTickers: async () => [{ tickerId: "t-aaa", symbol: "AAA", companyName: null, sector: null }],
  loadTickerSignalsInputs: async () => ({ slices: [], todayEasternIso: "2026-10-07" }),
  accountContextFromTotalCash: async () => ({ freeCash: 500_000 }),
  loadBarsForTilt: async () => [],
}));
vi.mock("../lib/signalsLiveScoring.js", () => ({
  scoreTicker: (_inputs: unknown, _account: unknown, _settings: unknown, live?: { liveQuotes: unknown[] }) => ({
    symbol: "AAA",
    candidates: [{ id: "AAA:covered_call:2026-10-16:30", expiry: "2026-10-16", strike: 30, strategyKey: "covered_call", edgeDollars: 10, netEdge: 0.05, grade: "good" }],
    heldLegs: [],
    rolls: [],
    live: live?.liveQuotes.length ?? 0,
  }),
}));
vi.mock("./candidateFilters.js", () => ({
  openCandidateId: (_symbol: string, candidate: { id: string }) => candidate.id,
  filterTickerForPluto: ({ scored }: { scored: { candidates: { id: string }[] } }) => ({
    symbol: "AAA",
    tickerBlocks: [],
    eligible: scored.candidates.map((candidate) => ({ id: candidate.id, kind: "open_covered_call", symbol: "AAA", candidate })),
    eligibleRolls: [],
    rejected: [],
  }),
  deterministicTopPick: () => null,
  findSameContractConflict: () => null,
  rejectOpenCandidate: () => [],
  rejectTicker: () => [],
  rollCandidateId: () => "",
}));
vi.mock("./book.js", () => ({ loadPlutoBook: async () => ({ openPositions: [], committedDollars: 0, plutoOpenedPositionIds: new Set(), workingOrderSymbols: new Set(), lastFilledActionAtBySymbol: new Map() }), loadOccupiedContracts: async () => [], loadLastFilledPlutoActionAtBySymbol: async () => new Map(), loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }), anyOpenPositionOn: async () => false }));
vi.mock("./closeActions.js", () => ({
  buildCloseOffersForTicker: async (input: { todayIso: string }) => {
    harness.closeBuilds.push({ todayIso: input.todayIso });
    return { offers: harness.closeOffers.map((offer) => ({ ...offer })), skipped: [], heldPositions: [] };
  },
}));
vi.mock("../lib/marketSessionStatus.js", () => ({ previousOpenSessionDate: async () => "2026-10-06", loadOpenDaysBetween: async () => [] }));
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: async () => ({ spreadCostChargedPct: 50 }) }));
vi.mock("./accountSummaryCache.js", () => ({ fetchPlutoAccountSummary: async () => ({}) }));
vi.mock("../lib/ivMetrics.js", () => ({ computeIvMetrics: async () => ({ ivRank: null }) }));
vi.mock("./moveContext.js", () => ({ computeMoveContext: () => null }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn(), notifyTelegram: vi.fn() }));
vi.mock("./prompts.js", () => ({ ensurePlutoPrompt: async () => "prompt-1" }));
vi.mock("./prompt.js", () => ({
  buildPlutoSystemPrompt: () => "system",
  buildPlutoUserPayload: (input: { tickers: { closeActions: { id: string }[] }[] }) => {
    harness.promptCloseActionIds.push(input.tickers.flatMap((ticker) => ticker.closeActions.map((offer) => offer.id)));
    return { payload: {}, offeredIds: new Set<string>(["AAA:covered_call:2026-10-16:30", "AAA:close_leg:leg-p2", "AAA:close_position:pos-cc"]) };
  },
  plutoPromptVersion: "test",
  recentDecisionsForPrompt: () => [],
}));
vi.mock("./modelClient.js", () => ({
  callPlutoModel: async () => ({ ok: true, rawText: JSON.stringify(harness.modelAnswer ?? { decision: "no_trade", action_kind: null, candidate_id: null, confidence: 0.9, reasons: ["nothing worth it"], risks_acknowledged: [], system_concerns: [] }), servedModelId: "test/model", latencyMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, serviceTier: null, error: null, httpStatus: 200 }),
}));
vi.mock("./executor.js", () => ({ executePlutoClose: vi.fn(async () => ({ outcome: "confirmed", orderId: "order-1", detail: "" })), executePlutoOrder: vi.fn(), watchPlutoOrder: vi.fn(async () => ({ outcome: "filled", detail: "" })) }));
vi.mock("./postModelGates.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./postModelGates.js")>()), runPostModelGates: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computePositionExposures: vi.fn() }));

const { runPlutoPass } = await import("./passRunner.js");
const executor = await import("./executor.js");
const ledger = await import("./ledger.js");

function makeContext() {
  return {
    api: {} as never,
    openRouterApiKey: "test",
    marketWatch: {
      snapshot: () => ({ last: 30, bid: 29.9, ask: 30.1 }),
      spyDayChangePct: () => 0.5,
      burst: async () => [{ expiry: "2026-10-16", strike: 30, right: "C" as const, bid: 1, ask: 1.1, quotedAt: new Date().toISOString() }],
    } as never,
    lastFingerprintBySymbol: new Map<string, string>(),
    lastModelEvaluationAtBySymbol: new Map<string, number>(),
    trackWatch: vi.fn(),
  };
}

const p3Offer = {
  id: "AAA:close_leg:leg-p3", kind: "close_leg", symbol: "AAA", description: "Buy back 1× AAA $30P before the earnings", cycle_pnl: 100, detail: {}, positionId: "pos-p3", legIds: ["leg-p3"],
  automatic: true, automaticReason: "expires after the 2026-10-09 earnings (after the close): bought back at a profit within the last 5 sessions before it (Formula P3)", limitPrice: 0.2, side: "buy", multiplier: 100, quantity: 1,
  contract: { strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 30, right: "P" },
};
const p2Offer = { ...p3Offer, id: "AAA:close_leg:leg-p2", positionId: "pos-p2", legIds: ["leg-p2"], automatic: false, automaticReason: null };
const dayRound = { trigger: "day_signals_update" as const, triggerDetail: {}, symbols: ["AAA"], force: false };

beforeEach(() => {
  harness.closeBuilds.length = 0;
  harness.closeOffers = [p3Offer, p2Offer];
  harness.promptCloseActionIds.length = 0;
  harness.recordedActions.length = 0;
  harness.modelAnswer = null;
  vi.mocked(executor.executePlutoClose).mockClear();
  vi.mocked(executor.watchPlutoOrder).mockClear();
});

describe("automatic close offers in a round", () => {
  it("are executed once, with their rule recorded; the ticker is then offered nothing (its order is working), so no model call", async () => {
    const context = makeContext();
    const summary = await runPlutoPass(dayRound, context);
    expect(executor.executePlutoClose).toHaveBeenCalledTimes(1);
    const closeInput = vi.mocked(executor.executePlutoClose).mock.calls[0]![2];
    expect(closeInput).toMatchObject({ positionId: "pos-p3", legs: [{ legId: "leg-p3", limitPrice: 0.2 }] });
    expect(closeInput.reasons[0]).toMatch(/Formula P3/);
    const automaticAction = harness.recordedActions.find((action) => action.gateResults.some((gate) => gate.gate === "automatic_close"))!;
    expect(automaticAction.gateResults[0]!.detail).toMatch(/Formula P3/);
    // The watcher gets a buy reference at the limit (the fill-slippage check).
    expect(vi.mocked(executor.watchPlutoOrder).mock.calls[0]![2]).toMatchObject({ reference: { price: 0.2, side: "buy", multiplier: 100 } });
    // Anything chosen for AAA would be blocked by the working-order gate: no burst, no re-score, no model call.
    expect(harness.closeBuilds.length).toBe(1);
    expect(summary.modelCalled).toBe(false);
    expect(summary.skippedReason).toBe("nothing eligible");
    expect(harness.promptCloseActionIds).toEqual([]);
  });

  it("an automatic close the route refused leaves the ticker on the menu, the automatic offer itself kept off it", async () => {
    vi.mocked(executor.executePlutoClose).mockResolvedValueOnce({ outcome: "blocked", orderId: null, detail: "build refused" });
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(executor.executePlutoClose).toHaveBeenCalledTimes(1);
    // Built twice (before and after the burst), executed once.
    expect(harness.closeBuilds.length).toBe(2);
    expect(harness.closeBuilds.every((build) => build.todayIso === "2026-10-07")).toBe(true);
    expect(summary.modelCalled).toBe(true);
    expect(harness.promptCloseActionIds).toEqual([["AAA:close_leg:leg-p2"]]);
  });

  it("runChosenClose re-derives with today's date and executes the fresh offer", async () => {
    harness.closeOffers = [p2Offer];
    harness.modelAnswer = { decision: "trade", action_kind: "close_leg", candidate_id: "AAA:close_leg:leg-p2", confidence: 0.9, reasons: ["take the profit"], risks_acknowledged: [], system_concerns: [] };
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(summary.outcome).toBe("confirmed");
    expect(harness.closeBuilds.length).toBe(3);
    expect(harness.closeBuilds.at(-1)!.todayIso).toBe("2026-10-07");
    expect(executor.executePlutoClose).toHaveBeenCalledTimes(1);
    expect(vi.mocked(executor.executePlutoClose).mock.calls[0]![2]).toMatchObject({ positionId: "pos-p2", reasons: ["take the profit"] });
  });
});

describe("a model-chosen whole covered-call close (v3.8, an event close)", () => {
  const coveredCallClose = {
    id: "AAA:close_position:pos-cc", kind: "close_position", symbol: "AAA", description: "AAA Close $32 Call + sell 100 shares before the Fed", cycle_pnl: 246, detail: {}, positionId: "pos-cc", legIds: ["call-leg", "stock-leg"],
    automatic: false, automaticReason: null, reviewKey: "c80s3", limitPrice: 30, side: "sell", multiplier: 1, quantity: 100,
    legLimitPrices: { "call-leg": 0.14, "stock-leg": 30 }, otherReferenceLegs: [{ side: "buy", price: 0.14, multiplier: 100 }],
    contract: { strategyKey: "covered_call", expiry: "2026-10-16", strike: 32, right: "C" },
  };

  it("sends each leg at its own limit and references the shares with the call as the other leg", async () => {
    harness.closeOffers = [coveredCallClose];
    harness.modelAnswer = { decision: "trade", action_kind: "close_position", candidate_id: "AAA:close_position:pos-cc", confidence: 0.9, reasons: ["$14 left to earn against a $390 stress loss on the Fed"], risks_acknowledged: [], system_concerns: [] };
    vi.mocked(ledger.updatePlutoAction).mockClear();
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(summary.outcome).toBe("confirmed");
    expect(vi.mocked(executor.executePlutoClose).mock.calls[0]![2]).toMatchObject({ positionId: "pos-cc", legs: [{ legId: "call-leg", limitPrice: 0.14 }, { legId: "stock-leg", limitPrice: 30 }] });
    expect(ledger.updatePlutoAction).toHaveBeenCalledWith("action-1", { referenceOtherLegs: [{ side: "buy", price: 0.14, multiplier: 100 }] });
    expect(vi.mocked(executor.watchPlutoOrder).mock.calls[0]![2]).toMatchObject({ reference: { price: 30, side: "sell", multiplier: 1, otherLegs: [{ side: "buy", price: 0.14, multiplier: 100 }] } });
    expect(harness.recordedActions.at(-1)!.kind).toBe("close_position");
  });
});

describe("an event close is asked about again as its review step moves (F4)", () => {
  const eventClose = (reviewKey: string) => ({ ...p2Offer, reviewKey });

  it("same id and step: no new model call; a new step (more captured, or a session closer): asked again", async () => {
    const context = makeContext();
    harness.closeOffers = [eventClose("c80s3")];
    expect((await runPlutoPass(dayRound, context)).modelCalled).toBe(true);
    // Past the per-ticker cooldown, nothing moved: skipped.
    context.lastModelEvaluationAtBySymbol.set("AAA", 0);
    harness.closeOffers = [eventClose("c80s3")];
    expect((await runPlutoPass(dayRound, context)).skippedReason).toBe("no material change since the model last looked");
    harness.closeOffers = [eventClose("c90s3")];
    expect((await runPlutoPass(dayRound, context)).modelCalled).toBe(true);
    context.lastModelEvaluationAtBySymbol.set("AAA", 0);
    harness.closeOffers = [eventClose("c90s2")];
    expect((await runPlutoPass(dayRound, context)).modelCalled).toBe(true);
  });
});
