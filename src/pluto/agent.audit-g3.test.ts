import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit (G3, 2026-10-07): PlutoAgent.runReadinessIfDue with the real readiness.ts and only the probes, the state and the
// side effects mocked. Covers Pluto off / paused / on at the 6:00 and 9:20 ET runs, the "says once when fixed" re-check,
// closed days and the ET date across midnight UTC. 2097-07-15 is a Monday in EDT: 6:00 ET = 10:00Z, 9:20 ET = 13:20Z.

type State = { mode: "on" | "off"; paused: boolean; pauseReason: string | null; breakers: Record<string, unknown>; lastSeenRelease: null; readiness: Record<string, unknown> | null };

const harness = vi.hoisted(() => ({
  openDay: true,
  states: [] as State[],
  probeFailures: {} as Record<string, string>,
  telegrams: [] as string[],
  events: [] as { type: string; payload: Record<string, unknown> }[],
  pauses: [] as string[],
  saved: [] as Record<string, unknown>[],
}));

vi.mock("../db/connection.js", () => ({ db: Object.assign(() => ({}), { raw: () => "", fn: { now: () => "now()" } }) }));
vi.mock("../ibkr/marketDataPool.js", () => ({ marketDataPoolSnapshot: () => ({ contractCount: 0 }) }));
vi.mock("../ibkr/sharedReadConnection.js", () => {
  const connection = { getHealthSnapshot: () => ({ connected: true, totalReconnects: 0 }), listenerCount: () => 0 };
  return { sharedLiveConnection: connection, sharedReadConnection: connection };
});
vi.mock("../lib/processMemoryMonitor.js", () => ({ startProcessMemoryMonitor: () => () => {} }));
vi.mock("../lib/appEnvironment.js", () => ({ readAppEnvironment: () => "test" }));
vi.mock("../lib/internalApiClient.js", () => ({ InternalApiClient: class {} }));
vi.mock("../lib/notificationBroadcaster.js", () => ({ startNotificationBroadcaster: () => {}, subscribeToNotifications: () => () => {} }));
vi.mock("../lib/marketSessionStatus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/marketSessionStatus.js")>()),
  computeMarketSessionStatus: async () => ({ state: "pre-market" }),
  resolveIsOpenDay: vi.fn(async () => harness.openDay),
}));
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
vi.mock("./marketWatch.js", () => ({ PlutoMarketWatch: class {} }));
vi.mock("./passRunner.js", () => ({ runPlutoPass: vi.fn() }));
vi.mock("./sessionSchedule.js", () => ({ resolvePlutoSession: vi.fn() }));
vi.mock("./settingsStore.js", () => ({ loadPlutoSettings: async () => ({ dailyCostCeilingUsd: 5 }) }));
vi.mock("./readinessProbes.js", () => ({
  createPlutoReadinessProbes: () => {
    const probe = (name: string) => async () => {
      if (harness.probeFailures[name]) throw new Error(harness.probeFailures[name]);
      return `${name} fine`;
    };
    return { ibkr: probe("IBKR"), apiSignIn: probe("API sign-in"), openRouter: probe("OpenRouter") };
  },
}));
vi.mock("./stateStore.js", () => ({
  describePlutoBlock: () => null,
  // Each call returns the next scripted state; the last one repeats.
  loadPlutoState: vi.fn(async () => (harness.states.length > 1 ? harness.states.shift()! : harness.states[0]!)),
  pausePluto: vi.fn(async (kind: string) => {
    harness.pauses.push(kind);
  }),
  recordPlutoRelease: vi.fn(),
  savePlutoReadiness: vi.fn(async (record: Record<string, unknown>) => {
    harness.saved.push(record);
  }),
}));
vi.mock("./daySignalsWatermark.js", () => ({ findNewlyQuotedContracts: vi.fn(), loadTodaysDaySignalQuoteStamps: vi.fn(), rememberAnalysed: vi.fn() }));
vi.mock("./systemChecks.js", () => ({ isInsideTradingWindow: () => true }));
vi.mock("../lib/daySignalsStore.js", () => ({ hasDaySignalsSeedFinished: async () => true }));

