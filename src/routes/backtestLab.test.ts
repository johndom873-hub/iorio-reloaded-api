import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import knexLibrary, { type Knex } from "knex";
import type { BacktestLabAuditRow, BacktestLabChange, BacktestLabSettingsView, BacktestSettingsTemplate } from "../backtest/backtestTypes.js";

// The lab settings routes on the real backtest router against the test database: the values stored and read back (and
// the New session table starting from them), the retired decision makers refused, and the audit.
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
  await testDb("backtest_lab_settings_audit").where({ user_id: userId }).delete();
  await testDb("backtest_lab_settings").where({ id: 1 }).delete();
  if (savedRow) await testDb("backtest_lab_settings").insert({ ...savedRow, settings: JSON.stringify(savedRow.settings) });
  await testDb("users").where({ id: userId }).delete();
  await testDb.destroy();
  rmSync(dataDirectory, { recursive: true, force: true });
});

describe("lab settings routes", () => {
  it("stores a change, reads it back, and the New session table starts from it", async () => {
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(before.status).toBe(200);
    const stake = before.body.settings.steadyStake!.stakePct === 70 ? 75 : 70;
    const saved = await call<{ settings: BacktestLabSettingsView; changes: BacktestLabChange[] }>("PUT", "/lab-settings", { overrides: { steadyStake: { stakePct: stake } }, defaultPotDollars: 120_000 });
    expect(saved.status).toBe(200);
    expect(saved.body.changes.map((change) => change.field).sort()).toEqual(["lab.defaultPotDollars", "steadyStake.stakePct"]);

    const after = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(after.body.settings.steadyStake!.stakePct).toBe(stake);
    expect(after.body.defaultPotDollars).toBe(120_000);
    expect(after.body.rows.find((row) => row.path === "steadyStake.stakePct")?.now).toBe(stake);
    const template = await call<BacktestSettingsTemplate>("GET", "/settings-template");
    expect(template.body.settings.steadyStake!.stakePct).toBe(stake);

    const audit = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");
    expect(audit.body.slice(0, 2).every((row) => row.userDisplayName === "Lab Settings Tester" && row.symbol === null)).toBe(true);
    const refused = await call<{ error: string }>("PUT", "/lab-settings", { overrides: { steadyStake: { stakePct: 0 } } });
    expect(refused.status).toBe(400);
  });

  it("has no ticker overrides any more: they were the CC + Put Ladder's", async () => {
    expect((await fetch(`${baseUrl}/backtest/lab-ticker-overrides`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/backtest/lab-ticker-overrides/AAPL`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ potDollars: 1 }) })).status).toBe(404);
  });

  it("previews a save without writing it: each change, and no analysis out of date for a value Vol Farmer v4 doesn't read", async () => {
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    const stake = before.body.settings.steadyStake!.stakePct === 60 ? 65 : 60;
    const auditBefore = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");

    type Preview = { changes: (BacktestLabChange & { outOfDate: string[] })[]; outOfDate: string[] };
    const preview = await call<Preview>("POST", "/lab-settings/preview", { overrides: { steadyStake: { stakePct: stake } } });
    expect(preview.status).toBe(200);
    expect(preview.body.changes).toHaveLength(1);
    expect(preview.body.changes[0]).toMatchObject({ field: "steadyStake.stakePct", oldValue: String(before.body.settings.steadyStake!.stakePct), newValue: String(stake), outOfDate: [] });
    expect(preview.body.outOfDate).toEqual([]);
    // Nothing written: the value and the history are as they were.
    expect((await call<BacktestLabSettingsView>("GET", "/lab-settings")).body.settings.steadyStake!.stakePct).toBe(before.body.settings.steadyStake!.stakePct);
    expect((await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=")).body[0]?.id).toBe(auditBefore.body[0]?.id);
    expect((await call("POST", "/lab-settings/preview", { overrides: { baseline: { ladderRungs: 4 } } })).status).toBe(400);

    // The save re-runs nothing (Marcelo 2026-11-01): its history row has no re-run count, and no analysis goes out of date.
    const saved = await call<{ analyses: { markedOutOfDate: string[] } }>("PUT", "/lab-settings", { overrides: { steadyStake: { stakePct: stake } } });
    expect(saved.body.analyses.markedOutOfDate).toEqual([]);
    const audit = await call<BacktestLabAuditRow[]>("GET", "/lab-settings/audit?symbol=");
    expect(audit.body[0]).toMatchObject({ field: "steadyStake.stakePct", analysesRerun: null });
  });

  it("refuses the retired values and decision makers in the lab, and a save of the decision maker alone puts no analysis out of date", async () => {
    for (const overrides of [{ kellyFraction: 0.3 }, { policy: { roll: "never" } }, { pluto: { capitalBudgetPct: 40 } }, { baseline: { ladderRungs: 4 } }, { volFarmerV2: { firstPositionPct: 60 } }, ...["rules", "llm", "vol_farmer", "baseline", "vol_farmer_v2", "vol_farmer_v3"].map((decisionMaker) => ({ decisionMaker }))]) {
      expect((await call("PUT", "/lab-settings", { overrides })).status).toBe(400);
    }
    const before = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    const decisionMaker = before.body.settings.decisionMaker === "steady_stake" ? "vol_farmer_v4" : "steady_stake";
    const body = { overrides: { decisionMaker } };

    type Preview = { changes: (BacktestLabChange & { outOfDate: string[] })[]; outOfDate: string[] };
    const preview = await call<Preview>("POST", "/lab-settings/preview", body);
    expect(preview.body.changes.map((change) => change.field)).toEqual(["decisionMaker"]);
    expect(preview.body.changes.every((change) => change.outOfDate.length === 0)).toBe(true);
    expect(preview.body.outOfDate).toEqual([]);

    const saved = await call<{ analyses: { markedOutOfDate: string[] } }>("PUT", "/lab-settings", body);
    expect(saved.body.analyses.markedOutOfDate).toEqual([]);
    const after = await call<BacktestLabSettingsView>("GET", "/lab-settings");
    expect(after.body.settings.decisionMaker).toBe(decisionMaker);
    expect(after.body.rows.find((row) => row.path === "decisionMaker")?.now).toBe(decisionMaker);
  });
});
