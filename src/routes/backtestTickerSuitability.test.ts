import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLibrary, { type Knex } from "knex";
import type { BacktestOverview, BacktestTickerSuitability } from "../backtest/backtestTypes.js";

// The Data files table's suitability marks on the real backtest router against the test database: an admin's mark stored
// and read back through the overview, a second mark replacing it, a trader refused, and the body and symbol checks.
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "backtest-suitability-route-test-"));
process.env.BACKTEST_DATA_DIR = dataDirectory;

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run suitability route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { backtestRouter } = await import("./backtest.js");
const { errorHandler } = await import("../middleware/errorHandler.js");
const testDb: Knex = db;
const suffix = `${Date.now() % 100000}`;
const symbol = `SU${suffix}`.slice(0, 8);
let server: Server;
let baseUrl: string;
let adminId: string;
let traderId: string;
let signedInUserId: string;

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/backtest${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  const [admin] = await testDb("users").insert({ username: `suitability-admin-${suffix}`, display_name: "Suitability Admin", password_hash: "not-a-real-hash", access_level: "admin" }).returning("id");
  const [trader] = await testDb("users").insert({ username: `suitability-trader-${suffix}`, display_name: "Suitability Trader", password_hash: "not-a-real-hash", access_level: "trader" }).returning("id");
  adminId = admin.id;
  traderId = trader.id;
  signedInUserId = adminId;
  // An empty file is enough for the symbol to count as downloaded.
  writeFileSync(path.join(dataDirectory, `${symbol}.sqlite`), "");
  const app = express();
  app.use(express.json());
  app.use((incoming, _response, next) => {
    (incoming as unknown as { session: { userId?: string; authMethod?: string } }).session = { userId: signedInUserId, authMethod: "passkey" };
    next();
  });
  app.use("/backtest", backtestRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("backtest_ticker_suitability").where({ symbol }).delete();
  await testDb("users").whereIn("id", [adminId, traderId]).delete();
  await testDb.destroy();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("ticker suitability routes", () => {
  it("stores an admin's mark with its trimmed note, reads it back in the overview, and a second mark replaces it", async () => {
    signedInUserId = adminId;
    const saved = await call<BacktestTickerSuitability>("PUT", `/ticker-suitability/${symbol.toLowerCase()}`, { status: "suitable", note: "  Pot $100,000 with 5 rungs.  " });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ status: "suitable", note: "Pot $100,000 with 5 rungs.", updatedByName: "Suitability Admin" });

    const stored = await testDb("backtest_ticker_suitability").where({ symbol }).first();
    expect(stored).toMatchObject({ status: "suitable", note: "Pot $100,000 with 5 rungs.", updated_by_user_id: adminId });

    const overview = await call<BacktestOverview>("GET", "/overview");
    expect(overview.status).toBe(200);
    expect(overview.body.suitabilityBySymbol[symbol]).toEqual(saved.body);

    const replaced = await call<BacktestTickerSuitability>("PUT", `/ticker-suitability/${symbol}`, { status: "unsuitable", note: "" });
    expect(replaced.body).toMatchObject({ status: "unsuitable", note: "" });
    expect(await testDb("backtest_ticker_suitability").where({ symbol }).count({ count: "*" }).first()).toEqual({ count: "1" });
  });

  it("refuses a trader and leaves the mark as it was", async () => {
    signedInUserId = traderId;
    const refused = await call<{ error: string }>("PUT", `/ticker-suitability/${symbol}`, { status: "suitable", note: "From a trader." });
    expect(refused.status).toBe(403);
    signedInUserId = adminId;
    expect((await testDb("backtest_ticker_suitability").where({ symbol }).first()).status).toBe("unsuitable");
  });

  it("refuses a status other than suitable or unsuitable, a missing note, an overlong note and a symbol without a data file", async () => {
    signedInUserId = adminId;
    expect((await call("PUT", `/ticker-suitability/${symbol}`, { status: "pending", note: "" })).status).toBe(400);
    expect((await call("PUT", `/ticker-suitability/${symbol}`, { status: "suitable" })).status).toBe(400);
    expect((await call("PUT", `/ticker-suitability/${symbol}`, { status: "suitable", note: "x".repeat(5001) })).status).toBe(400);
    expect((await call("PUT", "/ticker-suitability/NOFILE", { status: "suitable", note: "" })).status).toBe(404);
    expect(await testDb("backtest_ticker_suitability").where({ symbol: "NOFILE" }).first()).toBeUndefined();
  });
});
