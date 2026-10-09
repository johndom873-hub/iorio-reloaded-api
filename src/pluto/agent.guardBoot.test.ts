import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PlutoAgent.guardBoot with the state, the events table and the side effects mocked: a new release keeps Pluto's state
// outside production and pauses it in production; the crash-loop count only takes starts on the current release.

type State = { mode: "on" | "off"; paused: boolean; pauseReason: string | null; breakers: Record<string, unknown>; lastSeenRelease: string | null; readiness: null };

const harness = vi.hoisted(() => ({
  environment: "staging" as string,
  state: null as unknown as State,
  recentStartReleases: [] as string[],
  countedReleaseFilters: [] as string[],
  telegrams: [] as string[],
  events: [] as { type: string; payload: Record<string, unknown> }[],
  pauses: [] as string[],
  recordedReleases: [] as string[],
}));

vi.mock("../db/connection.js", () => {
  // db("pluto_events").where(...).where(...)[.whereRaw(release filter)].count(...): counts the scripted starts.
  const builder = () => {
    let releaseFilter: string | null = null;
    const query = {
      where: () => query,
      whereRaw: (_sql: string, bindings: string[]) => {
        releaseFilter = bindings[0]!;
        harness.countedReleaseFilters.push(releaseFilter);
        return query;
      },
      count: async () => [{ count: String(harness.recentStartReleases.filter((release) => releaseFilter === null || release === releaseFilter).length) }],
    };
    return query;
  };
  return { db: Object.assign(builder, { raw: () => "", fn: { now: () => "now()" } }) };
});
vi.mock("../ibkr/marketDataPool.js", () => ({ marketDataPoolSnapshot: () => ({ contractCount: 0 }) }));
vi.mock("../ibkr/sharedReadConnection.js", () => {
  const connection = { getHealthSnapshot: () => ({ connected: true, totalReconnects: 0 }), listenerCount: () => 0 };
  return { sharedLiveConnection: connection, sharedReadConnection: connection };
});
vi.mock("../lib/processMemoryMonitor.js", () => ({ startProcessMemoryMonitor: () => () => {} }));
vi.mock("../lib/appEnvironment.js", () => ({ readAppEnvironment: () => harness.environment }));
vi.mock("../lib/internalApiClient.js", () => ({ InternalApiClient: class {} }));
vi.mock("../lib/notificationBroadcaster.js", () => ({ startNotificationBroadcaster: () => {}, subscribeToNotifications: () => () => {} }));
vi.mock("../lib/notifyTelegram.js", () => ({
  notifyPlutoTelegram: vi.fn(async (message: string) => {
    harness.telegrams.push(message);
    return true;
  }),
  notifyTelegram: vi.fn(async () => true),
}));
vi.mock("../lib/readGitSha.js", () => ({ readGitSha: () => null }));
vi.mock("./ledger.js", () => ({
  closeAbandonedPlutoPasses: vi.fn(async () => 0),
  recordPlutoEvent: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
    harness.events.push({ type, payload });
  }),
}));
vi.mock("./marketWatch.js", () => ({ PlutoMarketWatch: class {} }));
vi.mock("./stateStore.js", () => ({
  describePlutoBlock: () => null,
  loadPlutoState: vi.fn(async () => harness.state),
  pausePluto: vi.fn(async (kind: string) => {
    harness.pauses.push(kind);
    harness.state = { ...harness.state, paused: true, pauseReason: kind };
  }),
  recordPlutoRelease: vi.fn(async (release: string) => {
    harness.recordedReleases.push(release);
  }),
  savePlutoReadiness: vi.fn(),
}));

const { PlutoAgent } = await import("./agent.js");

const config = { apiBaseUrl: "http://127.0.0.1:1", serviceUsername: "pluto", serviceUserPassword: "x", serviceLoginSecret: "x", openRouterApiKey: "k", telegramBotToken: "t" };

function state(overrides: Partial<State> = {}): State {
  return { mode: "on", paused: false, pauseReason: null, breakers: {}, lastSeenRelease: "v185", readiness: null, ...overrides };
}

async function bootOnRelease(release: string, environment: string, initialState: State): Promise<void> {
  vi.stubEnv("HEROKU_RELEASE_VERSION", release);
  harness.environment = environment;
  harness.state = initialState;
  const agent = new PlutoAgent(config) as unknown as { settings: { crashLoopRestartsPerHour: number }; guardBoot(): Promise<void> };
  agent.settings = { crashLoopRestartsPerHour: 3 };
  await agent.guardBoot();
}

beforeEach(() => {
  harness.recentStartReleases = [];
  harness.countedReleaseFilters = [];
  harness.telegrams = [];
  harness.events = [];
  harness.pauses = [];
  harness.recordedReleases = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("guardBoot on a new release", () => {
  it("keeps a running Pluto running outside production, and records the release", async () => {
    harness.recentStartReleases = ["v186"];
    await bootOnRelease("v186", "staging", state());
    expect(harness.pauses).toEqual([]);
    expect(harness.telegrams).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state.paused).toBe(false);
    expect(harness.recordedReleases).toEqual(["v186"]);
  });

  it("keeps a person's pause and its reason outside production, without a warning", async () => {
    harness.recentStartReleases = ["v186"];
    await bootOnRelease("v186", "staging", state({ paused: true, pauseReason: "manual" }));
    expect(harness.pauses).toEqual([]);
    expect(harness.events).toEqual([]);
    expect(harness.state).toMatchObject({ paused: true, pauseReason: "manual" });
  });

  it("still pauses a running Pluto in production and says so", async () => {
    harness.recentStartReleases = ["v186"];
    await bootOnRelease("v186", "production", state());
    expect(harness.pauses).toEqual(["deploy"]);
    expect(harness.events).toEqual([{ type: "paused", payload: { by: "agent", reason: "deploy", from: "v185", to: "v186" } }]);
    expect(harness.telegrams[0]).toContain("Pluto paused after a deploy");
  });
});

describe("guardBoot crash-loop count", () => {
  it("does not count starts on earlier releases, so three deploys in an hour are not a crash loop", async () => {
    harness.recentStartReleases = ["v184", "v185", "v186"];
    await bootOnRelease("v186", "staging", state());
    expect(harness.countedReleaseFilters).toEqual(["v186"]);
    expect(harness.pauses).toEqual([]);
  });

  it("pauses when the same release keeps restarting", async () => {
    harness.recentStartReleases = ["v186", "v186", "v186"];
    await bootOnRelease("v186", "staging", state({ lastSeenRelease: "v186" }));
    expect(harness.pauses).toEqual(["crash_loop"]);
    expect(harness.events).toEqual([{ type: "paused", payload: { by: "agent", reason: "crash_loop", startsInLastHour: 3 } }]);
    expect(harness.telegrams[0]).toContain("crash loop?");
  });
});
