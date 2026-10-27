import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Settings versions against the real test database: one row per distinct set, a pass pointing at
// its version, the backfill's hash agreeing with the app's, and the pass routes reading the
// settings through the version.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run settings version tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { ensurePlutoSettingsVersion } = await import("./settingsVersions.js");
const { startPlutoPass } = await import("./ledger.js");
const { plutoRouter } = await import("../routes/pluto.js");

const testDb: Knex = db;
const marker = `settings-versions-test-${Date.now()}`;
const createdPassIds: string[] = [];
type PassJson = { id: string; settingsSnapshot: unknown };
let server: Server;
let baseUrl: string;
let userId: string;

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `settings-versions-${Date.now()}`, display_name: "Settings Versions Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as unknown as { session: { userId?: string } }).session = { userId };
    next();
  });
  app.use("/pluto", plutoRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("pluto_passes").whereIn("id", createdPassIds).del();
  await testDb("pluto_settings_versions").whereRaw("settings->>'marker' = ?", [marker]).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("ensurePlutoSettingsVersion", () => {
  it("stores one row per distinct set of settings, whatever the key order", async () => {
    const first = await ensurePlutoSettingsVersion({ marker, minDte: 2, promptVersion: "v-test-1" });
    const sameReordered = await ensurePlutoSettingsVersion({ promptVersion: "v-test-1", minDte: 2, marker });
    const different = await ensurePlutoSettingsVersion({ marker, minDte: 3, promptVersion: "v-test-1" });
    expect(sameReordered).toBe(first);
    expect(different).not.toBe(first);
    const stored = await testDb("pluto_settings_versions").where({ id: first }).first("settings");
    expect(stored.settings).toEqual({ marker, minDte: 2, promptVersion: "v-test-1" });
  });

  it("concurrent first sightings of the same settings share one row", async () => {
    const settings = { marker, concurrent: true };
    const ids = await Promise.all([1, 2, 3, 4].map(() => ensurePlutoSettingsVersion(settings)));
    expect(new Set(ids).size).toBe(1);
  });

  it("finds a version the migration's backfill hashed from a stored snapshot", async () => {
    const snapshot = { marker, backfilled: true, maxAbsDelta: 0.4, windowStartEt: "10:00" };
    const [backfilled] = await testDb("pluto_settings_versions")
      .insert({ content_hash: testDb.raw("encode(sha256(convert_to((?::jsonb)::text, 'UTF8')), 'hex')", [JSON.stringify(snapshot)]), settings: JSON.stringify(snapshot) })
      .returning("id");
    expect(await ensurePlutoSettingsVersion({ windowStartEt: "10:00", maxAbsDelta: 0.4, backfilled: true, marker })).toBe(backfilled.id);
  });
});

describe("startPlutoPass", () => {
  it("points the pass at its settings version and stores no copy", async () => {
    const settings = { marker, promptVersion: "v-test-pass" };
    const passId = await startPlutoPass("manual", { test: marker }, settings);
    createdPassIds.push(passId);
    const row = await testDb("pluto_passes").where({ id: passId }).first();
    expect(row).not.toHaveProperty("settings_snapshot");
    expect(row.settings_version_id).toBe(await ensurePlutoSettingsVersion(settings));
  });

  it("a pass started without settings has no version", async () => {
    const passId = await startPlutoPass("manual", { test: marker });
    createdPassIds.push(passId);
    const row = await testDb("pluto_passes").where({ id: passId }).first("settings_version_id");
    expect(row.settings_version_id).toBeNull();
  });
});

describe("pass routes", () => {
  let versionedPassId: string;
  let olderPassId: string;

  beforeAll(async () => {
    const versionId = await ensurePlutoSettingsVersion({ marker, capitalBudgetPct: 30 });
    const olderVersionId = await ensurePlutoSettingsVersion({ marker, capitalBudgetPct: 25 });
    // Year 2100: newer than every other test file's passes, so these lead GET /passes.
    const [versioned] = await testDb("pluto_passes").insert({ started_at: "2100-01-01T00:02:00Z", trigger: "manual", trigger_detail: JSON.stringify({ test: marker }), settings_version_id: versionId }).returning("id");
    const [older] = await testDb("pluto_passes").insert({ started_at: "2100-01-01T00:01:00Z", trigger: "manual", trigger_detail: JSON.stringify({ test: marker }), settings_version_id: olderVersionId }).returning("id");
    versionedPassId = versioned.id;
    olderPassId = older.id;
    createdPassIds.push(versionedPassId, olderPassId);
  });

  it("GET /passes/:id reads the settings through the version", async () => {
    const versioned = (await (await fetch(`${baseUrl}/pluto/passes/${versionedPassId}`)).json()) as PassJson;
    expect(versioned.id).toBe(versionedPassId);
    expect(versioned.settingsSnapshot).toEqual({ marker, capitalBudgetPct: 30 });
    expect(versioned).not.toHaveProperty("promptVersion");
    const older = (await (await fetch(`${baseUrl}/pluto/passes/${olderPassId}`)).json()) as PassJson;
    expect(older.settingsSnapshot).toEqual({ marker, capitalBudgetPct: 25 });
  });

  it("GET /passes carries each pass's settings", async () => {
    const passes = (await (await fetch(`${baseUrl}/pluto/passes?limit=2`)).json()) as PassJson[];
    expect(passes.map((pass) => [pass.id, pass.settingsSnapshot])).toEqual([
      [versionedPassId, { marker, capitalBudgetPct: 30 }],
      [olderPassId, { marker, capitalBudgetPct: 25 }],
    ]);
  });
});
