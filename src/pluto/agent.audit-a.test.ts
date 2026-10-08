import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): the PlutoAgent loop (opening look, held-positions-only rounds, forced-round retry, failure alert),
// driven through its private housekeeping()/loopIteration() with every import mocked. Wall clock is faked (2026-10-07 is EDT).

const harness = vi.hoisted(() => ({
  seedFinished: false,
  passRequests: [] as Record<string, unknown>[],
  /** One entry per runPlutoPass call: an Error throws, a string is the skipped reason, null a model-call round. */
  passScript: [] as (Error | string | null)[],
  events: [] as { type: string; payload: Record<string, unknown> }[],
  telegrams: [] as string[],
  watchOk: true,
  insideWindow: true,
  connected: true,
  quoteStamps: [] as { symbol: string; expiry: string; strike: number; right: string; quotedAtMs: number }[],
}));

vi.mock("../db/connection.js", () => {
  const chain = () => {
    const query: Record<string, unknown> = {};
    for (const method of ["join", "whereNull", "where", "whereNot", "whereNotNull", "whereIn", "whereRaw", "orderBy", "limit", "insert", "onConflict"]) query[method] = () => query;
    query.select = async () => [{ symbol: "AAA" }];
    query.pluck = async () => [];
    query.merge = async () => {};
    query.count = () => ({ then: (resolve: (rows: { count: string }[]) => unknown) => resolve([{ count: "0" }]) });
    return query;
  };
  return { db: Object.assign(() => chain(), { raw: () => "", fn: { now: () => "now()" } }) };
});
vi.mock("../ibkr/marketDataPool.js", () => ({ marketDataPoolSnapshot: () => ({ contractCount: 0 }) }));
vi.mock("../ibkr/sharedReadConnection.js", () => {
  const connection = { setLabel: () => {}, setBorrowTimeoutMs: () => {}, getHealthSnapshot: () => ({ connected: harness.connected, totalReconnects: 0 }), listenerCount: () => 0 };
  return { sharedLiveConnection: connection, sharedReadConnection: connection };
});
vi.mock("../lib/processMemoryMonitor.js", () => ({ startProcessMemoryMonitor: () => () => {} }));
vi.mock("../lib/appEnvironment.js", () => ({ readAppEnvironment: () => "test" }));
vi.mock("../lib/internalApiClient.js", () => ({ InternalApiClient: class {} }));
vi.mock("../lib/notificationBroadcaster.js", () => ({ startNotificationBroadcaster: () => {}, subscribeToNotifications: () => () => {} }));
vi.mock("../lib/marketSessionStatus.js", () => ({ computeMarketSessionStatus: async () => ({ state: "open" }), resolveIsOpenDay: async () => true }));
vi.mock("../lib/notifyTelegram.js", () => ({
  notifyPlutoTelegram: vi.fn(async (message: string) => {
    harness.telegrams.push(message);
    return true;
  }),
  notifyTelegram: vi.fn(async () => true),
}));
vi.mock("../lib/readGitSha.js", () => ({ readGitSha: () => "abc1234" }));
vi.mock("./candidateOutcomes.js", () => ({ labelExpiredCandidateOutcomes: async () => ({ labelled: 0, pending: 0, missingBars: [] }) }));
vi.mock("./executor.js", () => ({ loadWorkingPlutoOrders: async () => [], watchPlutoOrder: vi.fn() }));
vi.mock("./ledger.js", () => ({
  closeAbandonedPlutoPasses: vi.fn(async () => 0),
  recordPlutoEvent: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    harness.events.push({ type, payload });
  }),
}));
vi.mock("./marketWatch.js", () => ({
  PlutoMarketWatch: class {
    updateSettings() {}
    async watch() {
      return { ok: harness.watchOk, detail: "" };
    }
    async stop() {}
  },
}));
vi.mock("./passRunner.js", () => ({
  PlutoRoundFailedAfterModelCallError: class PlutoRoundFailedAfterModelCallError extends Error {},
  runPlutoPass: vi.fn(async (request: Record<string, unknown>) => {
    harness.passRequests.push(request);
    const next = harness.passScript.length > 0 ? harness.passScript.shift()! : null;
    if (next instanceof Error) throw next;
    return { passId: `pass-${harness.passRequests.length}`, modelCalled: next === null, skippedReason: next, outcome: next === null ? "no_trade" : null };
  }),
}));
vi.mock("./sessionSchedule.js", () => ({ resolvePlutoSession: async () => ({ isOpen: true, windowStartEt: "09:45", windowEndEt: "15:30", windowStartAtMs: Date.parse("2026-10-07T13:45:00Z"), windowEndAtMs: Date.parse("2026-10-07T19:30:00Z"), cancelByMs: 0 }) }));
vi.mock("./settingsStore.js", () => ({ loadPlutoSettings: async () => ({ daySignalsPollSeconds: 1, tickerCooldownMinutes: 0, crashLoopRestartsPerHour: 5, dailyCostCeilingUsd: 5 }) }));
vi.mock("./readiness.js", () => ({ decidePlutoReadinessRun: () => null, describePlutoReadinessOutcome: vi.fn(), evaluatePlutoRunning: vi.fn(), runPlutoReadinessTests: vi.fn() }));
vi.mock("./readinessProbes.js", () => ({ createPlutoReadinessProbes: vi.fn() }));
vi.mock("./stateStore.js", () => ({
  describePlutoBlock: () => null,
  loadPlutoState: async () => ({ mode: "on", paused: false, breakers: {}, lastSeenRelease: null, readiness: null }),
  pausePluto: vi.fn(),
  recordPlutoRelease: vi.fn(),
  savePlutoReadiness: vi.fn(),
}));
vi.mock("./daySignalsWatermark.js", async () => {
  const actual = await vi.importActual<typeof import("./daySignalsWatermark.js")>("./daySignalsWatermark.js");
  return { ...actual, loadTodaysDaySignalQuoteStamps: async () => harness.quoteStamps };
});
vi.mock("./systemChecks.js", () => ({ isInsideTradingWindow: () => harness.insideWindow }));
vi.mock("../lib/daySignalsStore.js", () => ({ hasDaySignalsSeedFinished: async () => harness.seedFinished }));

