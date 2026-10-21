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
  sizingBooks: [] as unknown[],
  recordedGates: [] as { gate: string; ok: boolean; limit?: string }[],
  filterBlocks: [] as { opens: string | null; newPositions: string | null }[],
  workingOrderSymbols: new Set<string>(),
  openPositionCount: 0,
  closeOffers: [] as Record<string, unknown>[],
  exposures: [] as { positionId: string; strategyKey: string; symbol: string; sector: string; exposure: number }[],
  inFlight: { totalNotional: 0, managedNotional: 0, tickerNotionalBySymbol: new Map<string, number>() },
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
  recordPlutoAction: async (input: { gateResults: { gate: string; ok: boolean; limit?: string }[] }) => {
    harness.recordedGates.push(...input.gateResults);
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
  scoreHeldShareCalls: () => [],
  scoreTicker: (_inputs: unknown, _account: unknown, _settings: unknown, live?: { liveQuotes: unknown[] }) => ({
    symbol: "AAA",
    candidates: [...harness.eligibleIds, ...harness.requotableIds].map((id) => ({ id, expiry: "2026-10-16", strike: Number(id.split(":")[3]), strategyKey: "covered_call", model: { edgeMargin: 0.2, expectedAnnualizedReturn: 0.5, expectedPnlDollars: 20 } })),
    heldLegs: [],
    rolls: [],
    live: live?.liveQuotes.length ?? 0,
  }),
}));
vi.mock("./candidateFilters.js", () => ({
  openCandidateId: (_symbol: string, candidate: { id: string }) => candidate.id,
  filterTickerForPluto: ({ scored, sizingBook, opensBlockedReason, newPositionsBlockedReason }: { scored: { candidates: { id: string }[]; live: number }; sizingBook?: unknown; opensBlockedReason?: string | null; newPositionsBlockedReason?: string | null }) => (harness.sizingBooks.push(sizingBook), harness.filterBlocks.push({ opens: opensBlockedReason ?? null, newPositions: newPositionsBlockedReason ?? null }), {
    symbol: "AAA",
    tickerBlocks: [],
    // A re-quoted candidate becomes eligible once the burst brought live quotes.
    eligible: scored.candidates.filter((candidate) => harness.eligibleIds.includes(candidate.id) || scored.live > 0).map((candidate) => ({ id: candidate.id, kind: "open_covered_call", symbol: "AAA", candidate })),
    eligibleRolls: [],
    rejected: scored.live > 0 ? [] : harness.requotableIds.map((id) => ({ id, reasons: ["quote 14 min old (max 10)"], codes: ["quote_age"] })),
    rejectedRolls: [],
  }),
  summarizeTopPick: () => null,
  findSameContractConflict: () => null,
  rejectOpenCandidate: () => [],
  rejectTicker: () => [],
  rollCandidateId: () => "",
}));
vi.mock("./book.js", () => ({
  loadPlutoBook: async () => {
    if (harness.bookError) throw new Error(harness.bookError);
    return { openPositions: Array.from({ length: harness.openPositionCount }, (_, index) => ({ positionId: `p${index}`, symbol: "ZZZ" })), committedDollars: 0, workingOrderSymbols: harness.workingOrderSymbols, lastFilledActionAtBySymbol: new Map(), plutoOpenedPositionIds: new Set() };
  }, loadOccupiedContracts: async () => [], loadLastFilledPlutoActionAtBySymbol: async () => new Map(), loadInFlightNotionals: async (symbol: string) => ({ totalNotional: harness.inFlight.totalNotional, tickerNotional: harness.inFlight.tickerNotionalBySymbol.get(symbol) ?? 0, managedNotional: harness.inFlight.managedNotional }), loadInFlightNotionalsBySymbol: async () => harness.inFlight, anyOpenPositionOn: async () => false }));
vi.mock("./closeActions.js", () => ({ buildCloseOffersForTicker: async () => ({ offers: harness.closeOffers, skipped: [], heldPositions: [] }) }));
vi.mock("../lib/marketSessionStatus.js", () => ({ previousOpenSessionDate: async () => "2026-10-06", loadOpenDaysBetween: async () => [] }));
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: async () => ({ spreadCostChargedPct: 50 }) }));
vi.mock("./accountSummaryCache.js", () => ({ fetchPlutoAccountSummary: async () => ({}) }));
vi.mock("../lib/ivMetrics.js", () => ({ computeIvMetrics: async () => ({ ivRank: null }) }));
vi.mock("./moveContext.js", () => ({ computeMoveContext: () => null, expectedDailyMovePct: () => null }));
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
vi.mock("./postModelGates.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./postModelGates.js")>()), runPostModelGates: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computePositionExposures: vi.fn(async () => harness.exposures) }));

