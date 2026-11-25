import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): the PlutoAgent loop (opening look, held-positions-only rounds, forced-round retry, failure alert),
// driven through its private housekeeping()/loopIteration() with every import mocked. Wall clock is faked (2026-10-07 is EDT).

const harness = vi.hoisted(() => ({
  bandQuotesIn: false,
  noBandExpiryToday: false,
  passRequests: [] as Record<string, unknown>[],
  /** One entry per runPlutoPass call: an Error throws, a string is the skipped reason, null a model-call round. */
  passScript: [] as (Error | string | null)[],
  events: [] as { type: string; payload: Record<string, unknown> }[],
  telegrams: [] as string[],
  watchOk: true,
  insideWindow: true,
  connected: true,
  finishedCycles: [] as { symbol: string; finishedAtMs: number }[],
  workingOrders: [] as Record<string, unknown>[],
  /** Runs while loadWorkingPlutoOrders reads, before it returns. */
  duringWorkingOrdersRead: null as (() => void) | null,
  /** Each runPlutoPass call waits for this, when set, before it returns. */
  holdRound: null as Promise<void> | null,
  callsInTheMoney: "assigned" as "assigned" | "bought_back" | "bought_back_before_weekends",
  expiringCalls: [] as { symbol: string; strike: number }[],
  stockPrice: null as number | null,
  settleCalls: [] as (string[] | null)[],
  /** Each watchNowAndAwaitQuote call (symbol, timeout) and what it answers. */
  watchNowCalls: [] as { symbol: string; timeoutMs: number }[],
  quoteArrives: true,
  /** One entry per runPlutoPass call: the tickers it held back for want of a live quote. */
  quoteBlockedScript: [] as string[][],
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
  const connection = { setBorrowTimeoutMs: () => {}, getHealthSnapshot: () => ({ connected: harness.connected, totalReconnects: 0 }), listenerCount: () => 0 };
  return { sharedLiveConnection: connection, sharedReadConnection: connection, sharedConnectionOutageTracker: { setOwner: () => {} } };
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
vi.mock("../lib/liveTradingSessions.js", () => ({ loadLiveTradingSessions: async () => ({ openDays: ["2026-10-07", "2026-10-08"], sessionsHeldTo: () => 1 }) }));
vi.mock("../ibkr/pricePool.js", () => ({ fetchPooledPricesOnly: () => ({ stock: harness.stockPrice }) }));
vi.mock("./buyBackChecks.js", async () => ({ ...(await vi.importActual<object>("./buyBackChecks.js")), loadPlutoCallsExpiringToday: async () => harness.expiringCalls }));
vi.mock("./volFarmerV4Round.js", () => ({
  followTheMidOfAdoptedOrder: () => undefined,
  settleVolFarmerV4EndedOrders: async (symbols: string[] | null) => {
    harness.settleCalls.push(symbols);
    return [];
  },
}));
vi.mock("./executor.js", () => ({
  loadWorkingPlutoOrders: async () => {
    harness.duringWorkingOrdersRead?.();
    return harness.workingOrders;
  },
  watchPlutoOrder: vi.fn(() => new Promise(() => {})),
}));
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
    async watchNowAndAwaitQuote(symbol: string, timeoutMs: number) {
      harness.watchNowCalls.push({ symbol, timeoutMs });
      return harness.quoteArrives;
    }
    async stop() {}
  },
}));
vi.mock("./passRunner.js", () => ({
  PlutoRoundFailedAfterModelCallError: class PlutoRoundFailedAfterModelCallError extends Error {},
  runPlutoPass: vi.fn(async (request: Record<string, unknown>) => {
    harness.passRequests.push(request);
    if (harness.holdRound) await harness.holdRound;
    const next = harness.passScript.length > 0 ? harness.passScript.shift()! : null;
    if (next instanceof Error) throw next;
    const quoteBlockedSymbols = harness.quoteBlockedScript.shift() ?? [];
    return { passId: `pass-${harness.passRequests.length}`, modelCalled: next === null, skippedReason: next, outcome: next === null ? "no_trade" : null, ...(quoteBlockedSymbols.length > 0 ? { quoteBlockedSymbols } : {}) };
  }),
}));
vi.mock("./sessionSchedule.js", () => ({ resolvePlutoSession: async () => ({ isOpen: true, windowStartEt: "09:45", windowEndEt: "15:30", windowStartAtMs: Date.parse("2026-10-07T13:45:00Z"), windowEndAtMs: Date.parse("2026-10-07T19:30:00Z"), buyBacksStopAtMs: Date.parse("2026-10-07T19:59:00Z"), buyBacksStopEt: "15:59", closeAtMs: Date.parse("2026-10-07T20:00:00Z") }) }));
vi.mock("./settingsStore.js", () => ({ loadPlutoSettings: async () => ({ daySignalsPollSeconds: 1, tickerCooldownMinutes: 0, crashLoopRestartsPerHour: 5, dailyCostCeilingUsd: 5, volFarmerV4CallsInTheMoneyAtLastLook: harness.callsInTheMoney }) }));
vi.mock("./readiness.js", () => ({ decidePlutoReadinessRun: () => null, describePlutoReadinessOutcome: vi.fn(), evaluatePlutoRunning: vi.fn(), runPlutoReadinessTests: vi.fn() }));
vi.mock("./readinessProbes.js", () => ({ createPlutoReadinessProbes: vi.fn() }));
vi.mock("./stateStore.js", () => ({
  describePlutoBlock: () => null,
  loadPlutoState: async () => ({ mode: "on", paused: false, breakers: {}, lastSeenRelease: null, readiness: null }),
  pausePluto: vi.fn(),
  recordPlutoRelease: vi.fn(),
  savePlutoReadiness: vi.fn(),
}));
vi.mock("./bandQuoteWatermark.js", async () => {
  const actual = await vi.importActual<typeof import("./bandQuoteWatermark.js")>("./bandQuoteWatermark.js");
  return { ...actual, loadTodaysFinishedBandCycles: async () => harness.finishedCycles, hasTodaysBandQuotes: async () => harness.bandQuotesIn, noEnabledTickerHasBandExpiryOn: async () => harness.noBandExpiryToday };
});
vi.mock("./systemChecks.js", () => ({ isInsideTradingWindow: () => harness.insideWindow }));

