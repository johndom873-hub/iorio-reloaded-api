import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real environmentRouter on a small express app against the test database. The market-data pool and line budget (the two
// IBKR-side inputs) are mocked; the worker heartbeat row and the trading-halt switch are real rows.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run environment route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const loadMarketDataLineRestrictionMock = vi.fn();
vi.mock("../ibkr/marketDataLineBudget.js", () => ({ loadMarketDataLineRestriction: (...args: unknown[]) => loadMarketDataLineRestrictionMock(...args) }));
const marketDataFeedRefusalMock = vi.fn();
vi.mock("../ibkr/marketDataPool.js", () => ({ marketDataFeedRefusal: () => marketDataFeedRefusalMock() }));
vi.mock("../lib/daySignalsLoop.js", () => ({ daySignalsLoopLineHolder: "daySignalsLoop" }));

const { db } = await import("../db/connection.js");
const { environmentRouter } = await import("./environment.js");

const testDb: Knex = db;
const gatewayProcessName = "ibkr_gateway_worker";
const savedEnvironment = {
  appEnvironment: process.env.APP_ENVIRONMENT,
  marketDataLinesEnabled: process.env.IBKR_MARKET_DATA_LINES_ENABLED,
  tradingMode: process.env.IBKR_TRADING_MODE,
};

let server: Server;
let baseUrl: string;
let userId: string;
let originalWorkerRow: Record<string, unknown> | undefined;
let originalHaltRow: Record<string, unknown> | undefined;

beforeAll(async () => {
  originalWorkerRow = await testDb("worker_health").where({ process_name: gatewayProcessName }).first();
  originalHaltRow = await testDb("platform_controls").where({ key: "trading_halt" }).first();
  const [user] = await testDb("users").insert({ username: `env-route-${Date.now()}`, display_name: "Environment Route Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/environment", environmentRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  process.env.APP_ENVIRONMENT = "development";
  process.env.IBKR_MARKET_DATA_LINES_ENABLED = "true";
  loadMarketDataLineRestrictionMock.mockReset().mockResolvedValue(null);
  marketDataFeedRefusalMock.mockReset().mockReturnValue(null);
  await testDb("platform_controls").insert({ key: "trading_halt", enabled: false, reason: null, set_by_user_id: null }).onConflict("key").merge({ enabled: false, reason: null, set_by_user_id: null });
  await testDb("worker_health").where({ process_name: gatewayProcessName }).del();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("worker_health").where({ process_name: gatewayProcessName }).del();
  if (originalWorkerRow) await testDb("worker_health").insert(originalWorkerRow);
  if (originalHaltRow) await testDb("platform_controls").insert(originalHaltRow).onConflict("key").merge();
  await testDb("users").where({ id: userId }).del();
  restoreEnvironmentVariable("APP_ENVIRONMENT", savedEnvironment.appEnvironment);
  restoreEnvironmentVariable("IBKR_MARKET_DATA_LINES_ENABLED", savedEnvironment.marketDataLinesEnabled);
  await testDb.destroy();
});

function restoreEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function call(path: string, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}/environment${path}`, { headers: asUser ? { "x-test-user-id": asUser } : {} });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // An error response from express's default handler is HTML, not JSON.
  }
  return { status: response.status, json };
}

async function insertWorkerRow(overrides: Record<string, unknown> = {}): Promise<void> {
  await testDb("worker_health").insert({
    process_name: gatewayProcessName,
    connected: true,
    total_reconnects: 0,
    updated_at: new Date(),
    app_environment: "development",
    account_binding_status: "ok",
    account_binding_reason: null,
    git_sha: "0123456789abcdef0123456789abcdef01234567",
    ibkr_account_ids: ["DU1111111", "DU2222222"],
    detected_trading_mode: "paper",
    ...overrides,
  });
}

describe("GET /environment", () => {
  it("is public and answers with the environment name and trading mode only", async () => {
    const { status, json } = await call("", { asUser: null });
    expect(status).toBe(200);
    expect(json).toEqual({ environment: "development", tradingMode: savedEnvironment.tradingMode });
  });

  it.each(["development", "staging", "production"])("reports %s", async (value) => {
    process.env.APP_ENVIRONMENT = value;
    expect((await call("", { asUser: null })).json.environment).toBe(value);
  });

  it("answers 500 for an unrecognised environment name", async () => {
    process.env.APP_ENVIRONMENT = "qa";
    expect((await call("", { asUser: null })).status).toBe(500);
  });

  it("answers 500 when the environment name is not configured", async () => {
    delete process.env.APP_ENVIRONMENT;
    expect((await call("", { asUser: null })).status).toBe(500);
  });
});

describe("GET /environment/details", () => {
  it("is refused without a session", async () => {
    const { status, json } = await call("/details", { asUser: null });
    expect(status).toBe(401);
    expect(json).toEqual({ error: "Not logged in." });
    expect(loadMarketDataLineRestrictionMock).not.toHaveBeenCalled();
  });

  it("with a healthy worker reports trading ok and the worker's identity", async () => {
    await insertWorkerRow();

    const { status, json } = await call("/details");
    expect(status).toBe(200);
    expect(json).toEqual({
      environment: "development",
      tradingMode: savedEnvironment.tradingMode,
      trading: { state: "ok", reason: null },
      tradingHalt: { enabled: false, reason: null, setByDisplayName: null, setAt: expect.any(String) },
      marketDataRestriction: null,
      marketDataLinesEnabled: true,
      marketDataFeedRefusal: null,
      worker: { gitSha: "0123456", accountId: "DU1111111", detectedTradingMode: "paper", bindingStatus: "ok", heartbeatAgeSeconds: expect.any(Number) },
    });
    expect(json.worker.heartbeatAgeSeconds).toBeLessThanOrEqual(5);
  });

  it("with no worker row reports trading offline and a null worker", async () => {
    const { json } = await call("/details");
    expect(json.trading).toEqual({ state: "offline", reason: "Trading is blocked: the trading worker has never reported in." });
    expect(json.worker).toBeNull();
  });

  it("derives the heartbeat age from the row's update time", async () => {
    await insertWorkerRow({ updated_at: new Date(Date.now() - 30_000) });
    const { json } = await call("/details");
    expect(json.worker.heartbeatAgeSeconds).toBeGreaterThanOrEqual(30);
    expect(json.worker.heartbeatAgeSeconds).toBeLessThanOrEqual(35);
  });

  it("never reports a negative heartbeat age", async () => {
    await insertWorkerRow({ updated_at: new Date(Date.now() + 60_000) });
    expect((await call("/details")).json.worker.heartbeatAgeSeconds).toBe(0);
  });

  it("reports a stale heartbeat as trading offline", async () => {
    await insertWorkerRow({ updated_at: new Date(Date.now() - 10 * 60_000) });
    const { json } = await call("/details");
    expect(json.trading.state).toBe("offline");
    expect(json.trading.reason).toContain("the trading worker is offline (last heartbeat");
    expect(json.worker.heartbeatAgeSeconds).toBeGreaterThanOrEqual(600);
  });

  it("blocks trading when the worker's environment differs from the API's", async () => {
    await insertWorkerRow({ app_environment: "staging" });
    expect((await call("/details")).json.trading).toEqual({ state: "blocked", reason: 'Trading is blocked: the worker reports environment "staging" but this API is "development".' });
  });

  it("blocks trading when the worker has not reported its account binding", async () => {
    await insertWorkerRow({ account_binding_status: null });
    const { json } = await call("/details");
    expect(json.trading.state).toBe("blocked");
    expect(json.trading.reason).toContain("has not reported its IBKR account binding");
    expect(json.worker.bindingStatus).toBeNull();
  });

  it("blocks trading with the binding's own reason when the binding is not ok", async () => {
    await insertWorkerRow({ account_binding_status: "mismatch", account_binding_reason: "the Gateway is logged into the wrong account" });
    const { json } = await call("/details");
    expect(json.trading).toEqual({ state: "blocked", reason: "Trading is blocked: the Gateway is logged into the wrong account" });
    expect(json.worker.bindingStatus).toBe("mismatch");
  });

  it("shortens the git sha to seven characters and reports nulls for a worker that predates the new columns", async () => {
    await insertWorkerRow({ git_sha: null, ibkr_account_ids: null, detected_trading_mode: null });
    expect((await call("/details")).json.worker).toMatchObject({ gitSha: null, accountId: null, detectedTradingMode: null });
  });

  it("reports no account when the worker lists none", async () => {
    await insertWorkerRow({ ibkr_account_ids: [] });
    expect((await call("/details")).json.worker.accountId).toBeNull();
  });

  it("reports the trading halt with who and when, and the halted state outranks a healthy worker", async () => {
    await insertWorkerRow();
    await testDb("platform_controls")
      .where({ key: "trading_halt" })
      .update({ enabled: true, reason: "IBKR data looks wrong", set_by_user_id: userId, set_at: new Date("2030-01-02T03:04:05.000Z") });

    const { json } = await call("/details");
    expect(json.tradingHalt).toEqual({ enabled: true, reason: "IBKR data looks wrong", setByDisplayName: "Environment Route Tester", setAt: "2030-01-02T03:04:05.000Z" });
    expect(json.trading.state).toBe("halted");
    expect(json.trading.reason).toContain("Environment Route Tester");
    expect(json.trading.reason).toContain("IBKR data looks wrong");
  });

  it("passes the market-data line restriction through and asks for it without the Day Signals loop's and Pluto's own holders", async () => {
    const restriction = { priorityLines: 60, holders: ["optionChainCapture"] };
    loadMarketDataLineRestrictionMock.mockResolvedValue(restriction);

    const { json } = await call("/details");
    expect(json.marketDataRestriction).toEqual(restriction);
    expect(loadMarketDataLineRestrictionMock).toHaveBeenCalledWith({ excludeHolders: ["daySignalsLoop", "pluto_agent"] });
  });

  it("passes the market-data feed refusal through", async () => {
    const refusal = { code: 10197, message: "No market data during competing live session", since: "2030-01-02T15:00:00.000Z" };
    marketDataFeedRefusalMock.mockReturnValue(refusal);
    expect((await call("/details")).json.marketDataFeedRefusal).toEqual(refusal);
  });

  it.each([["true", true], ["false", false]])("reports market-data lines enabled=%s", async (value, expected) => {
    process.env.IBKR_MARKET_DATA_LINES_ENABLED = value;
    expect((await call("/details")).json.marketDataLinesEnabled).toBe(expected);
  });

  it("answers 500 when the market-data lines flag is not a boolean", async () => {
    process.env.IBKR_MARKET_DATA_LINES_ENABLED = "yes";
    expect((await call("/details")).status).toBe(500);
  });

  it("reports the API's own environment, which decides whether the worker matches", async () => {
    process.env.APP_ENVIRONMENT = "staging";
    await insertWorkerRow({ app_environment: "staging" });
    const { json } = await call("/details");
    expect(json.environment).toBe("staging");
    expect(json.trading).toEqual({ state: "ok", reason: null });
  });
});
