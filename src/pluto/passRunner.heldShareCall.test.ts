import { beforeEach, describe, expect, it, vi } from "vitest";

// The call code sells on free shares (Marcelo, 2026-10-12): sent from the round before any model call, re-quoted live first,
// at most one try per ticker per perTickerModelCooldownMinutes. Everything the round touches outside its own logic is mocked;
// the held-share gates are the real ones.

const harness = vi.hoisted(() => ({
  bursts: [] as { symbol: string; contracts: unknown[] }[],
  burstReturnsQuotes: true,
  modelCalls: 0,
  actions: [] as { kind: string; outcome: string; quantity: number | null; limitPrice: number | null; gateResults: { gate: string; ok: boolean; detail: string }[] }[],
  orders: [] as { kind: string; plan: { quantity: number; limitPrice: number }; reasons: string[] }[],
  unfilledWithinTheHour: false,
  workingOrderSymbols: new Set<string>(),
}));

vi.mock("../db/connection.js", () => {
  const rowsFor = (table: string) => (table.startsWith("shortlist_entries") ? [{ ticker_id: "t-aaa" }] : []);
  const chain = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["whereNull", "where", "whereNot", "whereNotNull", "whereIn", "whereRaw", "orderBy", "limit", "orWhere"]) query[method] = () => query;
    query.select = async () => rowsFor(table);
    query.first = async () => (table === "pluto_actions" && harness.unfilledWithinTheHour ? { id: "earlier-try" } : undefined);
    return query;
  };
  return { db: Object.assign((table: string) => chain(table), { raw: () => "" }) };
});
vi.mock("./settingsStore.js", () => ({
  loadPlutoSettings: async () => ({ perTickerModelCooldownMinutes: 5, burstLines: 10, spyStressBreakerPct: 3, modelId: "test/model", reasoningEffort: "low", callTimeoutSeconds: 10, promptVersion: "test", confidenceFloor: 0.6, telegramVerbosity: "off", maxOpenPositions: 15, maxActionsPerSession: 10, capitalBudgetPct: 50, tickerCooldownMinutes: 60, unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50 }),
}));
vi.mock("./ledger.js", () => ({
  startPlutoPass: async () => "pass-1",
  finishPlutoPass: vi.fn(),
  recordPlutoEvent: vi.fn(),
  relabelPlutoPass: vi.fn(),
  recordPlutoAction: async (input: (typeof harness.actions)[number]) => {
    harness.actions.push(input);
    return "action-1";
  },
  updatePlutoAction: vi.fn(),
  recordPlutoDecision: vi.fn(),
}));
vi.mock("./stateStore.js", () => ({ loadPlutoState: async () => ({ breakers: {} }), recordPlutoPass: vi.fn(), tripPlutoBreaker: vi.fn() }));
vi.mock("./systemChecks.js", () => ({
  runPlutoSystemChecks: async () => ({ ok: true, failures: [], checks: {}, context: { state: { stressOverrideDate: null }, todayEasternIso: "2026-10-12", session: { cancelByMs: 0, windowEndEt: "15:30" }, netLiquidationValue: 1_000_000, counters: { actionsToday: 0 } } }),
}));
vi.mock("../lib/signalsStore.js", () => ({
  loadSignalsUniverseTickers: async () => [{ tickerId: "t-aaa", symbol: "AAA", companyName: null, sector: null }],
  loadTickerSignalsInputs: async () => ({ slices: [], todayEasternIso: "2026-10-12" }),
  accountContextFromTotalCash: async () => ({ freeCash: 500_000 }),
  loadBarsForTilt: async () => [],
}));
/** A $115 call on 300 held shares: snapshot-quoted before a burst, live after one. */
function call(live: boolean) {
  return { strategyKey: "covered_call", expiry: "2026-10-30", strike: 115, dte: 18, bid: 2.16, ask: 2.21, commissionPerContractDollars: 0.68, quoteSource: live ? "live" : "snapshot" };
}
vi.mock("../lib/signalsLiveScoring.js", () => ({
  scoreHeldShareCalls: () => [],
  scoreTicker: (_inputs: unknown, _account: unknown, _settings: unknown, live?: { liveQuotes: unknown[] }) => ({ symbol: "AAA", candidates: [], heldLegs: [], rolls: [], freeShares: 300, macroEvents: [], live: live?.liveQuotes.length ?? 0 }),
}));
vi.mock("../lib/cycleBreakEvenQueries.js", () => ({
  // 300 shares at $113.90 break-even: the $115 strike clears it, and (115 − (113.90 − 2.1782)) × 300 = $983 the $345 floor.
  fetchOpenCycleSummaryByTickerId: async () => new Map([["t-aaa", { breakEvenPerShare: 113.9, unavailableReason: null, sharesAcquired: 300, acquisitionCost: 34_500 }]]),
}));
vi.mock("./candidateFilters.js", () => ({
  openCandidateId: (_symbol: string, candidate: { id: string }) => candidate.id,
  filterTickerForPluto: ({ scored }: { scored: { live: number } }) => {
    const choice = (live: boolean) => ({ id: "AAA:covered_call:2026-10-30:115", candidate: call(live), contracts: 3, premiumYield: 0.44, breakEvenAfter: 111.72, profitIfCalledAway: 983 });
    const live = scored.live > 0;
    return {
      symbol: "AAA",
      tickerBlocks: [],
      heldShareCall: { chosen: live ? choice(true) : null, ranked: live ? [choice(true)] : [], rankedIgnoringQuoteAge: [choice(live)], rejected: [] },
      eligible: [],
      eligibleRolls: [],
      rejected: [],
      rejectedRolls: [],
    };
  },
  summarizeTopPick: () => null,
  findSameContractConflict: () => null,
  rejectOpenCandidate: () => [],
  rejectTicker: () => [],
  rollCandidateId: () => "",
  describeCandidateId: (id: string) => id,
}));
vi.mock("./book.js", () => ({
  loadPlutoBook: async () => ({ openPositions: [], committedDollars: 0, workingOrderSymbols: harness.workingOrderSymbols, lastFilledActionAtBySymbol: new Map() }),
  loadOccupiedContracts: async () => [],
  loadLastFilledPlutoActionAtBySymbol: async () => new Map(),
  loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }),
  anyOpenPositionOn: async () => true,
}));
vi.mock("./closeActions.js", () => ({ buildCloseOffersForTicker: async () => ({ offers: [], skipped: [], heldPositions: [] }) }));
vi.mock("../lib/marketSessionStatus.js", () => ({ previousOpenSessionDate: async () => "2026-10-09", loadOpenDaysBetween: async () => [] }));
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: async () => ({ spreadCostChargedPct: 50 }) }));
vi.mock("./accountSummaryCache.js", () => ({ fetchPlutoAccountSummary: async () => ({}) }));
vi.mock("../lib/ivMetrics.js", () => ({ computeIvMetrics: async () => ({ ivRank: null }) }));
vi.mock("./moveContext.js", () => ({ computeMoveContext: () => null }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn() }));
vi.mock("./prompts.js", () => ({ ensurePlutoPrompt: async () => "prompt-1" }));
vi.mock("./prompt.js", () => ({ buildPlutoSystemPrompt: () => "system", buildPlutoUserPayload: () => ({ payload: {}, offeredIds: new Set<string>() }), plutoPromptVersion: "test", recentDecisionsForPrompt: () => [] }));
vi.mock("./modelClient.js", () => ({
  callPlutoModel: async () => {
    harness.modelCalls += 1;
    return { ok: false, rawText: null, servedModelId: null, latencyMs: 1, tokensIn: 0, tokensOut: 0, costUsd: 0, serviceTier: null, error: "not expected", httpStatus: 500 };
  },
}));
vi.mock("./executor.js", () => ({
  executePlutoClose: vi.fn(),
  executePlutoOrder: async (_api: unknown, _settings: unknown, input: (typeof harness.orders)[number]) => {
    harness.orders.push(input);
    return { outcome: "confirmed", orderId: "order-1", detail: "AAA Sell $115 Call" };
  },
  watchPlutoOrder: async () => undefined,
}));
vi.mock("../lib/positionExposure.js", () => ({ computePositionExposures: vi.fn() }));

