import { defaultBacktestBaselineSettings } from "./backtestTypes.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The backtesting lab's settings against the real test database: seeded once as a copy of the New session snapshot,
// changes audited and checked as a session's overrides are, the retired decision makers' settings refused.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run lab settings tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { loadCurrentBacktestSettings } = await import("./settingsTemplate.js");
const {
  BacktestLabSettingsValidationError,
  labSeedDefaultPotDollars,
  loadBacktestLabAudit,
  loadBacktestLabSettings,
  updateBacktestLabSettings,
} = await import("./labSettingsStore.js");

const testDb: Knex = db;

/** Runs `work` in a transaction that starts with no lab row and is always rolled back, so the shared lab row is untouched. */
async function inRolledBackLab(work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const trx = await testDb.transaction();
  try {
    await trx("backtest_lab_settings").where({ id: 1 }).delete();
    await work(trx);
  } finally {
    await trx.rollback();
  }
}

afterAll(async () => {
  await testDb.destroy();
});

describe("lab settings store", () => {
  it("seeds the first read as an exact copy of the New session snapshot, then keeps its own copy", async () =>
    inRolledBackLab(async (trx) => {
      const live = await loadCurrentBacktestSettings(trx);
      const lab = await loadBacktestLabSettings(trx);
      expect(lab.settings).toEqual(live);
      expect(lab.defaultPotDollars).toBe(labSeedDefaultPotDollars);
      const again = await loadBacktestLabSettings(trx);
      expect(again.updatedAt).toBe(lab.updatedAt);
    }));

  it("reads the stored copy in the code's shape: a setting since removed is dropped, one since added gets its default", async () =>
    inRolledBackLab(async (trx) => {
      const seeded = await loadBacktestLabSettings(trx);
      const { ladderRungs: _dropped, ...baselineWithoutRungs } = seeded.settings.baseline!;
      const stored = { ...seeded.settings, baseline: { ...baselineWithoutRungs, removedSetting: "plus_one_cent" }, policy: { ...seeded.settings.policy, removedRule: true } };
      await trx("backtest_lab_settings").where({ id: 1 }).update({ settings: JSON.stringify(stored) });
      const read = await loadBacktestLabSettings(trx);
      expect(read.settings.baseline).not.toHaveProperty("removedSetting");
      expect(read.settings.policy).not.toHaveProperty("removedRule");
      expect(read.settings.baseline!.ladderRungs).toBe(defaultBacktestBaselineSettings.ladderRungs);
      expect(Object.keys(read.settings.baseline!).sort()).toEqual(Object.keys(defaultBacktestBaselineSettings).sort());
    }));

  it("saves a global change with one audit row per changed value and refuses an invalid one", async () =>
    inRolledBackLab(async (trx) => {
      const before = await loadBacktestLabSettings(trx);
      const stake = before.settings.steadyStake!.stakePct === 70 ? 75 : 70;
      const { lab, changes } = await updateBacktestLabSettings({ overrides: { steadyStake: { stakePct: stake } }, defaultPotDollars: 150_000 }, null, trx);
      expect(lab.settings.steadyStake!.stakePct).toBe(stake);
      expect(lab.defaultPotDollars).toBe(150_000);
      expect(changes.map((change) => change.field).sort()).toEqual(["lab.defaultPotDollars", "steadyStake.stakePct"]);
      const audit = await loadBacktestLabAudit({ symbol: null, limit: 5 }, trx);
      expect(audit.slice(0, 2).map((row) => row.field).sort()).toEqual(["lab.defaultPotDollars", "steadyStake.stakePct"]);

      const unchanged = await updateBacktestLabSettings({ overrides: { steadyStake: { stakePct: stake } } }, null, trx);
      expect(unchanged.changes).toEqual([]);
      await expect(updateBacktestLabSettings({ overrides: { steadyStake: { stakePct: 0 } } }, null, trx)).rejects.toBeInstanceOf(BacktestLabSettingsValidationError);
      await expect(updateBacktestLabSettings({ defaultPotDollars: 0 }, null, trx)).rejects.toBeInstanceOf(BacktestLabSettingsValidationError);
    }));

  it("refuses the retired decision makers and their settings: the CC + Put Ladder's, v2's and v3's", async () =>
    inRolledBackLab(async (trx) => {
      await expect(updateBacktestLabSettings({ overrides: { decisionMaker: "baseline" } }, null, trx)).rejects.toThrow(/was retired/);
      await expect(updateBacktestLabSettings({ overrides: { baseline: { ladderRungs: 4 } } }, null, trx)).rejects.toThrow("baseline.ladderRungs cannot be changed for a session.");
      await expect(updateBacktestLabSettings({ overrides: { volFarmerV3: { rebalanceBandPct: 10 } } }, null, trx)).rejects.toThrow("volFarmerV3.rebalanceBandPct cannot be changed for a session.");
    }));
});