const { PlutoAgent } = await import("./agent.js");

const config = { apiBaseUrl: "http://127.0.0.1:1", serviceUsername: "pluto", serviceUserPassword: "x", serviceLoginSecret: "x", openRouterApiKey: "k", telegramBotToken: "t" };

function state(overrides: Partial<State> = {}): State {
  return { mode: "on", paused: false, pauseReason: null, breakers: {}, lastSeenRelease: null, readiness: null, ...overrides };
}

async function runReadinessAt(isoInstant: string, ...states: State[]): Promise<void> {
  vi.setSystemTime(new Date(isoInstant));
  harness.states = states;
  const agent = new PlutoAgent(config) as unknown as { runReadinessIfDue(): Promise<void> };
  await agent.runReadinessIfDue();
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  harness.openDay = true;
  harness.states = [];
  harness.probeFailures = {};
  harness.telegrams = [];
  harness.events = [];
  harness.pauses = [];
  harness.saved = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runReadinessIfDue with Pluto off, paused or on (audit)", () => {
  it("runs at 6:00 ET while Pluto is Off and alerts that it is not running, without a pause promise", async () => {
    await runReadinessAt("2097-07-15T10:00:30Z", state({ mode: "off" }));
    expect(harness.saved).toHaveLength(1);
    expect(harness.saved[0]).toMatchObject({ dateIso: "2097-07-15", lastRunKind: "first", signature: "Pluto running", finalDone: false });
    expect(harness.telegrams).toHaveLength(1);
    expect(harness.telegrams[0]).toContain("❌ Pluto running: switched off");
    expect(harness.telegrams[0]).not.toContain("Pluto pauses at");
    expect(harness.pauses).toEqual([]);
    expect(harness.events.map((event) => event.type)).toEqual(["readiness_check"]);
  });

  it("at 9:20 ET never pauses an Off Pluto, even when a probe fails, and says it is not running", async () => {
    harness.probeFailures = { IBKR: "Gateway refused the connection" };
    await runReadinessAt("2097-07-15T13:20:10Z", state({ mode: "off" }));
    expect(harness.pauses).toEqual([]);
    expect(harness.events.map((event) => event.type)).toEqual(["readiness_check"]);
    expect(harness.telegrams[0]).toContain("Pluto is not running");
    expect(harness.saved[0]).toMatchObject({ lastRunKind: "final", finalDone: true, signature: "IBKR|Pluto running" });
  });

  it("at 9:20 ET never re-pauses a Pluto a person paused, even when a probe fails", async () => {
    harness.probeFailures = { OpenRouter: "OpenRouter refused the key (HTTP 401)" };
    await runReadinessAt("2097-07-15T13:20:10Z", state({ paused: true, pauseReason: "manual" }));
    expect(harness.pauses).toEqual([]);
    expect(harness.telegrams[0]).toContain("❌ Pluto running: paused by a person");
  });

  it("at 9:20 ET pauses a running Pluto when a probe still fails, and records why", async () => {
    harness.probeFailures = { "API sign-in": "401 from /auth/login" };
    await runReadinessAt("2097-07-15T13:20:10Z", state());
    expect(harness.pauses).toEqual(["readiness"]);
    expect(harness.events.map((event) => event.type)).toEqual(["readiness_check", "paused"]);
    expect(harness.events[1]!.payload).toMatchObject({ by: "agent", reason: "readiness", failing: ["API sign-in"] });
    expect(harness.telegrams[0]).toContain("so Pluto is paused");
  });

  it("does not pause when Pluto is paused by a person while the probes run (state read again after them)", async () => {
    harness.probeFailures = { IBKR: "no answer" };
    // First read (deciding the run) sees a running Pluto; the read after the probes sees it paused.
    await runReadinessAt("2097-07-15T13:20:10Z", state(), state({ paused: true, pauseReason: "manual" }));
    expect(harness.pauses).toEqual([]);
    expect(harness.telegrams[0]).not.toContain("so Pluto is paused");
  });

  it("at 9:20 ET with every probe passing tells an Off Pluto it is not running, never 'ready'", async () => {
    await runReadinessAt("2097-07-15T13:20:10Z", state({ mode: "off" }));
    expect(harness.telegrams[0]).toContain("Pluto is not running at the 9:20 ET check");
    expect(harness.telegrams[0]).not.toContain("ready for today");
  });

  it("says once when fixed: a re-check after an Off 6:00 ET run posts the recovery when Pluto was switched on", async () => {
    const sixAm = { dateIso: "2097-07-15", lastRunAt: "2097-07-15T10:00:30.000Z", lastRunKind: "first", signature: "Pluto running", finalDone: false, results: [] };
    await runReadinessAt("2097-07-15T10:10:40Z", state({ readiness: sixAm }));
    expect(harness.saved[0]).toMatchObject({ lastRunKind: "recheck", signature: "" });
    expect(harness.telegrams).toEqual([expect.stringContaining("passes again")]);
    // The next tick finds a passing record for today: nothing more until 9:20 ET.
    harness.telegrams = [];
    harness.saved = [];
    await runReadinessAt("2097-07-15T10:20:40Z", state({ readiness: { ...sixAm, lastRunAt: "2097-07-15T10:10:40.000Z", signature: "" } }));
    expect(harness.saved).toEqual([]);
    expect(harness.telegrams).toEqual([]);
  });

  it("stays quiet on a re-check while Pluto is still Off (same failing set)", async () => {
    const sixAm = { dateIso: "2097-07-15", lastRunAt: "2097-07-15T10:00:30.000Z", lastRunKind: "first", signature: "Pluto running", finalDone: false, results: [] };
    await runReadinessAt("2097-07-15T10:10:40Z", state({ mode: "off", readiness: sixAm }));
    expect(harness.saved).toHaveLength(1);
    expect(harness.telegrams).toEqual([]);
  });
});

