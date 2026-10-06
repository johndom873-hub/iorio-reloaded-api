import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real systemHealthRouter on a small express app against the test database. Everything that reaches IBKR, the VPS or in-process
// singletons of other subsystems (health-check job, readiness collectors, market-data pool, Day Signals loop) is mocked; the rows the
// loaders read (job_runs, worker_health, order_requests, platform_controls, users, tickers, chat messages) are real.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run system health route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 6 } }) };
});

const runIbkrHealthCheckJobMock = vi.fn();
vi.mock("../ibkr/checkIbkrHealthJob.js", () => ({ runIbkrHealthCheckJob: (...args: unknown[]) => runIbkrHealthCheckJobMock(...args) }));

const computeMarketSessionStatusMock = vi.fn();
vi.mock("../lib/marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/marketSessionStatus.js")>("../lib/marketSessionStatus.js");
  return { ...actual, computeMarketSessionStatus: (...args: unknown[]) => computeMarketSessionStatusMock(...args) };
});

const collectReadinessChecksMock = vi.fn();
const createDefaultReadinessDependenciesMock = vi.fn();
vi.mock("../lib/preOpenReadinessCollectors.js", () => ({
  collectReadinessChecks: (...args: unknown[]) => collectReadinessChecksMock(...args),
  createDefaultReadinessDependencies: (...args: unknown[]) => createDefaultReadinessDependenciesMock(...args),
}));

const daySignalsLoopStatusMock = vi.fn();
vi.mock("../lib/daySignalsLoop.js", () => ({ daySignalsLoopStatus: () => daySignalsLoopStatusMock() }));

const loadDayQuotesStatusMock = vi.fn();
vi.mock("../lib/daySignalsStore.js", () => ({ loadDayQuotesStatus: () => loadDayQuotesStatusMock() }));

const marketDataPoolSnapshotMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", () => ({ marketDataPoolSnapshot: () => marketDataPoolSnapshotMock() }));

const loadActiveMarketDataLineReservationsMock = vi.fn();
const loadMarketDataLineRestrictionMock = vi.fn();
vi.mock("../ibkr/marketDataLineBudget.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/marketDataLineBudget.js")>("../ibkr/marketDataLineBudget.js");
  return {
    ...actual,
    loadActiveMarketDataLineReservations: () => loadActiveMarketDataLineReservationsMock(),
    loadMarketDataLineRestriction: (...args: unknown[]) => loadMarketDataLineRestrictionMock(...args),
  };
});

const { db } = await import("../db/connection.js");
const { systemHealthRouter } = await import("./systemHealth.js");
const presenceTracker = await import("../lib/presenceTracker.js");
const llmStats = await import("../genosuke/llmStats.js");
const { requestRateMiddleware } = await import("../lib/requestRateTracker.js");

const testDb: Knex = db;
const runLabel = `syshealthtest${Date.now()}`;
const gatewayProcessName = "ibkr_gateway_worker";
const hasUnplannedDropsColumn = await testDb.schema.hasColumn("worker_health", "unplanned_drops_last_24h");

let server: Server;
let baseUrl: string;
let userId: string;
const extraUserIds: string[] = [];
const createdTickerIds: string[] = [];
const createdJobRunIds: string[] = [];
let originalWorkerRow: Record<string, unknown> | undefined;
let originalHaltRow: Record<string, unknown> | undefined;
let tickerCounter = Date.now() % 100_000;
const savedEnvironment = { dbPlanMaxSizeBytes: process.env.DB_PLAN_MAX_SIZE_BYTES, genosukeModel: process.env.GENOSUKE_MODEL };