const { runPlutoPass } = await import("./passRunner.js");

function makeContext() {
  return {
    api: {} as never,
    openRouterApiKey: "test",
    marketWatch: {
      snapshot: () => ({ last: 101.84, bid: 101.8, ask: 101.9 }),
      spyDayChangePct: () => 0.2,
      burst: async (symbol: string, contracts: unknown[]) => {
        harness.bursts.push({ symbol, contracts });
        return harness.burstReturnsQuotes ? [{ expiry: "2026-10-30", strike: 115, right: "C" as const, bid: 2.16, ask: 2.21, quotedAt: new Date().toISOString() }] : [];
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
  harness.burstReturnsQuotes = true;
  harness.modelCalls = 0;
  harness.actions.length = 0;
  harness.orders.length = 0;
  harness.unfilledWithinTheHour = false;
  harness.workingOrderSymbols = new Set();
});

describe("the call code sells on held shares", () => {
  it("re-quotes the ranked calls, sends the best live one on every free round lot at the mid, and asks the model nothing", async () => {
    const summary = await runPlutoPass(dayRound, makeContext());
    expect(harness.bursts).toEqual([{ symbol: "AAA", contracts: [{ expiry: "2026-10-30", strike: 115, right: "C" }] }]);
    expect(harness.orders).toHaveLength(1);
    expect(harness.orders[0]).toMatchObject({ kind: "open", plan: { quantity: 3, limitPrice: 2.19, notional: 0, fullSizeQuantity: 3 } });
    expect(harness.orders[0]!.reasons[0]).toBe("Code sells calls on held shares: the highest premium yield on the 300 held shares: 44% a year; if called away the cycle ends $983 (break-even 111.72 after this premium).");
    const action = harness.actions[0]!;
    expect(action).toMatchObject({ kind: "open_covered_call", outcome: "validated", quantity: 3, limitPrice: 2.19 });
    expect(action.gateResults.map((gate) => [gate.gate, gate.ok])).toEqual([
      ["automatic_held_share_call", true],
      ["live_quote", true],
      ["working_order", true],
      ["ticker_cooldown", true],
      ["same_contract", true],
      ["sizing", true],
      ["break_even", true],
      ["limit_price", true],
    ]);
    expect(harness.modelCalls).toBe(0);
    expect(summary.modelCalled).toBe(false);
  });

  it("tries a ticker at most once per per-ticker cooldown", async () => {
    const context = makeContext();
    await runPlutoPass(dayRound, context);
    await runPlutoPass(dayRound, context);
    expect(harness.bursts).toHaveLength(1);
    context.lastHeldShareCallAttemptAtBySymbol.set("AAA", Date.now() - 6 * 60_000);
    await runPlutoPass(dayRound, context);
    expect(harness.bursts).toHaveLength(2);
  });

  it("waits an hour after a try that reached the route and did not fill, and sends nothing while an order is working", async () => {
    harness.unfilledWithinTheHour = true;
    await runPlutoPass(dayRound, makeContext());
    harness.unfilledWithinTheHour = false;
    harness.workingOrderSymbols = new Set(["AAA"]);
    await runPlutoPass(dayRound, makeContext());
    expect(harness.bursts).toEqual([]);
    expect(harness.orders).toEqual([]);
  });

  it("sends nothing before today's opening look", async () => {
    await runPlutoPass({ ...dayRound, heldPositionsOnly: true }, makeContext());
    expect(harness.bursts).toEqual([]);
    expect(harness.orders).toEqual([]);
  });

  it("records a blocked try, and sends no order, when no call is left on live quotes", async () => {
    harness.burstReturnsQuotes = false;
    await runPlutoPass(dayRound, makeContext());
    expect(harness.orders).toEqual([]);
    expect(harness.actions).toHaveLength(1);
    expect(harness.actions[0]).toMatchObject({ kind: "open_covered_call", outcome: "blocked", quantity: null });
    expect(harness.actions[0]!.gateResults.map((gate) => [gate.gate, gate.ok])).toEqual([
      ["automatic_held_share_call", true],
      ["candidate_present", false],
    ]);
  });
});
