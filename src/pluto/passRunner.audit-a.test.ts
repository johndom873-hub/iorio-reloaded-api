import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): runPlutoPass round lifecycle. Everything outside the round's own logic is mocked; tickers, close
// offers, market stress, system checks and ledger failures are driven per test through `harness`.

interface HarnessTicker {
  symbol: string;
  tickerId: string;
  eligibleIds: string[];
  requotableIds: string[];
  closeOffers: Record<string, unknown>[];
}

const harness = vi.hoisted(() => ({
  tickers: [] as HarnessTicker[],
  bursts: [] as { symbol: string; contracts: unknown[] }[],
  modelCalls: 0,
  spyDayChangePct: 0.5 as number | null,
  systemChecksOk: true,
  finishFailuresLeft: 0,
  failNoTradeAction: false,
  accountContextCalls: [] as (number | null)[],
  executedCloses: [] as string[],
  throwOnBook: null as unknown,
  lastFilledActionAtBySymbol: new Map<string, Date>(),
}));

vi.mock("../db/connection.js", () => {
  const rowsFor = (table: string) => (table.startsWith("shortlist_entries") ? harness.tickers.map((ticker) => ({ ticker_id: ticker.tickerId })) : []);
  const chain = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["whereNull", "where", "whereNot", "whereNotNull", "whereIn", "orderBy", "limit"]) query[method] = () => query;
    query.select = async () => rowsFor(table);
    return query;
  };
  return { db: Object.assign((table: string) => chain(table), { raw: () => "" }) };
});
vi.mock("./settingsStore.js", () => ({
  loadPlutoSettings: async () => ({ perTickerModelCooldownMinutes: 5, tickerCooldownMinutes: 60, burstLines: 10, spyStressBreakerPct: 3, modelId: "test/model", reasoningEffort: "low", callTimeoutSeconds: 10, promptVersion: "test", confidenceFloor: 0.6, telegramVerbosity: "off", maxOpenPositions: 15, maxActionsPerSession: 10, capitalBudgetPct: 50 }),
}));
vi.mock("./ledger.js", () => ({
  startPlutoPass: vi.fn(async () => "pass-1"),
  finishPlutoPass: vi.fn(async () => {
    if (harness.finishFailuresLeft > 0) {
      harness.finishFailuresLeft -= 1;
      throw new Error("finish write failed");
    }
  }),
  recordPlutoEvent: vi.fn(async () => {}),
  relabelPlutoPass: vi.fn(),
  recordPlutoAction: vi.fn(async (input: { kind: string }) => {
    if (harness.failNoTradeAction && input.kind === "no_trade") throw new Error("action insert failed");
    return "action-1";
  }),
  recordPlutoDecision: vi.fn(),
}));
vi.mock("./stateStore.js", () => ({ loadPlutoState: async () => ({ breakers: {} }), recordPlutoPass: vi.fn(), tripPlutoBreaker: vi.fn() }));
vi.mock("./systemChecks.js", () => ({
  runPlutoSystemChecks: async () => ({
    ok: harness.systemChecksOk,
    failures: harness.systemChecksOk ? [] : ["account_data: account summary failed: timeout"],
    checks: harness.systemChecksOk ? {} : { account_data: { ok: false, detail: "account summary failed: timeout" } },
    context: { state: { stressOverrideDate: null }, todayEasternIso: "2026-10-07", session: { cancelByMs: 0, windowEndEt: "15:30" }, netLiquidationValue: 1_000_000, totalCashValue: 400_000, counters: { actionsToday: 0 } },
  }),
}));
vi.mock("../lib/signalsStore.js", () => ({
  loadSignalsUniverseTickers: async () => harness.tickers.map((ticker) => ({ tickerId: ticker.tickerId, symbol: ticker.symbol, companyName: null, sector: null })),
  loadTickerSignalsInputs: async (row: { symbol: string }) => ({ slices: [], todayEasternIso: "2026-10-07", symbol: row.symbol }),
  accountContextFromTotalCash: async (totalCashValue: number | null) => {
    harness.accountContextCalls.push(totalCashValue);
    return { freeCash: 500_000 };
  },
  loadBarsForTilt: async () => [],
}));
vi.mock("../lib/signalsLiveScoring.js", () => ({
  scoreTicker: (inputs: { symbol: string }, _account: unknown, _settings: unknown, live?: { liveQuotes: unknown[] }) => {
    const ticker = harness.tickers.find((entry) => entry.symbol === inputs.symbol)!;
    return {
      symbol: inputs.symbol,
      candidates: [...ticker.eligibleIds, ...ticker.requotableIds].map((id) => ({ id, expiry: "2026-10-16", strike: Number(id.split(":")[3]), strategyKey: "covered_call", edgeDollars: 10, netEdge: 0.05, grade: "good" })),
      heldLegs: [],
      rolls: [],
      live: live?.liveQuotes.length ?? 0,
    };
  },
}));
vi.mock("./candidateFilters.js", () => ({
  openCandidateId: (_symbol: string, candidate: { id: string }) => candidate.id,
  filterTickerForPluto: ({ scored, opensBlockedReason }: { scored: { symbol: string; candidates: { id: string }[]; live: number }; opensBlockedReason?: string | null }) => {
    const ticker = harness.tickers.find((entry) => entry.symbol === scored.symbol)!;
    if (opensBlockedReason) return { symbol: scored.symbol, tickerBlocks: [], eligible: [], eligibleRolls: [], rejected: scored.candidates.map((candidate) => ({ id: candidate.id, reasons: [opensBlockedReason] })) };
    return {
      symbol: scored.symbol,
      tickerBlocks: [],
      eligible: scored.candidates.filter((candidate) => ticker.eligibleIds.includes(candidate.id) || scored.live > 0).map((candidate) => ({ id: candidate.id, kind: "open_covered_call", symbol: scored.symbol, candidate })),
      eligibleRolls: [],
      rejected: scored.live > 0 ? [] : ticker.requotableIds.map((id) => ({ id, reasons: ["quote 14 min old (live), max 10"] })),
    };
  },
  deterministicTopPick: () => null,
  findSameContractConflict: () => null,
  rejectOpenCandidate: () => [],
  rejectTicker: () => [],
  rollCandidateId: () => "",
}));
vi.mock("./book.js", () => ({
  loadPlutoBook: async () => {
    if (harness.throwOnBook !== null) throw harness.throwOnBook;
    return { openPositions: [], committedDollars: 0, workingOrderSymbols: new Set(), lastFilledActionAtBySymbol: new Map(), plutoOpenedPositionIds: [] };
  },
  loadOccupiedContracts: async () => [],
  loadLastFilledPlutoActionAtBySymbol: async () => harness.lastFilledActionAtBySymbol,
  loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }),
  // A ticker holding something to close stands for one with an open position.
  anyOpenPositionOn: async (symbols: string[]) => harness.tickers.some((entry) => symbols.includes(entry.symbol) && entry.closeOffers.length > 0),
}));
vi.mock("./closeActions.js", () => ({
  buildCloseOffersForTicker: async ({ symbol }: { symbol: string }) => ({ offers: harness.tickers.find((entry) => entry.symbol === symbol)?.closeOffers ?? [], skipped: [] }),
}));
vi.mock("../lib/marketSessionStatus.js", () => ({ previousOpenSessionDate: async () => "2026-10-06" }));
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: async () => ({ spreadCostChargedPct: 50 }) }));
vi.mock("./accountSummaryCache.js", () => ({ fetchPlutoAccountSummary: async () => ({}) }));
vi.mock("../lib/ivMetrics.js", () => ({ computeIvMetrics: async () => ({ ivRank: null }) }));
vi.mock("./moveContext.js", () => ({ computeMoveContext: () => null }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn(), notifyTelegram: vi.fn() }));
vi.mock("./concernAlerts.js", () => ({ updatePlutoConcernAlerts: vi.fn(async () => {}) }));
vi.mock("./prompts.js", () => ({ ensurePlutoPrompt: async () => "prompt-1" }));
vi.mock("./prompt.js", () => ({ buildPlutoSystemPrompt: () => "system", buildPlutoUserPayload: () => ({ payload: {}, offeredIds: new Set<string>() }), plutoPromptVersion: "test", recentDecisionsForPrompt: () => [] }));
vi.mock("./modelClient.js", () => ({
  callPlutoModel: async () => {
    harness.modelCalls += 1;
    return { ok: true, rawText: JSON.stringify({ decision: "no_trade", action_kind: null, candidate_id: null, confidence: 0.9, reasons: ["nothing worth it"], risks_acknowledged: [], system_concerns: [] }), servedModelId: "test/model", latencyMs: 1, tokensIn: 1, tokensOut: 1, costUsd: 0.01, serviceTier: null, error: null, httpStatus: 200 };
  },
}));
vi.mock("./executor.js", () => ({
  executePlutoClose: vi.fn(async (_api: unknown, _settings: unknown, input: { symbol: string }) => {
    harness.executedCloses.push(input.symbol);
    return { outcome: "confirmed", orderId: null };
  }),
  executePlutoOrder: vi.fn(),
  watchPlutoOrder: vi.fn(),
}));
vi.mock("./postModelGates.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("./postModelGates.js")>()), runPostModelGates: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computePositionExposures: vi.fn() }));

const { runPlutoPass } = await import("./passRunner.js");
const ledger = await import("./ledger.js");

const openId = (symbol: string, strike: number) => `${symbol}:covered_call:2026-10-16:${strike}`;

function closeOffer(symbol: string, automatic: boolean): Record<string, unknown> {
  return { id: `${symbol}:close_leg:pos-1`, kind: "close_leg", symbol, positionId: "pos-1", legIds: ["leg-1"], automatic, automaticReason: automatic ? "earnings buyback (Formula P3)" : null, limitPrice: 0.5, side: "buy", multiplier: 100, quantity: 1, description: "buy back", detail: {} };
}

function ticker(symbol: string, overrides: Partial<HarnessTicker> = {}): HarnessTicker {
  return { symbol, tickerId: `t-${symbol.toLowerCase()}`, eligibleIds: [openId(symbol, 30)], requotableIds: [], closeOffers: [], ...overrides };
}

function makeContext() {
  return {
    api: {} as never,
    openRouterApiKey: "test",
    marketWatch: {
      snapshot: () => ({ last: 30, bid: 29.9, ask: 30.1 }),
      spyDayChangePct: () => harness.spyDayChangePct,
      burst: async (symbol: string, contracts: unknown[]) => {
        harness.bursts.push({ symbol, contracts });
        return [{ expiry: "2026-10-16", strike: 30, right: "C" as const, bid: 1, ask: 1.1, quotedAt: new Date().toISOString() }];
      },
    } as never,
    lastFingerprintBySymbol: new Map<string, string>(),
    lastModelEvaluationAtBySymbol: new Map<string, number>(),
    trackWatch: () => {},
  };
}

const dayRound = (symbols: string[]) => ({ trigger: "day_signals_update" as const, triggerDetail: {}, symbols, force: false });

beforeEach(() => {
  harness.tickers = [ticker("AAA")];
  harness.bursts.length = 0;
  harness.modelCalls = 0;
  harness.spyDayChangePct = 0.5;
  harness.systemChecksOk = true;
  harness.finishFailuresLeft = 0;
  harness.failNoTradeAction = false;
  harness.accountContextCalls.length = 0;
  harness.executedCloses.length = 0;
  harness.throwOnBook = null;
  harness.lastFilledActionAtBySymbol = new Map();
  vi.mocked(ledger.finishPlutoPass).mockClear();
  vi.mocked(ledger.startPlutoPass).mockClear();
});

describe("runPlutoPass: failure handling (audit A)", () => {
  it("BUG: a pass whose own finish write failed is still closed as 'round failed' (passFinished is set before the write succeeds)", async () => {
    // The system-check skip path: finishPass throws once (DB blip). The pass row is NOT finished, so the catch should close it.
    harness.systemChecksOk = false;
    harness.finishFailuresLeft = 1;
    await expect(runPlutoPass(dayRound(["AAA"]), makeContext())).rejects.toThrow("finish write failed");
    const calls = vi.mocked(ledger.finishPlutoPass).mock.calls;
    expect(calls.at(-1)).toEqual(["pass-1", { skippedReason: "round failed: finish write failed" }]);
  });

  it("a failure after the model call keeps the model-call record (no 'round failed' overwrite) and still throws", async () => {
    harness.failNoTradeAction = true;
    await expect(runPlutoPass(dayRound(["AAA"]), makeContext())).rejects.toThrow("action insert failed");
    const calls = vi.mocked(ledger.finishPlutoPass).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ modelCalled: true, costUsd: 0.01 });
    expect(harness.modelCalls).toBe(1);
  });

  it("a no-order answer writes its action row first, then one model_called event carrying the concerns and the top pick (no no_trade event)", async () => {
    vi.mocked(ledger.recordPlutoEvent).mockClear();
    vi.mocked(ledger.recordPlutoAction).mockClear();
    await runPlutoPass(dayRound(["AAA"]), makeContext());
    const eventTypes = vi.mocked(ledger.recordPlutoEvent).mock.calls.map((call) => call[0]);
    expect(eventTypes).not.toContain("no_trade");
    const modelCalledIndex = eventTypes.indexOf("model_called");
    expect(eventTypes.filter((type) => type === "model_called")).toHaveLength(1);
    const payload = vi.mocked(ledger.recordPlutoEvent).mock.calls[modelCalledIndex]![1];
    expect(payload).toMatchObject({ verdict: "no_trade", systemConcerns: [] });
    expect(payload).toHaveProperty("deterministicTopPick");
    const actionOrder = vi.mocked(ledger.recordPlutoAction).mock.invocationCallOrder.at(-1)!;
    expect(vi.mocked(ledger.recordPlutoEvent).mock.invocationCallOrder[modelCalledIndex]!).toBeGreaterThan(actionOrder);
  });

  it("records a non-Error throw as its string", async () => {
    harness.throwOnBook = "plain string failure";
    await expect(runPlutoPass(dayRound(["AAA"]), makeContext())).rejects.toBe("plain string failure");
    expect(vi.mocked(ledger.finishPlutoPass).mock.calls.at(-1)).toEqual(["pass-1", { skippedReason: "round failed: plain string failure" }]);
  });

  it("a failing startPlutoPass leaves nothing to finish", async () => {
    vi.mocked(ledger.startPlutoPass).mockRejectedValueOnce(new Error("insert failed"));
    await expect(runPlutoPass(dayRound(["AAA"]), makeContext())).rejects.toThrow("insert failed");
    expect(vi.mocked(ledger.finishPlutoPass)).not.toHaveBeenCalled();
  });
});

