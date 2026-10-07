import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import * as dropNotes from "./migrations/20261007100001_drop_shortlist_entries_notes.js";
import * as addSignalsEnabled from "./migrations/20261007100002_add_shortlist_entries_signals_enabled.js";
import * as addResumedFrom from "./migrations/20261007100003_add_ticker_backfill_runs_resumed_from_run_id.js";

// Audit (G2, 2026-10-07): today's three migrations, run against scratch copies of their tables inside a transaction that is always
// rolled back (a private schema first on the search_path), so the real test-database tables are never touched. Kept out of
// src/db/migrations/ on purpose: knex loads every file in that folder as a migration.
config();
if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the migration audit tests.");
const testDb: Knex = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } });

afterAll(async () => {
  await testDb.destroy();
});

class Rollback extends Error {}

/** Runs `work` in a transaction whose search_path starts with a fresh schema holding scratch copies of the tables, then rolls back. */
async function inScratchSchema(work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const schema = `audit_g2_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await testDb
    .transaction(async (trx) => {
      await trx.raw(`CREATE SCHEMA ${schema}`);
      await trx.raw(`SET LOCAL search_path TO ${schema}, public`);
      await trx.raw(`CREATE TABLE ${schema}.shortlist_entries (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL, notes text, bot_enabled boolean NOT NULL DEFAULT false, removed_at timestamptz)`);
      await trx.raw(`CREATE TABLE ${schema}.ticker_backfill_runs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text NOT NULL)`);
      await work(trx);
      throw new Rollback();
    })
    .catch((error) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const byLabel = async (trx: Knex.Transaction) => Object.fromEntries((await trx("shortlist_entries").select("label", "signals_enabled")).map((row) => [row.label, row.signals_enabled]));

describe("20261007100002 add shortlist_entries.signals_enabled", () => {
  it("switches on every active entry and every removed entry that still has Pluto on; other removed entries stay off; new ones default off", async () => {
    await inScratchSchema(async (trx) => {
      await trx("shortlist_entries").insert([
        { label: "active", bot_enabled: false },
        { label: "active-pluto", bot_enabled: true },
        { label: "removed", removed_at: new Date() },
        { label: "removed-pluto", bot_enabled: true, removed_at: new Date() },
      ]);
      await addSignalsEnabled.up(trx);
      expect(await byLabel(trx)).toEqual({ active: true, "active-pluto": true, removed: false, "removed-pluto": true });
      await trx("shortlist_entries").insert({ label: "new" });
      expect((await byLabel(trx)).new).toBe(false);
    });
  });

  it("the constraint refuses Pluto on with Signals off, on insert and on update, and allows turning both off in one update", async () => {
    await inScratchSchema(async (trx) => {
      await trx("shortlist_entries").insert({ label: "on", bot_enabled: true });
      await addSignalsEnabled.up(trx);
      await trx.raw("SAVEPOINT before_bad_update");
      await expect(trx("shortlist_entries").where({ label: "on" }).update({ signals_enabled: false })).rejects.toThrow(/shortlist_entries_bot_requires_signals/);
      await trx.raw("ROLLBACK TO SAVEPOINT before_bad_update");
      await trx.raw("SAVEPOINT before_bad_insert");
      await expect(trx("shortlist_entries").insert({ label: "bad", bot_enabled: true })).rejects.toThrow(/shortlist_entries_bot_requires_signals/);
      await trx.raw("ROLLBACK TO SAVEPOINT before_bad_insert");
      await trx("shortlist_entries").where({ label: "on" }).update({ signals_enabled: false, bot_enabled: false });
      expect(await trx("shortlist_entries").where({ label: "on" }).first("signals_enabled", "bot_enabled")).toEqual({ signals_enabled: false, bot_enabled: false });
    });
  });

  it("down removes the constraint and the column", async () => {
    await inScratchSchema(async (trx) => {
      await addSignalsEnabled.up(trx);
      await addSignalsEnabled.down(trx);
      expect(await trx.schema.hasColumn("shortlist_entries", "signals_enabled")).toBe(false);
      await trx("shortlist_entries").insert({ label: "pluto-only", bot_enabled: true });
    });
  });
});

describe("20261007100001 drop shortlist_entries.notes", () => {
  it("drops the column; down brings back an empty nullable one", async () => {
    await inScratchSchema(async (trx) => {
      await trx("shortlist_entries").insert({ label: "x", notes: "a note" });
      await dropNotes.up(trx);
      expect(await trx.schema.hasColumn("shortlist_entries", "notes")).toBe(false);
      await dropNotes.down(trx);
      expect(await trx("shortlist_entries").first("notes")).toEqual({ notes: null });
    });
  });
});

describe("20261007100003 add ticker_backfill_runs.resumed_from_run_id", () => {
  it("links a run to an existing run only, and the original cannot be deleted alone while a restart points at it", async () => {
    await inScratchSchema(async (trx) => {
      await addResumedFrom.up(trx);
      const [original] = await trx("ticker_backfill_runs").insert({ label: "original" }).returning("id");
      await trx("ticker_backfill_runs").insert({ label: "restart", resumed_from_run_id: original.id });
      await trx.raw("SAVEPOINT before_bad_link");
      await expect(trx("ticker_backfill_runs").insert({ label: "dangling", resumed_from_run_id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/foreign key/);
      await trx.raw("ROLLBACK TO SAVEPOINT before_bad_link");
      await trx.raw("SAVEPOINT before_delete");
      await expect(trx("ticker_backfill_runs").where({ id: original.id }).del()).rejects.toThrow(/foreign key/);
      await trx.raw("ROLLBACK TO SAVEPOINT before_delete");
      // Both in one statement is fine (the check runs at the end of the statement).
      await trx("ticker_backfill_runs").del();
      await addResumedFrom.down(trx);
      expect(await trx.schema.hasColumn("ticker_backfill_runs", "resumed_from_run_id")).toBe(false);
    });
  });
});
