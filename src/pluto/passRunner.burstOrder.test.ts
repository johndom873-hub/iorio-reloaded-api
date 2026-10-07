import { beforeEach, describe, expect, it, vi } from "vitest";

// The round order (Marcelo, 2026-10-07): a quote burst costs up to 10 IBKR lines for 4 s, so a round decides from the Day Signals
// data whether the model will be called at all, and bursts only then. Everything the round touches outside its own logic is mocked.

const harness = vi.hoisted(() => ({
  bursts: [] as string[],
  modelCalls: 0,
  eligibleIds: ["AAA:covered_call:2026-10-16:30"] as string[],
  requotableIds: [] as string[],
  modelAnswer: null as Record<string, unknown> | null,
  blockedGates: [] as string[],
  bookError: null as string | null,
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
  recordPlutoAction: async (input: { gateResults: { gate: string; ok: boolean }[] }) => {
    harness.blockedGates.push(...input.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate));
    return "action-1";
  },
  recordPlutoDecision: vi.fn(),
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
    candidates: [...harness.eligibleIds, ...harness.requotableIds].map((id) => ({ id, expiry: "2026-10-16", strike: Number(id.split(":")[3]), strategyKey: "covered_call", edgeDollars: 10, netEdge: 0.05, grade: "good" })),
    heldLegs: [],
    rolls: [],
    live: live?.liveQuotes.length ?? 0,
  }),
}));
vi.mock("./candidateFilters.js", () => ({
  openCandidateId: (_symbol: string, candidate: { id: string }) => candidate.id,
  filterTickerForPluto: ({ scored }: { scored: { candidates: { id: string }[]; live: number } }) => ({
    symbol: "AAA",
    tickerBlocks: [],
    // A re-quoted candidate becomes eligible once the burst brought live quotes.
    eligible: scored.candidates.filter((candidate) => harness.eligibleIds.includes(candidate.id) || scored.live > 0).map((candidate) => ({ id: candidate.id, kind: "open_covered_call", symbol: "AAA", candidate })),
    eligibleRolls: [],
    rejected: scored.live > 0 ? [] : harness.requotableIds.map((id) => ({ id, reasons: ["quote 14 min old (max 10)"] })),
  }),
  deterministicTopPick: () => null,
  findSameContractConflict: () => null,
  rejectOpenCandidate: () => [],
  rejectTicker: () => [],
  rollCandidateId: () => "",
}));
vi.mock("./book.js", () => ({
  loadPlutoBook: async () => {
    if (harness.bookError) throw new Error(harness.bookError);
    return { openPositions: [], committedDollars: 0 };
  }, loadOccupiedContracts: async () => [], loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }), anyOpenPositionOn: async () => false }));
vi.mock("./closeActions.js", () => ({ buildCloseOffersForTicker: async () => ({ offers: [] }) }));
vi.mock("../lib/marketSessionStatus.js", () => ({ previousOpenSessionDate: async () => "2026-10-06" }));
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: async () => ({ spreadCostChargedPct: 50 }) }));
vi.mock("./accountSummaryCache.js", () => ({ fetchPlutoAccountSummary: async () => ({}) }));
vi.mock("../lib/ivMetrics.js", () => ({ computeIvMetrics: async () => ({ ivRank: null }) }));
vi.mock("./moveContext.js", () => ({ computeMoveContext: () => null }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn() }));
vi.mock("./prompts.js", () => ({ ensurePlutoPrompt: async () => "prompt-1" }));
vi.mock("./prompt.js", () => ({ buildPlutoSystemPrompt: () => "system", buildPlutoUserPayload: () => ({ payload: {}, offeredIds: new Set<string>(["AAA:covered_call:2026-10-16:30"]) }), plutoPromptVersion: "test", recentDecisionsForPrompt: () => [] }));
vi.mock("./modelClient.js", () => ({
  callPlutoModel: async () => {
    harness.modelCalls += 1;
    return { ok: true, rawText: JSON.stringify(harness.modelAnswer ?? { decision: "no_trade", action_kind: null, candidate_id: null, confidence: 0.9, reasons: ["nothing worth it"], risks_acknowledged: [], system_concerns: [] }), servedModelId: "test/model", latencyMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0, serviceTier: null, error: null, httpStatus: 200 };
  },
}));
vi.mock("./executor.js", () => ({ executePlutoClose: vi.fn(), executePlutoOrder: vi.fn(), watchPlutoOrder: vi.fn() }));
vi.mock("./postModelGates.js", () => ({ runPostModelGates: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computePositionExposures: vi.fn() }));