const { PlutoAgent } = await import("./agent.js");
const { easternIsoDate } = await import("../lib/easternIsoDate.js");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AgentInternals = any;

function makeAgent(): AgentInternals {
  const agent: AgentInternals = new PlutoAgent({ apiBaseUrl: "http://x", serviceUsername: "u", serviceUserPassword: "p", serviceLoginSecret: "s", telegramBotToken: "t" });
  agent.settings = { daySignalsPollSeconds: 1, tickerCooldownMinutes: 0, volFarmerV4CallsInTheMoneyAtLastLook: harness.callsInTheMoney };
  return agent;
}

const etInstant = (hhmm: string) => new Date(`2026-10-07T${String(Number(hhmm.slice(0, 2)) + 4).padStart(2, "0")}:${hhmm.slice(3)}:00Z`);

beforeEach(() => {
  vi.useFakeTimers({ now: etInstant("10:10") });
  harness.bandQuotesIn = false;
  harness.noBandExpiryToday = false;
  harness.passRequests.length = 0;
  harness.passScript.length = 0;
  harness.events.length = 0;
  harness.telegrams.length = 0;
  harness.watchOk = true;
  harness.insideWindow = true;
  harness.connected = true;
  harness.finishedCycles = [];
  harness.workingOrders = [];
  harness.duringWorkingOrdersRead = null;
  harness.holdRound = null;
  harness.callsInTheMoney = "assigned";
  harness.expiringCalls = [];
  harness.stockPrice = null;
  harness.settleCalls.length = 0;
  harness.watchNowCalls.length = 0;
  harness.quoteArrives = true;
  harness.quoteBlockedScript.length = 0;
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
    harness.bandQuotesIn = true;
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
    agent.phase = "window";
    agent.queueForcedRound("position_closed", {}, null);
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "position_closed", heldPositionsOnly: true, force: true });
  });

  it("a failed look is not done: no retry timer, forced rounds stay held-positions-only, housekeeping re-queues it", async () => {
    harness.bandQuotesIn = true;
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

  it("a day no ticker has the band's expiry runs the opening look at once with an info notice, no warning, and no late-seed round", async () => {
    harness.noBandExpiryToday = true;
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis", detail: { noOptionExpiryToday: true } });
    await agent.loopIteration();
    expect(harness.events.some((event) => event.type === "analysis_started" && event.payload.data === "no_option_expiry_today")).toBe(true);
    expect(harness.events.some((event) => event.type === "warning")).toBe(false);
    expect(harness.telegrams.filter((message) => message.startsWith("ℹ️ Pluto: no option on Pluto's tickers expires at today's close"))).toHaveLength(1);
    expect(harness.telegrams.some((message) => message.startsWith("⚠️"))).toBe(false);
    vi.setSystemTime(etInstant("10:40"));
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("10:30 fallback runs on incomplete data with a warning and an alert, then one late-seed round with a 'ready now' message", async () => {
    vi.setSystemTime(etInstant("10:30"));
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis", detail: { dataIncomplete: true } });
    await agent.loopIteration();
    expect(harness.events.some((event) => event.type === "warning" && String(event.payload.message).startsWith("opening look on incomplete data"))).toBe(true);
    expect(harness.telegrams.filter((message) => message.startsWith("⚠️ Pluto: today's option quotes were not in"))).toHaveLength(1);
    // Opens are allowed once the incomplete look has run.
    agent.queueForcedRound("settings_changed", {}, null);
    await agent.loopIteration();
    expect(harness.passRequests[1]).toMatchObject({ heldPositionsOnly: false });
    // Still no band quotes: nothing more.
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
    harness.bandQuotesIn = true;
    vi.setSystemTime(etInstant("10:50"));
    await agent.housekeeping();
    expect(agent.forcedRounds[0]).toMatchObject({ trigger: "opening_analysis", detail: { afterLateSeed: true } });
    await agent.loopIteration();
    expect(harness.telegrams.filter((message) => message.startsWith("✅ Pluto: today's option quotes are in now"))).toHaveLength(1);
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("not watching drops queued rounds and the pending look; the look is queued again once watching", async () => {
    harness.bandQuotesIn = true;
    const agent = makeAgent();
    await agent.housekeeping();
    agent.phase = null;
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
    harness.bandQuotesIn = true;
    await agent.housekeeping();
    harness.passScript.push("trading_window: outside 09:45–15:30 ET");
    await agent.loopIteration();
    expect(harness.telegrams.some((message) => message.includes("Pluto has run its full opening analysis"))).toBe(true);
    await agent.housekeeping();
    expect(agent.forcedRounds).toEqual([]);
  });

  it("documents: a look that fails deterministically is re-queued on every housekeeping tick without a cap", async () => {
    harness.bandQuotesIn = true;
    const agent = makeAgent();
    for (let tick = 0; tick < 5; tick += 1) {
      harness.passScript.push(new Error("TypeError: cannot read properties of undefined"));
      await agent.housekeeping();
      await agent.loopIteration();
    }
    expect(harness.passRequests.filter((request) => request.trigger === "opening_analysis")).toHaveLength(5);
  });
});

describe("PlutoAgent rounds queued by notifications", () => {
  const plutoEvent = (eventType: string, payload: Record<string, unknown>) => ({ type: "pluto_event", eventId: 1, eventType, occurredAt: "2026-11-10T15:58:42Z", payload });

  it("a ticker switched on gets a round of its own, run with every other enabled ticker's decisions untouched", async () => {
    const agent = makeAgent();
    agent.phase = "window";
    agent.openingLook.doneFor = easternIsoDate(new Date());
    agent.onNotification(plutoEvent("ticker_enabled", { symbol: "NVDA", by: "Marcelo" }));
    expect(agent.forcedRounds).toEqual([{ trigger: "settings_changed", detail: { fields: ["enabled"], symbol: "NVDA", by: "Marcelo" }, symbols: ["NVDA"], retried: false }]);
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "settings_changed", symbols: ["NVDA"], force: true, heldPositionsOnly: false });
    // Its stock line is subscribed, and a quote awaited, before the round: not left to housekeeping's next tick (RKLB 2026-11-25).
    expect(harness.watchNowCalls).toEqual([{ symbol: "NVDA", timeoutMs: 10_000 }]);
  });

  it("a switched-on ticker's round still runs when no quote arrives in time; other forced rounds and the buyback minutes await none", async () => {
    harness.quoteArrives = false;
    const agent = makeAgent();
    agent.phase = "window";
    agent.openingLook.doneFor = easternIsoDate(new Date());
    agent.onNotification(plutoEvent("ticker_enabled", { symbol: "RKLB", by: "Marcelo" }));
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(1);
    agent.queueForcedRound("cooldown_ended", { symbol: "AMD" }, ["AMD"]);
    await agent.loopIteration();
    agent.phase = "buy_backs";
    agent.onNotification(plutoEvent("ticker_enabled", { symbol: "NVDA", by: "Marcelo" }));
    await agent.loopIteration();
    expect(harness.passRequests.map((request) => request.trigger)).toEqual(["settings_changed", "cooldown_ended", "settings_changed"]);
    expect(harness.watchNowCalls.map((call) => call.symbol)).toEqual(["RKLB"]);
  });

  it("a forced round that held an order back for want of a live quote looks again at those tickers once, 30 s later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agent = makeAgent();
    agent.phase = "window";
    agent.openingLook.doneFor = easternIsoDate(new Date());
    harness.quoteBlockedScript.push(["RKLB"], ["RKLB"]);
    agent.onNotification(plutoEvent("ticker_enabled", { symbol: "RKLB", by: "Marcelo" }));
    await agent.loopIteration();
    expect(agent.forcedRounds).toEqual([]);
    expect(agent.retryTimers.size).toBe(1);
    vi.advanceTimersByTime(29_999);
    expect(agent.forcedRounds).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(agent.forcedRounds).toEqual([{ trigger: "live_quote_retry", detail: { symbols: ["RKLB"], afterSeconds: 30, retryOf: "settings_changed" }, symbols: ["RKLB"], retried: true }]);
    await agent.loopIteration();
    expect(harness.passRequests[1]).toMatchObject({ trigger: "live_quote_retry", symbols: ["RKLB"], force: true, heldPositionsOnly: false });
    // Blocked again: no second retry.
    expect(agent.retryTimers.size).toBe(0);
  });

  it("no live-quote retry after a round that held nothing back, one that failed, or a band round", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const agent = makeAgent();
    agent.phase = "window";
    agent.openingLook.doneFor = easternIsoDate(new Date());
    agent.queueForcedRound("order_ended", { symbol: "AMD", outcome: "filled" }, null);
    await agent.loopIteration();
    expect(agent.retryTimers.size).toBe(0);
    harness.passScript.push(new Error("db down"));
    harness.quoteBlockedScript.push(["RKLB"]);
    agent.queueForcedRound("position_closed", {}, null);
    await agent.loopIteration();
    // Only the failed round's own retry (forcedRoundRetryDelayMs) is set, as a position_closed round.
    expect(agent.retryTimers.size).toBe(1);
    vi.runOnlyPendingTimers();
    expect(agent.forcedRounds.map((round: { trigger: string }) => round.trigger)).toEqual(["position_closed"]);
  });

  it("a ticker switched off, or an event with no symbol, queues nothing; a decision setting still queues an every-ticker round", () => {
    const agent = makeAgent();
    agent.onNotification(plutoEvent("ticker_disabled", { symbol: "NVDA", by: "Marcelo" }));
    agent.onNotification(plutoEvent("ticker_enabled", { by: "Marcelo" }));
    agent.onNotification(plutoEvent("settings_changed", { by: "Marcelo", fields: [{ field: "telegramVerbosity" }] }));
    expect(agent.forcedRounds).toEqual([]);
    agent.onNotification(plutoEvent("settings_changed", { by: "Marcelo", symbol: "AMD", fields: [{ field: "allocationPct" }] }));
    expect(agent.forcedRounds).toEqual([{ trigger: "settings_changed", detail: { fields: ["allocationPct"], by: "Marcelo" }, symbols: null, retried: false }]);
  });
});