describe("runPlutoPass: account read once per round (audit A)", () => {
  it("derives free cash from the system checks' totalCashValue, only once the checks pass", async () => {
    await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(harness.accountContextCalls).toEqual([400_000]);
    harness.accountContextCalls.length = 0;
    harness.systemChecksOk = false;
    await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(harness.accountContextCalls).toEqual([]);
  });
});

describe("runPlutoPass: cooldown early skip (audit A)", () => {
  it("does not apply to forced rounds", async () => {
    const context = makeContext();
    context.lastModelEvaluationAtBySymbol.set("AAA", Date.now() - 60_000);
    const summary = await runPlutoPass({ trigger: "order_ended", triggerDetail: {}, symbols: [], force: true }, context);
    expect(summary.modelCalled).toBe(true);
  });

  it("an unknown/disabled symbol skips as 'no enabled tickers', never as 'cooling down' (every() on an empty list)", async () => {
    const context = makeContext();
    const summary = await runPlutoPass(dayRound(["ZZZ"]), context);
    expect(summary.skippedReason).toBe("no enabled tickers to evaluate");
  });

  it("does not skip when only some tickers are cooling down", async () => {
    harness.tickers = [ticker("AAA"), ticker("BBB")];
    const context = makeContext();
    context.lastModelEvaluationAtBySymbol.set("AAA", Date.now() - 60_000);
    const summary = await runPlutoPass(dayRound(["AAA", "BBB"]), context);
    expect(summary.modelCalled).toBe(true);
  });

  it("REGRESSION: a Day Signals round where every ticker is cooling down still executes automatic closes (it did before 2026-10-07)", async () => {
    harness.tickers = [ticker("AAA", { closeOffers: [closeOffer("AAA", true)] })];
    const context = makeContext();
    context.lastModelEvaluationAtBySymbol.set("AAA", Date.now() - 60_000);
    const summary = await runPlutoPass(dayRound(["AAA"]), context);
    // A ticker with an open position is not skipped on its model cooldown: its automatic closes (odd lot P1, earnings buyback P3) run.
    expect(summary.skippedReason).not.toBe("every ticker in this round is cooling down");
    expect(harness.executedCloses).toEqual(["AAA"]);
  });
});

