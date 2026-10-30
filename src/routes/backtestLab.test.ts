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

  it("previews a global save without writing it: each change, the tickers it re-runs and the ones keeping their own value", async () => {
    await call("PUT", `/lab-ticker-overrides/${symbol}`, { ladderRungs: 6 });
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    const rungs = before.body.settings.baseline!.ladderRungs === 4 ? 3 : 4;
    const auditBefore = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");

    type Preview = { changes: (BacktestLabChange & { reruns: string[]; keptOverrides: string[] })[]; reruns: string[] };
    const preview = await call<Preview>("POST", "/lab-settings/preview", { overrides: { baseline: { ladderRungs: rungs } } });
    expect(preview.status).toBe(200);
    expect(preview.body.changes).toHaveLength(1);
    expect(preview.body.changes[0]).toMatchObject({ field: "baseline.ladderRungs", oldValue: String(before.body.settings.baseline!.ladderRungs), newValue: String(rungs) });
    expect(preview.body.changes[0]!.keptOverrides).toContain(symbol);
    expect(preview.body.changes[0]!.reruns).not.toContain(symbol);
    expect(preview.body.reruns).not.toContain(symbol);
    // Nothing written: the value and the history are as they were.
    expect((await call<BacktestLabSettingsView>("GET", "/lab-settings")).body.settings.baseline!.ladderRungs).toBe(before.body.settings.baseline!.ladderRungs);
    expect((await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=")).body[0]?.id).toBe(auditBefore.body[0]?.id);
    expect((await call("POST", "/lab-settings/preview", { overrides: { baseline: { minDte: 90 } } })).status).toBe(400);

    // The save itself records how many analyses it re-ran on its history rows.
    const saved = await call<{ analyses: { started: string[] } }>("PUT", "/lab-settings", { overrides: { baseline: { ladderRungs: rungs } } });
    const audit = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");
    expect(audit.body[0]).toMatchObject({ field: "baseline.ladderRungs", analysesRerun: saved.body.analyses.started.length });
    await call("PUT", `/lab-ticker-overrides/${symbol}`, { ladderRungs: null });
  });

  it("refuses the retired rules' values and decision makers in the lab, and a save of the decision maker alone re-runs no analysis", async () => {
    for (const overrides of [{ kellyFraction: 0.3 }, { policy: { roll: "never" } }, { pluto: { capitalBudgetPct: 40 } }, { decisionMaker: "rules" }, { decisionMaker: "llm" }, { decisionMaker: "vol_farmer" }]) {
      expect((await call("PUT", "/lab-settings", { overrides })).status).toBe(400);
    }
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    const decisionMaker = before.body.settings.decisionMaker === "steady_stake" ? "vol_farmer_v2" : "steady_stake";
    const body = { overrides: { decisionMaker } };

    type Preview = { changes: (BacktestLabChange & { reruns: string[] })[]; reruns: string[] };
    const preview = await call<Preview>("POST", "/lab-settings/preview", body);
    expect(preview.body.changes.map((change) => change.field)).toEqual(["decisionMaker"]);
    expect(preview.body.changes.every((change) => change.reruns.length === 0)).toBe(true);
    expect(preview.body.reruns).toEqual([]);

    const saved = await call<{ analyses: { started: string[] } }>("PUT", "/lab-settings", body);
    expect(saved.body.analyses.started).toEqual([]);
    const after = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(after.body.settings.decisionMaker).toBe(decisionMaker);
    expect(after.body.rows.find((row) => row.path === "decisionMaker")?.now).toBe(decisionMaker);
  });
});