describe("PlutoAgent forced-round retry and failure alert (audit A)", () => {
  it("retries a failed forced round once after 60 s, then drops it with a warning", async () => {
    const agent = makeAgent();
    agent.phase = "window";
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
    agent.phase = "window";
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
    agent.phase = "window";
    harness.passScript.push(new Error("a"), new Error("b"), new Error("c"), new Error("d"), "nothing eligible", null);
    for (let round = 0; round < 6; round += 1) await agent.runRoundSafely({ trigger: "band_quotes_update", triggerDetail: {}, symbols: ["AAA"], force: false });
    expect(harness.telegrams.filter((message) => message.includes("analysis rounds in a row have failed"))).toHaveLength(1);
    expect(harness.telegrams.filter((message) => message.includes("completing again"))).toHaveLength(1);
  });

  it("a band round that failed still remembers the finished cycle it was given (deliberate)", async () => {
    const agent = makeAgent();
    agent.phase = "window";
    harness.finishedCycles = [{ symbol: "AAA", finishedAtMs: etInstant("10:05").getTime() }];
    harness.passScript.push(new Error("boom"));
    await agent.loopIteration();
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(1);
  });

  it("band rounds are never held-positions-only, even before the opening look", async () => {
    const agent = makeAgent();
    agent.phase = "window";
    harness.finishedCycles = [{ symbol: "AAA", finishedAtMs: etInstant("10:05").getTime() }];
    await agent.loopIteration();
    expect(harness.passRequests[0]).toMatchObject({ trigger: "band_quotes_update", force: false });
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
    harness.bandQuotesIn = true;
    await agent.housekeeping();
    harness.passScript.push("trading_window: outside");
    await agent.loopIteration();
    await agent.housekeeping();
    expect(harness.events.filter((event) => event.type === "analysis_started").map((event) => event.payload)).toEqual([{ date: "2026-10-07", data: "complete" }]);
  });

  it("at the window's end the loop runs no more rounds: housekeeping releases the lines and writes the close at once", async () => {
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.phase).toBe("window");
    vi.setSystemTime(etInstant("15:30"));
    harness.insideWindow = false;
    harness.finishedCycles = [{ symbol: "AAA", finishedAtMs: etInstant("15:29").getTime() }];
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(0);
    expect(agent.phase).toBeNull();
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

describe("PlutoAgent agent lease", () => {
  it("runs a round only once the agent lease is renewed: a refused check never reaches the pass runner", async () => {
    let leaseHeld = false;
    const lease = { holderId: "agent.1:audit-a", confirmHeld: vi.fn(async () => leaseHeld) };
    const agent: AgentInternals = new PlutoAgent({ apiBaseUrl: "http://x", serviceUsername: "u", serviceUserPassword: "p", serviceLoginSecret: "s", telegramBotToken: "t" }, lease);
    agent.settings = { daySignalsPollSeconds: 1, tickerCooldownMinutes: 0, volFarmerV4CallsInTheMoneyAtLastLook: harness.callsInTheMoney };
    const request = { trigger: "band_quotes_update", triggerDetail: {}, symbols: ["AAA"], force: false };
    expect((await agent.runRoundSafely(request)).result).toBe("failed");
    expect(harness.passRequests).toHaveLength(0);
    leaseHeld = true;
    expect((await agent.runRoundSafely(request)).result).toBe("completed");
    expect(harness.passRequests).toHaveLength(1);
    expect(lease.confirmHeld).toHaveBeenCalledTimes(2);
  });
});

describe("PlutoAgent adopting working orders", () => {
  const leftover = { orderId: "order-1", actionId: "action-1", symbol: "NVDA", kind: "open_covered_call", createdAtMs: Date.parse("2026-10-07T14:00:00Z"), reference: { price: 1.5, side: "sell", multiplier: 100 }, description: "NVDA Sell $192.5 Call · 7 Oct (0DTE) · 3× @ 1.50" };
  const adoptedOrderIds = () => harness.events.filter((event) => event.type === "order_adopted").map((event) => event.payload.orderId);
  const roundRequest = { trigger: "band_quotes_update", triggerDetail: {}, symbols: ["NVDA"], force: false };

  it("adopts a working order no watch covers when no round is running, and only once", async () => {
    harness.workingOrders = [leftover];
    const agent = makeAgent();
    await agent.adoptWorkingOrders();
    await agent.adoptWorkingOrders();
    expect(adoptedOrderIds()).toEqual(["order-1"]);
  });

  it("leaves an unwatched order alone while a round runs (it may be the round's own, not yet confirmed), and adopts it once the round has ended", async () => {
    harness.workingOrders = [leftover];
    let releaseRound!: () => void;
    harness.holdRound = new Promise<void>((resolve) => (releaseRound = resolve));
    const agent = makeAgent();
    const round = agent.runRoundSafely(roundRequest);
    await vi.waitFor(() => expect(harness.passRequests).toHaveLength(1));
    await agent.adoptWorkingOrders();
    expect(adoptedOrderIds()).toEqual([]);
    releaseRound();
    expect((await round).result).toBe("completed");
    await agent.adoptWorkingOrders();
    expect(adoptedOrderIds()).toEqual(["order-1"]);
  });

  it("drops a read during which a round started", async () => {
    harness.workingOrders = [leftover];
    const agent = makeAgent();
    harness.duringWorkingOrdersRead = () => {
      harness.duringWorkingOrdersRead = null;
      void agent.runRoundSafely(roundRequest);
    };
    await agent.adoptWorkingOrders();
    expect(harness.passRequests).toHaveLength(1);
    expect(adoptedOrderIds()).toEqual([]);
  });
});

describe("PlutoAgent buyback minutes after the window (Marcelo 2026-11-24)", () => {
  const eventTypes = () => harness.events.map((event) => event.type);
  /** In the window at 10:10, then at `hhmm` ET past its 15:30 end, buying back every day, TQQQ holding a $49.50 Call expiring today. */
  async function pastTheWindow(hhmm: string, stockPrice: number | null): Promise<AgentInternals> {
    harness.callsInTheMoney = "bought_back";
    harness.expiringCalls = [{ symbol: "TQQQ", strike: 49.5 }];
    const agent = makeAgent();
    await agent.housekeeping();
    expect(agent.phase).toBe("window");
    vi.setSystemTime(etInstant(hhmm));
    harness.insideWindow = false;
    harness.stockPrice = stockPrice;
    return agent;
  }
  const buyBackRounds = () => harness.passRequests.filter((request) => request.trigger === "buy_back_check");

  it("holds only the lines of the tickers with a Call expiring today, and runs a buyback round once the stock reaches the strike", async () => {
    const agent = await pastTheWindow("15:31", 49.4);
    await agent.loopIteration();
    expect(agent.phase).toBe("buy_backs");
    expect(harness.events.find((event) => event.type === "lines_changed" && String(event.payload.detail).includes("buybacks only"))?.payload.detail).toBe("1 stock line(s) for the Calls expiring today (TQQQ), until 15:59 ET: buybacks only");
    expect(eventTypes()).toContain("window_closed");
    expect(buyBackRounds()).toEqual([]);

    harness.stockPrice = 49.51;
    await agent.loopIteration();
    expect(buyBackRounds()).toEqual([expect.objectContaining({ trigger: "buy_back_check", symbols: ["TQQQ"], force: true })]);
    // At most one every 5 s per ticker.
    await agent.loopIteration();
    expect(buyBackRounds()).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    await agent.loopIteration();
    expect(buyBackRounds()).toHaveLength(2);
    // New option quotes run no round after the window.
    harness.finishedCycles = [{ symbol: "TQQQ", finishedAtMs: Date.now() }];
    harness.stockPrice = 49.4;
    vi.advanceTimersByTime(5_000);
    await agent.loopIteration();
    expect(harness.passRequests).toHaveLength(2);
  });

  it("runs no buyback round while one of the ticker's orders works", async () => {
    const agent = await pastTheWindow("15:40", 49.6);
    agent.context.trackWatch(new Promise(() => {}), "order-1", "TQQQ");
    await agent.loopIteration();
    expect(agent.phase).toBe("buy_backs");
    expect(buyBackRounds()).toEqual([]);
  });

  it("checks from 2 minutes before the window's end, inside it", async () => {
    harness.callsInTheMoney = "bought_back";
    harness.expiringCalls = [{ symbol: "TQQQ", strike: 49.5 }];
    harness.stockPrice = 49.6;
    const agent = makeAgent();
    vi.setSystemTime(etInstant("15:27"));
    await agent.housekeeping();
    await agent.loopIteration();
    expect(buyBackRounds()).toEqual([]);
    vi.setSystemTime(etInstant("15:28"));
    await agent.loopIteration();
    expect(buyBackRounds()).toHaveLength(1);
  });

  it("at the stop time lets the lines go and settles the orders that ended; later endings are settled as they come", async () => {
    const agent = await pastTheWindow("15:45", 49.4);
    await agent.loopIteration();
    expect(agent.phase).toBe("buy_backs");
    harness.settleCalls.length = 0;
    vi.setSystemTime(etInstant("15:59"));
    await agent.loopIteration();
    expect(agent.phase).toBeNull();
    expect(harness.settleCalls).toEqual([null]);
    await agent.loopIteration();
    expect(harness.settleCalls).toEqual([null]);

    agent.onOrderEnded("TQQQ", { outcome: "filled" });
    await agent.loopIteration();
    expect(harness.settleCalls).toEqual([null, ["TQQQ"]]);
    expect(harness.passRequests).toEqual([]);
  });

  it("holds nothing after the window on a day that buys none back, nor with no Call expiring today", async () => {
    harness.callsInTheMoney = "bought_back_before_weekends";
    harness.expiringCalls = [{ symbol: "TQQQ", strike: 49.5 }];
    // Wednesday 7 Oct 2026, Thursday a session: no buyback today.
    const agent = makeAgent();
    await agent.housekeeping();
    vi.setSystemTime(etInstant("15:31"));
    harness.insideWindow = false;
    harness.stockPrice = 49.6;
    await agent.loopIteration();
    expect(agent.phase).toBeNull();
    expect(buyBackRounds()).toEqual([]);

    harness.callsInTheMoney = "bought_back";
    harness.expiringCalls = [];
    const other = makeAgent();
    vi.setSystemTime(etInstant("10:10"));
    harness.insideWindow = true;
    await other.housekeeping();
    vi.setSystemTime(etInstant("15:31"));
    harness.insideWindow = false;
    await other.loopIteration();
    expect(other.phase).toBeNull();
  });
});

describe("plutoAgentPhase", () => {
  const window = { marketOpen: true, insideWindow: true, isOpenDay: true, windowEndAtMs: Date.parse("2026-10-07T19:30:00Z"), buyBacksToday: true, buyBacksStopAtMs: Date.parse("2026-10-07T19:59:00Z") };
  it("is the window until its end, the buyback minutes until a minute before the close, then nothing", async () => {
    const { plutoAgentPhase } = await import("./agent.js");
    expect(plutoAgentPhase(window, Date.parse("2026-10-07T19:29:59Z"))).toBe("window");
    expect(plutoAgentPhase(window, Date.parse("2026-10-07T19:30:00Z"))).toBe("buy_backs");
    expect(plutoAgentPhase({ ...window, insideWindow: false }, Date.parse("2026-10-07T19:58:59Z"))).toBe("buy_backs");
    expect(plutoAgentPhase({ ...window, insideWindow: false }, Date.parse("2026-10-07T19:59:00Z"))).toBeNull();
    expect(plutoAgentPhase({ ...window, insideWindow: false, buyBacksToday: false }, Date.parse("2026-10-07T19:45:00Z"))).toBeNull();
    expect(plutoAgentPhase({ ...window, insideWindow: false, marketOpen: false }, Date.parse("2026-10-07T19:45:00Z"))).toBeNull();
  });
});