describe("runPlutoPass: ticker cooldown before the model (2026-10-08)", () => {
  it("a ticker whose last filled Pluto action is inside the cooldown offers no opens: no burst, no model call", async () => {
    harness.lastFilledActionAtBySymbol = new Map([["AAA", new Date(Date.now() - 20 * 60_000)]]);
    harness.tickers = [ticker("AAA", { requotableIds: [openId("AAA", 32)] })];
    const summary = await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(summary.skippedReason).toBe("nothing eligible");
    expect(harness.bursts).toEqual([]);
    expect(harness.modelCalls).toBe(0);
  });

  it("offers the ticker's opens again once the cooldown is over", async () => {
    harness.lastFilledActionAtBySymbol = new Map([["AAA", new Date(Date.now() - 61 * 60_000)]]);
    const summary = await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(summary.modelCalled).toBe(true);
  });

  it("still offers the cooling-down ticker's closes", async () => {
    harness.lastFilledActionAtBySymbol = new Map([["AAA", new Date(Date.now() - 20 * 60_000)]]);
    harness.tickers = [ticker("AAA", { closeOffers: [closeOffer("AAA", false)] })];
    const summary = await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(summary.modelCalled).toBe(true);
    expect(vi.mocked(ledger.finishPlutoPass).mock.calls.at(-1)![1]).toMatchObject({ candidateCount: 1 });
  });
});