const { runPlutoPass } = await import("./passRunner.js");

function makeContext() {
  return {
    api: {} as never,
    openRouterApiKey: "test",
    marketWatch: {
      snapshot: () => ({ last: 30, bid: 29.9, ask: 30.1 }),
      spyDayChangePct: () => 0.5,
      burst: async (symbol: string) => {
        harness.bursts.push(symbol);
        return [{ expiry: "2026-10-16", strike: 30, right: "C" as const, bid: 1, ask: 1.1, quotedAt: new Date().toISOString() }];
      },
    } as never,
    lastFingerprintBySymbol: new Map<string, string>(),
    lastModelEvaluationAtBySymbol: new Map<string, number>(),
    trackWatch: () => {},
  };
}

const dayRound = { trigger: "day_signals_update" as const, triggerDetail: {}, symbols: ["AAA"], force: false };

beforeEach(() => {
  harness.bursts.length = 0;
  harness.modelCalls = 0;
  harness.eligibleIds = ["AAA:covered_call:2026-10-16:30"];
  harness.requotableIds = [];
  harness.modelAnswer = null;
  harness.blockedGates.length = 0;
  harness.bookError = null;
});

describe("runPlutoPass round order", () => {
  it("bursts once, only when the model is about to be called", async () => {
    const context = makeContext();
    const summary = await runPlutoPass(dayRound, context);
    expect(summary.modelCalled).toBe(true);
    expect(harness.bursts).toEqual(["AAA"]);
    expect(harness.modelCalls).toBe(1);
  });

  it("does not burst when nothing changed since the model last looked", async () => {
    const context = makeContext();
    await runPlutoPass(dayRound, context);
    context.lastModelEvaluationAtBySymbol.set("AAA", Date.now() - 6 * 60_000); // cooldown over
    harness.bursts.length = 0;
    const summary = await runPlutoPass(dayRound, context);
    expect(summary.skippedReason).toBe("no material change since the model last looked");
    expect(harness.bursts).toEqual([]);
  });

  it("skips before any scoring when every ticker is cooling down", async () => {
    const context = makeContext();
    context.lastModelEvaluationAtBySymbol.set("AAA", Date.now() - 60_000);
    const summary = await runPlutoPass(dayRound, context);
    expect(summary.skippedReason).toBe("every ticker in this round is cooling down");
    expect(harness.bursts).toEqual([]);
  });

  it("still considers a contract that is out only on quote age, and bursts to re-quote it", async () => {
    harness.eligibleIds = [];
    harness.requotableIds = ["AAA:covered_call:2026-10-16:32"];
    const context = makeContext();
    const summary = await runPlutoPass(dayRound, context);
    expect(harness.bursts).toEqual(["AAA"]);
    expect(summary.modelCalled).toBe(true);
  });

  it("before the opening look, offers no opens and skips without a burst when nothing is held", async () => {
    harness.requotableIds = ["AAA:covered_call:2026-10-16:32"];
    const summary = await runPlutoPass({ trigger: "settings_changed", triggerDetail: {}, symbols: [], force: true, heldPositionsOnly: true }, makeContext());
    expect(summary.skippedReason).toBe("waiting for today's opening look: no held position to manage");
    expect(harness.bursts).toEqual([]);
    expect(harness.modelCalls).toBe(0);
  });

  it("finishes the pass as failed when the round throws midway, and still throws", async () => {
    const { finishPlutoPass } = await import("./ledger.js");
    vi.mocked(finishPlutoPass).mockClear();
    harness.bookError = "book unavailable";
    await expect(runPlutoPass(dayRound, makeContext())).rejects.toThrow("book unavailable");
    expect(vi.mocked(finishPlutoPass).mock.calls).toEqual([["pass-1", { skippedReason: "round failed: book unavailable" }]]);
  });

  it("never trades a ticker the model flagged in the same answer", async () => {
    harness.modelAnswer = { decision: "trade", action_kind: "open_covered_call", candidate_id: "AAA:covered_call:2026-10-16:30", confidence: 0.9, reasons: ["r"], risks_acknowledged: [], system_concerns: [{ symbol: "AAA", concern: "quote looks stale" }] };
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(summary.outcome).toBe("blocked");
    expect(harness.blockedGates).toEqual(["flagged_ticker"]);
  });
});