beforeAll(async () => {
  originalWorkerRow = await testDb("worker_health").where({ process_name: gatewayProcessName }).first();
  originalHaltRow = await testDb("platform_controls").where({ key: "trading_halt" }).first();
  const [user] = await testDb("users").insert({ username: `${runLabel}-main`, display_name: "System Health Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use(express.json());
  app.use(requestRateMiddleware);
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/system-health", systemHealthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  process.env.DB_PLAN_MAX_SIZE_BYTES = "5000000000";
  process.env.GENOSUKE_MODEL = "test/model-x";
  runIbkrHealthCheckJobMock.mockReset().mockResolvedValue(undefined);
  computeMarketSessionStatusMock.mockReset().mockResolvedValue({ state: "closed", label: "opens in 3h", nextChangeAt: "2030-01-02T14:30:00.000Z" });
  collectReadinessChecksMock.mockReset().mockResolvedValue([]);
  createDefaultReadinessDependenciesMock.mockReset().mockReturnValue({ marker: "default-dependencies" });
  daySignalsLoopStatusMock.mockReset().mockReturnValue(null);
  loadDayQuotesStatusMock.mockReset().mockResolvedValue({ tradingDateIso: null, quoteCount: 0, oldestQuotedAt: null, newestQuotedAt: null, expiryCount: 0, tickerCount: 0 });
  marketDataPoolSnapshotMock.mockReset().mockReturnValue({ contractCount: 0, subscriberCount: 0, pausedCount: 0, openLineCount: 0, restricted: false });
  loadActiveMarketDataLineReservationsMock.mockReset().mockResolvedValue([]);
  loadMarketDataLineRestrictionMock.mockReset().mockResolvedValue(null);
  await testDb("platform_controls").insert({ key: "trading_halt", enabled: false, reason: null, set_by_user_id: null }).onConflict("key").merge({ enabled: false, reason: null, set_by_user_id: null });
  await testDb("worker_health").where({ process_name: gatewayProcessName }).del();
});

afterEach(async () => {
  for (const connectedUserId of presenceTracker.onlineUserIds()) {
    while (presenceTracker.onlineUserIds().includes(connectedUserId)) presenceTracker.disconnect(connectedUserId);
  }
  await testDb("job_runs").where("job_name", "like", `${runLabel}%`).del();
  if (createdJobRunIds.length > 0) await testDb("job_runs").whereIn("id", createdJobRunIds).del();
  createdJobRunIds.length = 0;
  await testDb("order_requests").whereIn("requested_by_user_id", [userId, ...extraUserIds]).del();
  await testDb("genosuke_chat_messages").where("chat_id", "like", `${runLabel}%`).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdTickerIds.length = 0;
  await testDb("users").whereIn("id", extraUserIds).del();
  extraUserIds.length = 0;
  vi.restoreAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("worker_health").where({ process_name: gatewayProcessName }).del();
  if (originalWorkerRow) await testDb("worker_health").insert(originalWorkerRow);
  if (originalHaltRow) await testDb("platform_controls").insert(originalHaltRow).onConflict("key").merge();
  await testDb("users").where({ id: userId }).del();
  restoreEnvironmentVariable("DB_PLAN_MAX_SIZE_BYTES", savedEnvironment.dbPlanMaxSizeBytes);
  restoreEnvironmentVariable("GENOSUKE_MODEL", savedEnvironment.genosukeModel);
  await testDb.destroy();
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function call(method: "GET" | "POST", path: string, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}/system-health${path}`, { method, headers: asUser ? { "x-test-user-id": asUser } : {} });
  return { status: response.status, contentType: response.headers.get("content-type") ?? "", text: await response.text() };
}

async function callJson(path: string, options: { asUser?: string | null } = {}) {
  const response = await call("GET", path, options);
  return { status: response.status, json: JSON.parse(response.text) as any };
}

// A streamed route answers 200 with an event stream whose last "data:" frame carries the real status and body.
async function callStreamed(method: "GET" | "POST", path: string) {
  const response = await call(method, path);
  expect(response.status).toBe(200);
  expect(response.contentType).toContain("text/event-stream");
  const frames = response.text.split("\n\n").filter((frame) => frame.startsWith("data: "));
  expect(frames).toHaveLength(1);
  return JSON.parse(frames[0]!.slice("data: ".length)) as { status: number; body: any };
}

async function insertUser(label: string, lastSeenAt: Date | null): Promise<string> {
  const [user] = await testDb("users").insert({ username: `${runLabel}-${label}`, display_name: `Health ${label}`, password_hash: "not-a-real-hash", last_seen_at: lastSeenAt }).returning("id");
  extraUserIds.push(user.id);
  return user.id;
}

async function insertTicker(primaryExchange: string | null): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `SH${(tickerCounter += 1)}`, company_name: "System Health Test Co", primary_exchange: primaryExchange }).returning("id");
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

async function insertJobRun(jobName: string, startedAt: Date, overrides: Record<string, unknown> = {}): Promise<string> {
  const [row] = await testDb("job_runs").insert({ job_name: jobName, started_at: startedAt, status: "success", finished_at: new Date(startedAt.getTime() + 1000), ...overrides }).returning("id");
  return row.id;
}

const farFutureStart = Date.UTC(2200, 0, 1);

const protectedRoutes: [string, string][] = [
  ["GET", "/jobs"],
  ["GET", "/status"],
  ["POST", "/check-ibkr"],
  ["GET", "/readiness"],
  ["GET", "/presence"],
  ["GET", "/db"],
  ["GET", "/market-status"],
  ["GET", "/day-signals"],
  ["GET", "/genosuke"],
  ["GET", "/web-dyno"],
  ["GET", "/gateway"],
  ["GET", "/summary"],
];

describe("authentication", () => {
  it.each(protectedRoutes)("%s %s is refused without a session", async (method, path) => {
    const response = await call(method as "GET" | "POST", path, { asUser: null });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.text)).toEqual({ error: "Not logged in." });
  });

  it("the manual health check does not run for an unauthenticated caller", async () => {
    await call("POST", "/check-ibkr", { asUser: null });
    expect(runIbkrHealthCheckJobMock).not.toHaveBeenCalled();
    expect(computeMarketSessionStatusMock).not.toHaveBeenCalled();
  });
});

describe("GET /system-health/jobs", () => {
  it("returns job runs newest first with the camel-cased columns", async () => {
    const jobName = `${runLabel}-jobs-shape`;
    await insertJobRun(jobName, new Date(farFutureStart), { status: "failure", error_message: "boom", details: { rows: 3 } });
    await insertJobRun(jobName, new Date(farFutureStart + 60_000), { status: "success", finished_at: null });

    const { status, json } = await callJson("/jobs?limit=2");
    expect(status).toBe(200);
    expect(json).toHaveLength(2);
    expect(json[0]).toEqual({ id: expect.any(String), jobName, startedAt: "2200-01-01T00:01:00.000Z", finishedAt: null, status: "success", errorMessage: null, details: null });
    expect(json[1]).toEqual({ id: expect.any(String), jobName, startedAt: "2200-01-01T00:00:00.000Z", finishedAt: "2200-01-01T00:00:01.000Z", status: "failure", errorMessage: "boom", details: { rows: 3 } });
  });

  describe("limit", () => {
    beforeEach(async () => {
      const rows = Array.from({ length: 205 }, (_unused, index) => ({
        job_name: `${runLabel}-jobs-limit-${index}`,
        started_at: new Date(farFutureStart + index * 1000),
        status: "success",
      }));
      await testDb("job_runs").insert(rows);
    });

    it("defaults to 50 rows", async () => {
      const { json } = await callJson("/jobs");
      expect(json).toHaveLength(50);
      expect(json[0].jobName).toBe(`${runLabel}-jobs-limit-204`);
      expect(json[49].jobName).toBe(`${runLabel}-jobs-limit-155`);
    });

    it("honours a smaller limit", async () => {
      const { json } = await callJson("/jobs?limit=3");
      expect(json.map((row: { jobName: string }) => row.jobName)).toEqual([`${runLabel}-jobs-limit-204`, `${runLabel}-jobs-limit-203`, `${runLabel}-jobs-limit-202`]);
    });

    it("caps the limit at 200 rows", async () => {
      expect((await callJson("/jobs?limit=1000")).json).toHaveLength(200);
      expect((await callJson("/jobs?limit=200")).json).toHaveLength(200);
    });

    it.each([["a limit that is not a number", "abc"], ["a limit of zero", "0"], ["an empty limit", ""]])("falls back to 50 rows for %s", async (_label, limit) => {
      expect((await callJson(`/jobs?limit=${limit}`)).json).toHaveLength(50);
    });
  });
});

describe("GET /system-health/status", () => {
  it("returns only the latest run per job name", async () => {
    const jobA = `${runLabel}-status-a`;
    const jobB = `${runLabel}-status-b`;
    await insertJobRun(jobA, new Date(farFutureStart), { status: "failure", error_message: "old failure" });
    const latestAId = await insertJobRun(jobA, new Date(farFutureStart + 60_000), { status: "success" });
    const onlyBId = await insertJobRun(jobB, new Date(farFutureStart + 5_000), { status: "success", details: { checked: true } });

    const { status, json } = await callJson("/status");
    expect(status).toBe(200);
    const mine = (json as { jobName: string }[]).filter((row) => row.jobName.startsWith(runLabel));
    expect(mine.map((row) => row.jobName)).toEqual([jobA, jobB]);
    expect(mine[0]).toEqual({ id: latestAId, jobName: jobA, startedAt: "2200-01-01T00:01:00.000Z", finishedAt: "2200-01-01T00:01:01.000Z", status: "success", errorMessage: null, details: null });
    expect(mine[1]).toMatchObject({ id: onlyBId, details: { checked: true } });
  });

  it("is sorted by job name", async () => {
    const { json } = await callJson("/status");
    const names = (json as { jobName: string }[]).map((row) => row.jobName);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});

describe("POST /system-health/check-ibkr", () => {
  async function insertLatestHealthCheckRun(overrides: Record<string, unknown> = {}): Promise<string> {
    const id = await insertJobRun("ibkr_health_check", new Date(farFutureStart), overrides);
    createdJobRunIds.push(id);
    return id;
  }

  it("runs the check as a manual run by the caller and answers with the newest ibkr_health_check row", async () => {
    const rowId = await insertLatestHealthCheckRun({ status: "success", details: { gateway: "up" } });

    const frame = await callStreamed("POST", "/check-ibkr");
    expect(runIbkrHealthCheckJobMock).toHaveBeenCalledTimes(1);
    expect(runIbkrHealthCheckJobMock).toHaveBeenCalledWith({ allowGatewayRestart: true, triggeredBy: "manual", triggeredByUserId: userId });
    expect(frame.status).toBe(200);
    expect(frame.body).toEqual({ id: rowId, jobName: "ibkr_health_check", startedAt: "2200-01-01T00:00:00.000Z", finishedAt: "2200-01-01T00:00:01.000Z", status: "success", errorMessage: null, details: { gateway: "up" } });
  });

  it("forbids a Gateway restart while the market is open", async () => {
    await insertLatestHealthCheckRun();
    computeMarketSessionStatusMock.mockResolvedValue({ state: "open", label: "closes in 1h", nextChangeAt: "2030-01-02T21:00:00.000Z" });

    await callStreamed("POST", "/check-ibkr");
    expect(runIbkrHealthCheckJobMock).toHaveBeenCalledWith({ allowGatewayRestart: false, triggeredBy: "manual", triggeredByUserId: userId });
  });

  it.each(["pre-market", "after-hours", "closed"])("allows a Gateway restart in the %s state", async (state) => {
    await insertLatestHealthCheckRun();
    computeMarketSessionStatusMock.mockResolvedValue({ state, label: "x", nextChangeAt: "2030-01-02T21:00:00.000Z" });

    await callStreamed("POST", "/check-ibkr");
    expect(runIbkrHealthCheckJobMock.mock.calls[0]?.[0]).toMatchObject({ allowGatewayRestart: true });
  });

  it("swallows a failing check and still answers with the logged row", async () => {
    const rowId = await insertLatestHealthCheckRun({ status: "failure", error_message: "Gateway unreachable" });
    runIbkrHealthCheckJobMock.mockRejectedValue(new Error("Gateway unreachable"));

    const frame = await callStreamed("POST", "/check-ibkr");
    expect(frame.status).toBe(200);
    expect(frame.body).toMatchObject({ id: rowId, status: "failure", errorMessage: "Gateway unreachable" });
  });

  it("swallows a failing market-state lookup without running the check", async () => {
    const rowId = await insertLatestHealthCheckRun();
    computeMarketSessionStatusMock.mockRejectedValue(new Error("calendar down"));

    const frame = await callStreamed("POST", "/check-ibkr");
    expect(runIbkrHealthCheckJobMock).not.toHaveBeenCalled();
    expect(frame).toMatchObject({ status: 200, body: { id: rowId } });
  });
});

describe("GET /system-health/readiness", () => {
  const checks = [
    { name: "Gateway", status: "ok", detail: "connected" },
    { name: "Calendar", status: "warn", detail: "stale" },
    { name: "Worker", status: "fail", detail: "offline" },
    { name: "Account", status: "fail", detail: "mismatch" },
  ];

  it("runs the pre-open stage by default and answers with the verdict without the signature", async () => {
    collectReadinessChecksMock.mockResolvedValue(checks);

    const frame = await callStreamed("GET", "/readiness");
    expect(frame.status).toBe(200);
    expect(frame.body).toEqual({
      stage: "pre_open",
      checkedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      ready: false,
      failing: [checks[2], checks[3]],
      warnings: [checks[1]],
      passing: [checks[0]],
    });
    expect(frame.body).not.toHaveProperty("signature");
    expect(collectReadinessChecksMock).toHaveBeenCalledTimes(1);
    const [stage, checkedAt, dependencies] = collectReadinessChecksMock.mock.calls[0]!;
    expect(stage).toBe("pre_open");
    expect(checkedAt).toBeInstanceOf(Date);
    expect(dependencies).toEqual({ marker: "default-dependencies" });
    expect(frame.body.checkedAt).toBe((checkedAt as Date).toISOString());
  });

  it("runs the open stage when asked for stage=open", async () => {
    collectReadinessChecksMock.mockResolvedValue([checks[0]]);

    const frame = await callStreamed("GET", "/readiness?stage=open");
    expect(collectReadinessChecksMock.mock.calls[0]?.[0]).toBe("open");
    expect(frame.body).toMatchObject({ stage: "open", ready: true, failing: [], warnings: [], passing: [checks[0]] });
  });

  it("treats any other stage value as pre-open", async () => {
    const frame = await callStreamed("GET", "/readiness?stage=OPEN");
    expect(frame.body.stage).toBe("pre_open");
    expect(collectReadinessChecksMock.mock.calls[0]?.[0]).toBe("pre_open");
  });

  it("is ready when no check fails", async () => {
    collectReadinessChecksMock.mockResolvedValue([checks[0], checks[1]]);
    expect((await callStreamed("GET", "/readiness")).body.ready).toBe(true);
  });

  it("answers a failing collector with a 500 frame carrying the message", async () => {
    collectReadinessChecksMock.mockRejectedValue(new Error("collector exploded"));
    expect(await callStreamed("GET", "/readiness")).toEqual({ status: 500, body: { error: "collector exploded" } });
  });
});

describe("GET /system-health/presence", () => {
  it("lists online users first, then by most recent activity, and keeps only three", async () => {
    const now = Date.now();
    const olderId = await insertUser("online-old", new Date(now - 10 * 60_000));
    const newestId = await insertUser("online-new", new Date(now - 60_000));
    const neverSeenId = await insertUser("online-never", null);
    const middleId = await insertUser("online-middle", new Date(now - 5 * 60_000));
    for (const id of [olderId, newestId, neverSeenId, middleId]) presenceTracker.connect(id);

    const { status, json } = await callJson("/presence");
    expect(status).toBe(200);
    expect(json.users.map((user: { id: string }) => user.id)).toEqual([newestId, middleId, olderId]);
    expect(json.users[0]).toEqual({ id: newestId, displayName: "Health online-new", online: true, lastSeenAt: new Date(now - 60_000).toISOString() });
  });

  it("puts an online user without any recorded activity after online users that have one", async () => {
    const seenId = await insertUser("online-seen", new Date(Date.now() - 60_000));
    const neverSeenId = await insertUser("online-never", null);
    presenceTracker.connect(neverSeenId);
    presenceTracker.connect(seenId);

    const { json } = await callJson("/presence");
    expect(json.users.slice(0, 2)).toEqual([
      expect.objectContaining({ id: seenId, online: true }),
      { id: neverSeenId, displayName: "Health online-never", online: true, lastSeenAt: null },
    ]);
  });

  it("shows an offline user with a last-active time after the online ones and leaves out an offline user never seen", async () => {
    const onlineId = await insertUser("online", new Date(Date.now() - 60_000));
    const offlineSeenId = await insertUser("offline-seen", new Date(Date.UTC(2300, 0, 1)));
    const offlineNeverId = await insertUser("offline-never", null);
    presenceTracker.connect(onlineId);

    const { json } = await callJson("/presence");
    const ids = json.users.map((user: { id: string }) => user.id);
    expect(ids.slice(0, 2)).toEqual([onlineId, offlineSeenId]);
    expect(json.users[1]).toEqual({ id: offlineSeenId, displayName: "Health offline-seen", online: false, lastSeenAt: "2300-01-01T00:00:00.000Z" });
    expect(ids).not.toContain(offlineNeverId);
  });

  it("counts a user with two open tabs once", async () => {
    const onlineId = await insertUser("two-tabs", new Date(Date.now() - 60_000));
    presenceTracker.connect(onlineId);
    presenceTracker.connect(onlineId);

    const { json } = await callJson("/presence");
    expect(json.users.filter((user: { id: string }) => user.id === onlineId)).toHaveLength(1);
  });
});

describe("GET /system-health/db", () => {
  it("reports connection counts, database size, the configured plan size and query timing", async () => {
    const roleLimitRow = await testDb.raw(
      `SELECT CASE WHEN rolconnlimit > 0 THEN rolconnlimit ELSE current_setting('max_connections')::int END AS "maxConnections" FROM pg_roles WHERE rolname = current_user`,
    );

    const { status, json } = await callJson("/db");
    expect(status).toBe(200);
    expect(json.totalConnections).toMatch(/^[1-9]\d*$/);
    expect(json.maxConnections).toBe(roleLimitRow.rows[0].maxConnections);
    expect(json.databaseSizeBytes).toMatch(/^[1-9]\d*$/);
    expect(json.maxDatabaseSizeBytes).toBe("5000000000");
    expect(json.responseTime).toEqual({ averageMs: null, slowestMs: null });
  });

  it("passes the plan size through exactly as configured", async () => {
    process.env.DB_PLAN_MAX_SIZE_BYTES = "123";
    expect((await callJson("/db")).json.maxDatabaseSizeBytes).toBe("123");
  });

  it("answers 500 when the plan size is not configured", async () => {
    delete process.env.DB_PLAN_MAX_SIZE_BYTES;
    expect((await call("GET", "/db")).status).toBe(500);
  });
});

describe("GET /system-health/market-status", () => {
  it("translates IBKR's ISLAND to NASDAQ, de-duplicates, sorts, and falls back to US Markets for a blank exchange", async () => {
    const uniqueExchange = `ZZ${runLabel}`;
    await insertTicker("ISLAND");
    await insertTicker("NASDAQ");
    await insertTicker(uniqueExchange);
    await insertTicker("");
    await insertTicker(null);

    const { status, json } = await callJson("/market-status");
    expect(status).toBe(200);
    expect(json.exchanges).toContain("NASDAQ");
    expect(json.exchanges).not.toContain("ISLAND");
    expect(json.exchanges).toContain(uniqueExchange);
    expect(json.exchanges).toContain("US Markets");
    expect(json.exchanges.filter((name: string) => name === "NASDAQ")).toHaveLength(1);
    expect(json.exchanges).not.toContain("");
    expect(json.exchanges).toEqual([...new Set<string>(json.exchanges)].sort());
  });

  it("answers with the session state, label and next change from the shared session computation", async () => {
    computeMarketSessionStatusMock.mockResolvedValue({ state: "open", label: "closes in 2h 5m", nextChangeAt: "2030-03-04T21:00:00.000Z" });

    const { json } = await callJson("/market-status");
    expect(json).toMatchObject({ state: "open", label: "closes in 2h 5m", nextChangeAt: "2030-03-04T21:00:00.000Z" });
    expect(computeMarketSessionStatusMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /system-health/day-signals", () => {
  it("combines the loop state, the day tables' contents, the pool snapshot and the line restriction", async () => {
    const loop = { state: "running", reason: "market open", stateSince: "2030-01-02T14:30:00.000Z", tradingDateIso: "2030-01-02", cycleNumber: 4, cycleStartedAt: null, lastCycleDurationMs: 1200, contractsInPool: 80, lastError: null };
    const quotes = { tradingDateIso: "2030-01-02", quoteCount: 80, oldestQuotedAt: "2030-01-02T14:31:00.000Z", newestQuotedAt: "2030-01-02T14:32:00.000Z", expiryCount: 12, tickerCount: 6 };
    const pool = { contractCount: 3, subscriberCount: 4, pausedCount: 1, openLineCount: 2, restricted: true };
    const restriction = { priorityLines: 60, holders: ["optionChainCapture"] };
    daySignalsLoopStatusMock.mockReturnValue(loop);
    loadDayQuotesStatusMock.mockResolvedValue(quotes);
    marketDataPoolSnapshotMock.mockReturnValue(pool);
    loadMarketDataLineRestrictionMock.mockResolvedValue(restriction);

    expect(await callJson("/day-signals")).toEqual({ status: 200, json: { loop, quotes, marketDataPool: pool, marketDataRestriction: restriction } });
    expect(loadMarketDataLineRestrictionMock).toHaveBeenCalledWith();
  });

  it("reports a null loop when this process is not running it", async () => {
    const { json } = await callJson("/day-signals");
    expect(json.loop).toBeNull();
    expect(json.marketDataRestriction).toBeNull();
  });
});

describe("GET /system-health/genosuke", () => {
  async function insertChatMessage(chatLabel: string, role: string, createdAt: Date): Promise<void> {
    await testDb("genosuke_chat_messages").insert({ chat_id: `${runLabel}-${chatLabel}`, role, content: "x", created_at: createdAt });
  }

  it("counts today's assistant messages and the distinct chats active in the last 24 hours", async () => {
    const before = (await callJson("/genosuke")).json;
    const now = new Date();
    await insertChatMessage("a", "assistant", now);
    await insertChatMessage("a", "assistant", now);
    await insertChatMessage("a", "user", now);
    await insertChatMessage("b", "assistant", now);
    await insertChatMessage("old-3-days", "assistant", new Date(now.getTime() - 3 * 24 * 3600_000));
    await insertChatMessage("old-25-hours", "user", new Date(now.getTime() - 25 * 3600_000));
    await insertChatMessage("user-only", "user", now);

    const after = (await callJson("/genosuke")).json;
    expect(Number(after.messagesToday) - Number(before.messagesToday)).toBe(3);
    expect(Number(after.activeSessions) - Number(before.activeSessions)).toBe(3);
  });

  it("reports the configured model and the rolling LLM stats", async () => {
    const empty = (await callJson("/genosuke")).json.llm;
    expect(empty).toEqual({ model: "test/model-x", callsPerMinute: 0, avgLatencyMs: null });

    llmStats.record(100);
    llmStats.record(201);
    expect((await callJson("/genosuke")).json.llm).toEqual({ model: "test/model-x", callsPerMinute: 0.1, avgLatencyMs: 151 });
  });

  it("reports a null model when none is configured", async () => {
    delete process.env.GENOSUKE_MODEL;
    expect((await callJson("/genosuke")).json.llm.model).toBeNull();
  });
});

describe("GET /system-health/web-dyno", () => {
  it("reports request rate, uptime, start time, notification-stream connections and the multiplexer stats", async () => {
    const [firstUser, secondUser] = [await insertUser("stream-1", null), await insertUser("stream-2", null)];
    presenceTracker.connect(firstUser);
    presenceTracker.connect(firstUser);
    presenceTracker.connect(secondUser);

    const { status, json } = await callJson("/web-dyno");
    expect(status).toBe(200);
    expect(json.notificationStreamConnections).toBe(3);
    expect(json.streamMultiplexer).toEqual({ connectionCount: 0, subscriptionCountByKind: {} });
    expect(json.requestsPerMinute).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(json.uptimeSeconds)).toBe(true);
    expect(Math.abs(json.uptimeSeconds - process.uptime())).toBeLessThan(5);
    expect(new Date(json.processStartedAt).toISOString()).toBe(json.processStartedAt);
  });

  it("counts every request in the rolling minute, including its own", async () => {
    const first = (await callJson("/web-dyno")).json.requestsPerMinute;
    const second = (await callJson("/web-dyno")).json.requestsPerMinute;
    expect(second).toBe(first + 1);
  });
});

describe("GET /system-health/gateway", () => {
  const countInFlightOrders = async () =>
    Number((await testDb("order_requests").whereIn("status", ["confirmed", "submitted", "cancel_requested"]).count("* as count").first())?.count ?? 0);

  async function insertWorkerRow(overrides: Record<string, unknown> = {}): Promise<void> {
    await testDb("worker_health").insert({
      process_name: gatewayProcessName,
      connected: true,
      uptime_ms: 3_600_000,
      total_reconnects: 4,
      last_system_status_code: 1102,
      client_id: 77,
      updated_at: new Date("2030-01-02T03:04:05.000Z"),
      ...overrides,
    });
  }

  async function insertOrderWithStatus(status: string): Promise<void> {
    await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "open_position", payload: {}, status });
  }

  it("with no worker row reports the worker missing and still counts in-flight orders", async () => {
    const before = await countInFlightOrders();
    await insertOrderWithStatus("confirmed");

    const { status, json } = await callJson("/gateway");
    expect(status).toBe(200);
    expect(json).toEqual({ connected: false, staleOrMissing: true, inFlightOrderCount: before + 1, tradingHalted: false });
  });

  it("with no worker row still reports a trading halt", async () => {
    await testDb("platform_controls").where({ key: "trading_halt" }).update({ enabled: true, reason: "test halt", set_by_user_id: userId });
    expect((await callJson("/gateway")).json).toMatchObject({ staleOrMissing: true, tradingHalted: true });
  });

  it("reports the worker row's fields with numbers converted and no stale flag", async () => {
    await insertWorkerRow();
    const inFlight = await countInFlightOrders();

    const { json } = await callJson("/gateway");
    expect(json).toEqual({
      connected: true,
      tradingHalted: false,
      uptimeMs: 3_600_000,
      totalReconnects: 4,
      unplannedDropsLast24h: null,
      lastSystemStatusCode: 1102,
      clientId: 77,
      updatedAt: "2030-01-02T03:04:05.000Z",
      inFlightOrderCount: inFlight,
      marketDataLines: { inUse: 0, budget: 90, byUse: [] },
      staleOrMissing: false,
    });
  });

  it.skipIf(!hasUnplannedDropsColumn)("reports the unplanned drop count when the worker row carries one", async () => {
    await insertWorkerRow({ unplanned_drops_last_24h: 2 });
    expect((await callJson("/gateway")).json.unplannedDropsLast24h).toBe(2);
  });

  it("reports a null uptime for a worker that has not reported one, and a disconnected worker as disconnected", async () => {
    await insertWorkerRow({ uptime_ms: null, connected: false, last_system_status_code: null, client_id: null });

    const { json } = await callJson("/gateway");
    expect(json).toMatchObject({ connected: false, uptimeMs: null, lastSystemStatusCode: null, clientId: null, staleOrMissing: false });
  });

  it("reports the trading halt switch", async () => {
    await insertWorkerRow();
    await testDb("platform_controls").where({ key: "trading_halt" }).update({ enabled: true, reason: "test halt", set_by_user_id: userId });
    expect((await callJson("/gateway")).json.tradingHalted).toBe(true);
  });

  it("counts only confirmed, submitted and cancel_requested orders as in flight", async () => {
    await insertWorkerRow();
    const before = await countInFlightOrders();
    for (const status of ["confirmed", "submitted", "cancel_requested", "pending_confirmation", "filled", "partially_filled", "cancelled", "rejected", "error", "cancelled_partially_filled"]) {
      await insertOrderWithStatus(status);
    }

    expect((await callJson("/gateway")).json.inFlightOrderCount).toBe(before + 3);
  });

  it("summarises market-data line usage across holders against the shared budget", async () => {
    await insertWorkerRow();
    loadActiveMarketDataLineReservationsMock.mockResolvedValue([
      { holder: "marketDataPool:abc", lines: 5 },
      { holder: "optionChainCapture", lines: 40 },
      { holder: "daySignalsLoop", lines: 10 },
      { holder: "snapshot:AAPL", lines: 2 },
      { holder: "somethingElse", lines: 3 },
    ]);
    marketDataPoolSnapshotMock.mockReturnValue({ contractCount: 9, subscriberCount: 9, pausedCount: 0, openLineCount: 7, restricted: false });

    const { json } = await callJson("/gateway");
    expect(json.marketDataLines).toEqual({
      inUse: 62,
      budget: 90,
      byUse: [
        { label: "Screens", lines: 7 },
        { label: "Chain capture", lines: 40 },
        { label: "Day Signals", lines: 10 },
        { label: "Snapshots", lines: 2 },
        { label: "somethingElse", lines: 3 },
      ],
    });
  });

  it("answers 500 when the reservations cannot be read", async () => {
    await insertWorkerRow();
    loadActiveMarketDataLineReservationsMock.mockRejectedValue(new Error("reservations unavailable"));
    expect((await call("GET", "/gateway")).status).toBe(500);
  });
});

describe("GET /system-health/summary", () => {
  it("bundles the five readings in one response", async () => {
    const onlineId = await insertUser("summary-online", new Date(Date.now() - 60_000));
    presenceTracker.connect(onlineId);

    const { status, json } = await callJson("/summary");
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(["db", "gateway", "genosuke", "presence", "webDyno"]);
    expect(json.db).toMatchObject({ maxDatabaseSizeBytes: "5000000000", responseTime: { averageMs: null, slowestMs: null } });
    expect(json.genosuke.llm.model).toBe("test/model-x");
    expect(json.webDyno).toMatchObject({ notificationStreamConnections: 1, streamMultiplexer: { connectionCount: 0, subscriptionCountByKind: {} } });
    expect(json.gateway).toMatchObject({ connected: false, staleOrMissing: true });
    expect(json.presence.users[0]).toMatchObject({ id: onlineId, online: true });
  });

  it("returns the same values as the individual routes", async () => {
    const summary = (await callJson("/summary")).json;
    const gateway = (await callJson("/gateway")).json;
    const genosuke = (await callJson("/genosuke")).json;
    expect(summary.gateway).toEqual(gateway);
    expect(summary.genosuke).toEqual(genosuke);
  });

  it("returns null for a reading that fails and keeps the others", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.DB_PLAN_MAX_SIZE_BYTES;
    loadActiveMarketDataLineReservationsMock.mockRejectedValue(new Error("reservations unavailable"));

    const { status, json } = await callJson("/summary");
    expect(status).toBe(200);
    expect(json.db).toBeNull();
    expect(json.gateway).toBeNull();
    expect(json.genosuke).not.toBeNull();
    expect(json.webDyno).not.toBeNull();
    expect(json.presence).not.toBeNull();
    const loggedNames = consoleErrorSpy.mock.calls.map((callArguments) => callArguments[0]);
    expect(loggedNames).toEqual(expect.arrayContaining(["system-health/summary: db failed", "system-health/summary: gateway failed"]));
    expect(loggedNames).toHaveLength(2);
  });
});