const { PlutoAgent } = await import("./agent.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentInternals = any;

function makeAgent(): AgentInternals {
  const agent: AgentInternals = new PlutoAgent({ apiBaseUrl: "http://x", serviceUsername: "u", serviceUserPassword: "p", serviceLoginSecret: "s", openRouterApiKey: "k", telegramBotToken: "t" });
  agent.settings = { daySignalsPollSeconds: 1, tickerCooldownMinutes: 0 };
  return agent;
}

const etInstant = (hhmm: string) => new Date(`2026-10-07T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, "0")}:${hhmm.slice(3)}:00Z`);

beforeEach(() => {
  vi.useFakeTimers({ now: etInstant("10:10") });
  harness.seedFinished = false;
  harness.passRequests.length = 0;
  harness.passScript.length = 0;
  harness.events.length = 0;
  harness.telegrams.length = 0;
  harness.watchOk = true;
  harness.insideWindow = true;
  harness.connected = true;
  harness.quoteStamps = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PlutoAgent opening look (audit A)", () => {
  it("waits for the seed, then runs first, replaces queued every-ticker rounds and keeps per-symbol ones", async () => {
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
    agent.queueForcedRound("settings_changed", {}, null);
    agent.queueForcedRound("cooldown_ended", { symbol: "AAA" }, ["AAA"]);
    harness.seedFinished = true;
    await agent.housekeeping();
    expect(agent.forcedRounds.map((round: { trigger: string }) => round.trigger)).toEqual(["opening_analysis", "cooldown_ended"]);
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "opening_analysis", force: true, heldPositionsOnly: false, symbols: [] });
    await agent.loopIteration();
    expect(harness.passRequests[1]).toMatchObject({ trigger: "cooldown_ended", heldPositionsOnly: false, symbols: ["AAA"] });
    // Done for today: housekeeping queues nothing more.
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("forced rounds before the opening look are held-positions-only", async () => {
    const agent = makeAgent();
    agent.watching = true;
    agent.queueForcedRound("position_closed", {}, null);
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "position_closed", heldPositionsOnly: true, force: true });
  });

  it("a failed look is not done: no retry timer, forced rounds stay held-positions-only, housekeeping re-queues it", async () => {
    harness.seedFinished = true;
    const agent = makeAgent();
    await agent.housekeeping();
    harness.passScript.push(new Error("db down"));
    await agent.loopIteration();
    expect(agent.openingLook.doneFor).toBeNull();
    expect(agent.retryTimers.size).toBe(0);
    agent.queueForcedRound("settings_changed", {}, null);
    await agent.loopIteration();
    expect(harness.passRequests[1]).toMatchObject({ trigger: "settings_changed", heldPositionsOnly: true });
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis" });
  });

  it("10:30 fallback runs on incomplete data with a warning and an alert, then one late-seed round with a 'ready now' message", async () => {
    vi.setSystemTime(etInstant("10:30"));
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis", detail: { dataIncomplete: true } });
    await agent.loopIteration();
    expect(harness.events.some((event) => event.type === "warning" && String(event.payload.message).startsWith("opening look on incomplete data"))).toBe(true);
    expect(harness.telegrams.filter((message) => message.startsWith("⚠️ Pluto: today's Day Signals data was not ready"))).toHaveLength(1);
    // Opens are allowed once the incomplete look has run.
    agent.queueForcedRound("settings_changed", {}, null);
    await agent.loopIteration();
    expect(harness.passRequests[1]).toMatchObject({ heldPositionsOnly: false });
    // Still not seeded: nothing more.
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
    harness.seedFinished = true;
    vi.setSystemTime(etInstant("10:50"));
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis", detail: { afterLateSeed: true } });
    await agent.loopIteration();
    expect(harness.telegrams.filter((message) => message.startsWith("✅ Pluto: today's Day Signals data is ready now"))).toHaveLength(1);
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("not watching drops queued rounds and the pending look; the look is queued again once watching", async () => {
    harness.seedFinished = true;
    const agent = makeAgent();
    await agent.housekeeping();
    agent.watching = false;
    await agent.loopIteration();
    expect(agent.forcedRounds).toEqual([]);
    expect(agent.pendingOpeningLook).toBeNull();
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis" });
  });

  it("documents: a look whose round SKIPPED (e.g. a failed system check) counts as done for the day, and the late-seed message still says it ran", async () => {
    vi.setSystemTime(etInstant("10:30"));
    const agent = makeAgent();
    await agent.housekeeping();
    harness.passScript.push("account_data: account summary failed: timeout");
    await agent.loopIteration();
    expect(agent.openingLook.doneFor).toBe("2026-10-07");
    harness.seedFinished = true;
    await agent.housekeeping();
    harness.passScript.push("trading_window: outside 09:45–15:30 ET");
    await agent.loopIteration();
    expect(harness.telegrams.some((message) => message.includes("Pluto has run its full opening analysis"))).toBe(true);
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("documents: a look that fails deterministically is re-queued on every housekeeping tick without a cap", async () => {
    harness.seedFinished = true;
    const agent = makeAgent();
    for (let tick = 0; tick < 5; tick += 1) {
      harness.passScript.push(new Error("TypeError: cannot read properties of undefined"));
      await agent.housekeeping();
      await agent.loopIteration();
    }
    expect(harness.passRequests.filter((request) => request.trigger === "opening_analysis")).toHaveLength(5);
  });
});

describe("PlutoAgent forced-round retry and failure alert (audit A)", () => {
  it("retries a failed forced round once after 60 s, then drops it with a warning", async () => {
    const agent = makeAgent();
    agent.watching = true;
    agent.queueForcedRound("settings_changed", { fields: ["minGrade"] }, null);
    harness.passScript.push(new Error("first"), new Error("second"));
    await agent.loopIteration();
    expect(agent.forcedRounds).toEqual([]);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(agent.forcedRounds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(agent.forcedRounds).toEqual([{ trigger: "settings_changed", detail: { fields: ["minGrade"] }, symbols: null, retried: true }]);
    await agent.loopIteration();
    expect(harness.events.filter((event) => event.type === "warning" && String(event.payload.message).includes("round dropped"))).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(agent.forcedRounds).toEqual([]);
    expect(harness.passRequests).toHaveLength(2);
  });

  it("stop() clears a pending retry timer", async () => {
    const agent = makeAgent();
    agent.watching = true;
    agent.queueForcedRound("order_ended", {}, null);
    harness.passScript.push(new Error("boom"));
    await agent.loopIteration();
    expect(agent.retryTimers.size).toBe(1);
    await agent.stop();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(agent.forcedRounds).toEqual([]);
  });

  it("3 failed rounds in a row alert once (4th silent), skipped rounds count as completed and send one recovery", async () => {
    const agent = makeAgent();
    agent.watching = true;
    harness.passScript.push(new Error("a"), new Error("b"), new Error("c"), new Error("d"), "nothing eligible", null);
    for (let round = 0; round < 6; round += 1) await agent.runRoundSafely({ trigger: "day_signals_update", triggerDetail: {}, symbols: ["AAA"], force: false });
    expect(harness.telegrams.filter((message) => message.includes("analysis rounds in a row have failed"))).toHaveLength(1);
    expect(harness.telegrams.filter((message) => message.includes("completing again"))).toHaveLength(1);
  });

  it("a Day Signals round that failed still remembers the quotes it was given (deliberate)", async () => {
    const agent = makeAgent();
    agent.watching = true;
    harness.quoteStamps = [{ symbol: "AAA", expiry: "2026-10-16", strike: 30, right: "C", quotedAtMs: etInstant("10:05").getTime() }];
    harness.passScript.push(new Error("boom"));
    await agent.loopIteration();
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(1);
  });

  it("Day Signals rounds are never held-positions-only, even before the opening look", async () => {
    const agent = makeAgent();
    agent.watching = true;
    harness.quoteStamps = [{ symbol: "AAA", expiry: "2026-10-16", strike: 30, right: "C", quotedAtMs: etInstant("10:05").getTime() }];
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "day_signals_update", force: false });
    expect(harness.passRequests[0]!.heldPositionsOnly).toBeUndefined();
  });
});

describe("PlutoAgent window, analysis and connection events", () => {
  const eventTypes = () => harness.events.map((event) => event.type);

  it("announces the window and the opening analysis once each, however often housekeeping runs", async () => {
    const agent = makeAgent();
    await agent.housekeeping();
    await agent.housekeeping();
    expect(eventTypes().filter((type) => type === "window_opened")).toHaveLength(1);
    expect(harness.events.find((event) => event.type === "window_opened")!.payload).toMatchObject({ date: "2026-10-07", windowEndEt: "15:30", windowEndAt: "2026-10-07T19:30:00.000Z" });
    expect(eventTypes()).not.toContain("analysis_started");
    harness.seedFinished = true;
    await agent.housekeeping();
    harness.passScript.push("trading_window: outside");
    await agent.loopIteration();
    await agent.housekeeping();
    expect(harness.events.filter((event) => event.type === "analysis_started").map((event) => event.payload)).toEqual([{ date: "2026-10-07", data: "complete" }]);
  });

  it("at the window's end the loop runs no more rounds: housekeeping releases the lines and writes the close at once", async () => {
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.watching).toBe(true);
    vi.setSystemTime(etInstant("15:30"));
    harness.insideWindow = false;
    harness.quoteStamps = [{ symbol: "AAA", expiry: "2026-10-16", strike: 30, right: "C", quotedAtMs: etInstant("15:29").getTime() }];
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(0);
    expect(agent.watching).toBe(false);
    expect(eventTypes().slice(-2)).toEqual(["lines_changed", "window_closed"]);
    await agent.housekeeping();
    expect(eventTypes().filter((type) => type === "window_closed")).toHaveLength(1);
  });

  it("no window events when Pluto never entered its window today", async () => {
    harness.insideWindow = false;
    vi.setSystemTime(etInstant("16:00"));
    const agent = makeAgent();
    await agent.housekeeping();
    expect(eventTypes()).toEqual([]);
  });

  it("reports a lost IBKR connection after the grace and its return, only inside the window", async () => {
    const agent = makeAgent();
    await agent.housekeeping();
    harness.connected = false;
    await agent.heartbeat();
    expect(eventTypes()).not.toContain("connection_lost");
    vi.setSystemTime(etInstant("10:13"));
    await agent.heartbeat();
    await agent.heartbeat();
    expect(eventTypes().filter((type) => type === "connection_lost")).toHaveLength(1);
    vi.setSystemTime(etInstant("10:16"));
    harness.connected = true;
    await agent.heartbeat();
    expect(harness.events.at(-1)).toEqual({ type: "connection_restored", payload: { downMinutes: 3 } });
    harness.insideWindow = false;
    await agent.housekeeping();
    harness.connected = false;
    await agent.heartbeat();
    expect(eventTypes().filter((type) => type === "connection_lost")).toHaveLength(1);
  });
});