describe("runPlutoPass: opens blocked (heldPositionsOnly / market stress) (audit A)", () => {
  it("before the opening look, offers held-position closes to the model and blocks opens", async () => {
    harness.tickers = [ticker("AAA", { closeOffers: [closeOffer("AAA", false)] })];
    const context = makeContext();
    const summary = await runPlutoPass({ trigger: "settings_changed", triggerDetail: {}, symbols: [], force: true, heldPositionsOnly: true }, context);
    expect(summary.modelCalled).toBe(true);
    expect(vi.mocked(ledger.finishPlutoPass).mock.calls.at(-1)![1]).toMatchObject({ candidateCount: 1 });
  });

  it("BUG: before the opening look, open contracts out only on quote age are still burst although no open can be offered", async () => {
    harness.tickers = [ticker("AAA", { eligibleIds: [], requotableIds: [openId("AAA", 32)], closeOffers: [closeOffer("AAA", false)] })];
    const summary = await runPlutoPass({ trigger: "settings_changed", triggerDetail: {}, symbols: [], force: true, heldPositionsOnly: true }, makeContext());
    expect(summary.modelCalled).toBe(true);
    expect(harness.bursts).toEqual([]);
  });

  it("BUG: under market stress, open contracts out only on quote age are still burst although opens are blocked", async () => {
    harness.spyDayChangePct = -4;
    harness.tickers = [ticker("AAA", { eligibleIds: [], requotableIds: [openId("AAA", 32)], closeOffers: [closeOffer("AAA", false)] })];
    const summary = await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(summary.modelCalled).toBe(true);
    expect(harness.bursts).toEqual([]);
  });

  it("under market stress with only open candidates, skips as nothing eligible without a burst", async () => {
    harness.spyDayChangePct = -4;
    harness.tickers = [ticker("AAA", { requotableIds: [openId("AAA", 32)] })];
    const summary = await runPlutoPass(dayRound(["AAA"]), makeContext());
    expect(summary.skippedReason).toBe("nothing eligible");
    expect(harness.bursts).toEqual([]);
    expect(harness.modelCalls).toBe(0);
  });
});

