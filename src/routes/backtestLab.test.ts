import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLibrary, { type Knex } from "knex";
import type { BacktestLabAuditRow, BacktestLabChange, BacktestLabSettingsView, BacktestLabTickerOverrides, BacktestSettingsTemplate } from "../backtest/backtestTypes.js";

// The lab settings routes on the real backtest router against the test database: the global values stored and read back
// (and the New session table starting from them), a ticker's own values stored, read back and cleared, and the audit.
const dataDirectory = mkdtempSync(path.join(os.tmpdir(), "backtest-lab-route-test-"));
process.env.BACKTEST_DATA_DIR = dataDirectory;

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run lab settings route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { backtestRouter } = await import("./backtest.js");
const { errorHandler } = await import("../middleware/errorHandler.js");
const testDb: Knex = db;
const suffix = `${Date.now() % 100000}`;
const symbol = `LR${suffix}`.slice(0, 8);
let server: Server;
let baseUrl: string;
let userId: string;
let savedRow: Record<string, unknown> | undefined;

async function call<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}/backtest${route}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `lab-settings-${suffix}`, display_name: "Lab Settings Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  savedRow = await testDb("backtest_lab_settings").where({ id: 1 }).first();
  const app = express();
  app.use(express.json());
  app.use((incoming, _response, next) => {
    (incoming as unknown as { session: { userId?: string; authMethod?: string } }).session = { userId, authMethod: "passkey" };
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
  await testDb("backtest_lab_ticker_overrides").where({ symbol }).delete();
  await testDb("backtest_lab_settings_audit").where({ user_id: userId }).delete();
  await testDb("backtest_lab_settings").where({ id: 1 }).delete();
  if (savedRow) await testDb("backtest_lab_settings").insert({ ...savedRow, settings: JSON.stringify(savedRow.settings) });
  await testDb("users").where({ id: userId }).delete();
  await testDb.destroy();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("lab settings routes", () => {
  it("stores a global change, reads it back, and the New session table starts from it", async () => {
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(before.status).toBe(200);
    const spread = before.body.settings.baseline!.maxSpreadPctOfMid === 40 ? 45 : 40;
    const saved = await call<{ settings: BacktestLabSettingsView; changes: BacktestLabChange[] }>("PUT", "/lab-settings", { overrides: { baseline: { maxSpreadPctOfMid: spread } }, defaultPotDollars: 120_000 });
    expect(saved.status).toBe(200);
    expect(saved.body.changes.map((change) => change.field).sort()).toEqual(["baseline.maxSpreadPctOfMid", "lab.defaultPotDollars"]);

    const after = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(after.body.settings.baseline!.maxSpreadPctOfMid).toBe(spread);
    expect(after.body.defaultPotDollars).toBe(120_000);
    expect(after.body.rows.find((row) => row.path === "baseline.maxSpreadPctOfMid")?.now).toBe(spread);
    const template = await call<BacktestSettingsTemplate>("GET", "/settings-template");
    expect(template.body.settings.baseline!.maxSpreadPctOfMid).toBe(spread);

    const audit = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");
    expect(audit.body.slice(0, 2).every((row) => row.userDisplayName === "Lab Settings Tester" && row.symbol === null)).toBe(true);
    const refused = await call<{ error: string }>("PUT", "/lab-settings", { overrides: { baseline: { minDte: 90 } } });
    expect(refused.status).toBe(400);
  });

  it("stores a ticker's own values, reads them back, refuses invalid ones and clears them", async () => {
    const saved = await call<{ overrides: BacktestLabTickerOverrides; changes: BacktestLabChange[] }>("PUT", `/lab-ticker-overrides/${symbol}`, { ladderRungs: 6, minAbsDelta: 0.05, maxAbsDelta: 0.25 });
    expect(saved.status).toBe(200);
    expect(saved.body.overrides).toMatchObject({ symbol, ladderRungs: 6, minAbsDelta: 0.05, maxAbsDelta: 0.25, potDollars: null });

    const one = await call<{ symbol: string; overrides: BacktestLabTickerOverrides | null }>("GET", `/lab-ticker-overrides/${symbol.toLowerCase()}`);
    expect(one.body.overrides?.ladderRungs).toBe(6);
    const all = await call<BacktestLabTickerOverrides[]>("GET", "/lab-ticker-overrides");
    expect(all.body.some((row) => row.symbol === symbol)).toBe(true);

    expect((await call("PUT", `/lab-ticker-overrides/${symbol}`, { ladderRungs: 0 })).status).toBe(400);
    expect((await call("PUT", `/lab-ticker-overrides/${symbol}`, { ladderSharesPct: 150 })).status).toBe(400);

    const audit = await call<BacktestLabAuditRow[]>("GET", `/lab-settings/audit?symbol=${symbol}`);
    expect(audit.body.map((row) => row.field).sort()).toEqual(["ladderRungs", "maxAbsDelta", "minAbsDelta"]);

    const cleared = await call<{ overrides: BacktestLabTickerOverrides | null }>("PUT", `/lab-ticker-overrides/${symbol}`, { ladderRungs: null, minAbsDelta: null, maxAbsDelta: null });
    expect(cleared.body.overrides).toBeNull();
    expect((await call<{ overrides: unknown }>("GET", `/lab-ticker-overrides/${symbol}`)).body.overrides).toBeNull();
  });
});
