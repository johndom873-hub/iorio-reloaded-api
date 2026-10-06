import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The monitor's one-minute loop against the real worker_health table of the test database. Only setInterval is faked, so the
// database keeps its real timers; every collaborator that would send or schedule something is mocked.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the ops monitor timer tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const controls = vi.hoisted(() => ({
  backgroundFailures: [] as { source: string; message: string }[],
  readinessImplementation: (async () => {}) as () => Promise<void>,
  readinessRuns: 0,
}));

vi.mock("./appEnvironment.js", () => ({ readAppEnvironment: () => "staging" }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: async () => true }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: async () => {}, loadUndeliveredAlerts: async () => [], clearUndeliveredAlerts: async () => {} }));
vi.mock("./throttledAlert.js", () => ({ notifyDownThrottled: async () => true, notifyRateLimited: async () => true }));
vi.mock("./dataInvariants.js", () => ({ loadDataInvariantInputs: async () => ({}), evaluateDataInvariants: () => [] }));
vi.mock("./backgroundFailureAlert.js", () => ({ reportBackgroundFailure: (source: string, message: string) => void controls.backgroundFailures.push({ source, message }) }));
vi.mock("./preOpenReadinessRunner.js", () => ({
  pruneOldReadinessState: async () => {},
  runPreOpenReadinessIfDue: async () => {
    controls.readinessRuns++;
    await controls.readinessImplementation();
  },
}));

const { db } = await import("../db/connection.js");
const { startOpsMonitor } = await import("./opsMonitor.js");
const { opsMonitorProcessName } = await import("./opsMonitorLiveness.js");
const testDb: Knex = db;

// A tick is a handful of quick queries; this is long enough for one to finish, so the next interval is not skipped as "still running"
// and a tick left over from one test cannot leak into the next. setTimeout is real here (only setInterval is faked).
const letTickFinish = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
const heartbeat = async () => testDb("worker_health").where({ process_name: opsMonitorProcessName }).first();
const heartbeatTicks = async () => Number((await heartbeat())?.total_reconnects ?? 0);

async function cleanUp() {
  await testDb("worker_health").where({ process_name: opsMonitorProcessName }).del();
  await testDb("alert_state").where("alert_key", "like", "digest:%").del();
  await testDb("alert_state").where("alert_key", "like", "deadline:%").del();
}

beforeEach(async () => {
  await cleanUp();
  controls.backgroundFailures.length = 0;
  controls.readinessImplementation = async () => {};
  controls.readinessRuns = 0;
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await letTickFinish();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await cleanUp();
  await testDb.destroy();
});

describe("startOpsMonitor", () => {
  it("beats at once, then again every minute, recording the environment it runs in", async () => {
    startOpsMonitor();
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(1);
    expect(await heartbeat()).toMatchObject({ connected: true, app_environment: "staging" });
    expect(Math.abs(Date.now() - new Date((await heartbeat()).updated_at).getTime())).toBeLessThan(30_000);

    await vi.advanceTimersByTimeAsync(60_000);
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(3);
  });

  it("says when it started and at what time the digest goes out, in Eastern time", () => {
    const logSpy = vi.mocked(console.log);
    startOpsMonitor();
    expect(logSpy).toHaveBeenCalledWith("Ops monitor started (job deadlines every 60s, morning digest 10:45 ET).");
  });

  it("reports a failing readiness check without stopping the heartbeat or the next tick", async () => {
    controls.readinessImplementation = async () => {
      throw new Error("worker row unreadable\nsecond line");
    };
    startOpsMonitor();
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(1);
    expect(controls.backgroundFailures).toHaveLength(1);
    expect(controls.backgroundFailures[0]).toEqual({
      source: "ops-monitor:readiness",
      message: "The pre-open readiness check hit an error and may not have run: worker row unreadable",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(2);
    expect(controls.backgroundFailures).toHaveLength(2);
  });

  it("does not start a second tick while the previous one is still running", async () => {
    let releaseSlowTick: () => void = () => {};
    controls.readinessImplementation = () => new Promise<void>((resolve) => (releaseSlowTick = resolve));
    startOpsMonitor();
    await vi.waitFor(() => expect(controls.readinessRuns).toBe(1));

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(controls.readinessRuns).toBe(1);
    expect(await heartbeatTicks()).toBe(1);

    controls.readinessImplementation = async () => {};
    releaseSlowTick();
    await letTickFinish();
    await vi.advanceTimersByTimeAsync(60_000);
    await letTickFinish();
    expect(await heartbeatTicks()).toBe(2);
  });
});