describe("runPlutoPass: fingerprints across rounds (audit A)", () => {
  it("a candidate that stays out after the live re-quote is not re-burst on the next unchanged round", async () => {
    // The re-quote yields nothing eligible: the burst mock returns quotes, but this ticker's filter keeps nothing eligible.
    harness.tickers = [ticker("AAA", { eligibleIds: [], requotableIds: [openId("AAA", 32)] })];
    const context = makeContext();
    const burstToNothing = { ...(context.marketWatch as object), burst: async (symbol: string, contracts: unknown[]) => { harness.bursts.push({ symbol, contracts }); return []; } };
    const quietContext = { ...context, marketWatch: burstToNothing as never };
    const first = await runPlutoPass(dayRound(["AAA"]), quietContext);
    expect(first.skippedReason).toBe("nothing eligible");
    expect(harness.bursts).toHaveLength(1);
    const second = await runPlutoPass(dayRound(["AAA"]), quietContext);
    expect(second.skippedReason).toBe("no material change since the model last looked");
    expect(harness.bursts).toHaveLength(1);
  });

  it("the model-call round stores the pre-burst fingerprint and the evaluation time for every ticker in the round", async () => {
    harness.tickers = [ticker("AAA"), ticker("BBB")];
    const context = makeContext();
    const before = Date.now();
    await runPlutoPass(dayRound(["AAA", "BBB"]), context);
    expect([...context.lastFingerprintBySymbol.keys()].sort()).toEqual(["AAA", "BBB"]);
    expect(context.lastModelEvaluationAtBySymbol.get("BBB")).toBeGreaterThanOrEqual(before);
  });
});