describe("runReadinessIfDue calendar (audit)", () => {
  it("does nothing on a closed day, whatever the state", async () => {
    harness.openDay = false;
    await runReadinessAt("2097-07-15T10:00:30Z", state({ mode: "off" }));
    expect(harness.saved).toEqual([]);
    expect(harness.telegrams).toEqual([]);
  });

  it("uses the Eastern date across midnight UTC: 22:00 ET the evening before is not the next day's first run", async () => {
    // 2097-07-16T02:00Z is 22:00 ET on 07-15, after the final run of 07-15.
    const finalDone = { dateIso: "2097-07-15", lastRunAt: "2097-07-15T13:20:10.000Z", lastRunKind: "final", signature: "", finalDone: true, results: [] };
    await runReadinessAt("2097-07-16T02:00:00Z", state({ readiness: finalDone }));
    expect(harness.saved).toEqual([]);
    // 6:00 ET on 07-16 is a new day: yesterday's record does not count.
    await runReadinessAt("2097-07-16T10:00:30Z", state({ readiness: finalDone }));
    expect(harness.saved[0]).toMatchObject({ dateIso: "2097-07-16", lastRunKind: "first" });
  });

  it("does not run the final check twice", async () => {
    const finalDone = { dateIso: "2097-07-15", lastRunAt: "2097-07-15T13:20:10.000Z", lastRunKind: "final", signature: "Pluto running", finalDone: true, results: [] };
    await runReadinessAt("2097-07-15T13:30:00Z", state({ mode: "off", readiness: finalDone }));
    expect(harness.saved).toEqual([]);
    expect(harness.telegrams).toEqual([]);
  });
});