const { runPlutoPass } = await import("./passRunner.js");
const { runPostModelGates } = await import("./postModelGates.js");

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
    lastHeldShareCallAttemptAtBySymbol: new Map<string, number>(),
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
  harness.sizingBooks.length = 0;
  harness.recordedGates.length = 0;
  harness.filterBlocks.length = 0;
  harness.workingOrderSymbols = new Set();
  harness.openPositionCount = 0;
  harness.closeOffers = [];
  harness.exposures = [];
  harness.inFlight = { totalNotional: 0, managedNotional: 0, tickerNotionalBySymbol: new Map() };
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

  it("sizes the round's opens on the sizing gate's own book: the ticker's exposure and working orders, the account", async () => {
    harness.exposures = [{ positionId: "p1", strategyKey: "cash_secured_put", symbol: "AAA", sector: "Technology", exposure: 12_000 }, { positionId: "p2", strategyKey: "cash_secured_put", symbol: "BBB", sector: "Technology", exposure: 30_000 }];
    harness.inFlight = { totalNotional: 9_000, managedNotional: 6_000, tickerNotionalBySymbol: new Map([["AAA", 2_000], ["BBB", 7_000]]) };
    harness.modelAnswer = { decision: "trade", action_kind: "open_covered_call", candidate_id: "AAA:covered_call:2026-10-16:30", confidence: 0.9, reasons: ["r"], risks_acknowledged: [], system_concerns: [] };
    vi.mocked(runPostModelGates).mockReturnValueOnce({ ok: false, gates: [{ gate: "sizing", ok: true, detail: "2 contracts" }, { gate: "limit_price", ok: false, detail: "outside the market" }], plan: null, sizingLimit: "ticker_room" });
    await runPlutoPass(dayRound, makeContext());
    // AAA has no sector, so no sector room; the fresh re-score after the model's choice is filtered without a book.
    const sizingBook = { sectorKnown: false, book: { netLiquidationValue: 1_000_000, freeCash: 500_000, committedDollars: 0, inFlight: { totalNotional: 9_000, tickerNotional: 2_000, managedNotional: 6_000 }, existingTickerExposure: 12_000, existingSectorExposure: 0 } };
    expect(harness.sizingBooks).toEqual([sizingBook, sizingBook, undefined]);
    // The gate after the model reads the same figures.
    expect(vi.mocked(runPostModelGates).mock.calls.at(-1)![0].book).toMatchObject(sizingBook.book);
    // The action row's sizing gate carries the limit that set the size, for the screen.
    expect(harness.recordedGates).toEqual([{ gate: "sizing", ok: true, detail: "2 contracts", limit: "ticker_room" }, { gate: "limit_price", ok: false, detail: "outside the market" }]);
  });

  it("offers nothing on a ticker with a Pluto order working, closes included: the post-model gates would refuse it", async () => {
    harness.eligibleIds = [];
    harness.closeOffers = [{ id: "AAA:close_leg:leg-1", kind: "close_leg", automatic: false }];
    expect((await runPlutoPass(dayRound, makeContext())).modelCalled).toBe(true);
    expect(harness.filterBlocks[0]).toEqual({ opens: null, newPositions: null });

    harness.modelCalls = 0;
    harness.filterBlocks.length = 0;
    harness.workingOrderSymbols = new Set(["AAA"]);
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(summary.skippedReason).toBe("nothing eligible");
    expect(harness.modelCalls).toBe(0);
    // The filters get the reason for the ticker's opens and rolls.
    expect(harness.filterBlocks[0]).toEqual({ opens: "a Pluto order on this symbol is already working", newPositions: null });
  });

  it("past the open-positions cap the model is offered no open", async () => {
    harness.openPositionCount = 15;
    await runPlutoPass(dayRound, makeContext());
    expect(harness.filterBlocks[0]).toEqual({ opens: null, newPositions: "15 of 15 managed positions: no new position" });
  });

  it("never trades a ticker the model flagged in the same answer", async () => {
    harness.modelAnswer = { decision: "trade", action_kind: "open_covered_call", candidate_id: "AAA:covered_call:2026-10-16:30", confidence: 0.9, reasons: ["r"], risks_acknowledged: [], system_concerns: [{ symbol: "AAA", concern: "quote looks stale" }] };
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(summary.outcome).toBe("blocked");
    expect(harness.blockedGates).toEqual(["flagged_ticker"]);
  });
});
