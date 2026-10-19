import { defaultBacktestBaselineSettings } from "./backtestTypes.js";
import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// The backtesting lab's settings against the real test database: seeded once as a copy of the New session snapshot,
// global changes audited and checked as a session's overrides are, a ticker's own values saved, cleared and mapped into a
// session request's terms.
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
  globalChangeReachesTicker,
  labSeedDefaultPotDollars,
  loadBacktestLabAudit,
  loadBacktestLabSettings,
  loadBacktestTickerOverrides,
  saveBacktestLabTickerOverrides,
  updateBacktestLabSettings,
} = await import("./labSettingsStore.js");

const testDb: Knex = db;
const suffix = `${Date.now() % 100000}`;
const symbol = `LAB${suffix}`.slice(0, 8);

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
      const rungs = before.settings.baseline!.ladderRungs === 6 ? 7 : 6;
      const { lab, changes } = await updateBacktestLabSettings({ overrides: { baseline: { ladderRungs: rungs } }, defaultPotDollars: 150_000 }, null, trx);
      expect(lab.settings.baseline!.ladderRungs).toBe(rungs);
      expect(lab.defaultPotDollars).toBe(150_000);
      expect(changes.map((change) => change.field).sort()).toEqual(["baseline.ladderRungs", "lab.defaultPotDollars"]);
      const audit = await loadBacktestLabAudit({ symbol: null, limit: 5 }, trx);
      expect(audit.slice(0, 2).map((row) => row.field).sort()).toEqual(["baseline.ladderRungs", "lab.defaultPotDollars"]);

      const unchanged = await updateBacktestLabSettings({ overrides: { baseline: { ladderRungs: rungs } } }, null, trx);
      expect(unchanged.changes).toEqual([]);
      await expect(updateBacktestLabSettings({ overrides: { baseline: { maxSpreadPctOfMid: -5 } } }, null, trx)).rejects.toBeInstanceOf(BacktestLabSettingsValidationError);
      await expect(updateBacktestLabSettings({ defaultPotDollars: 0 }, null, trx)).rejects.toBeInstanceOf(BacktestLabSettingsValidationError);
    }));

  it("saves a ticker's own values, maps a fixed shock for a session request, and clears them back to the global values", async () =>
    inRolledBackLab(async (trx) => {
      const { overrides, changes } = await saveBacktestLabTickerOverrides(symbol.toLowerCase(), { potDollars: 50_000, ladderShockPct: 60, maxAbsDelta: 0.25 }, null, trx);
      expect(overrides).toMatchObject({ symbol, potDollars: 50_000, ladderShockPct: 60, maxAbsDelta: 0.25, ladderRungs: null });
      expect(changes.map((change) => change.field).sort()).toEqual(["ladderShockPct", "maxAbsDelta", "potDollars"]);
      const values = await loadBacktestTickerOverrides([symbol, "NOTSAVED"], trx);
      expect(values).toEqual({ [symbol]: { potDollars: 50_000, baseline: { ladderShock: "fixed", ladderShockPct: 60, maxAbsDelta: 0.25 } } });

      await expect(saveBacktestLabTickerOverrides(symbol, { ladderRungs: 2.5 }, null, trx)).rejects.toBeInstanceOf(BacktestLabSettingsValidationError);
      await expect(saveBacktestLabTickerOverrides(symbol, { minAbsDelta: 0.4 }, null, trx)).rejects.toThrow(/minAbsDelta must not be above/);
      await expect(saveBacktestLabTickerOverrides(symbol, { spread: 10 }, null, trx)).rejects.toThrow(/not a ticker lab value/);

      const cleared = await saveBacktestLabTickerOverrides(symbol, { potDollars: null, ladderShockPct: null, maxAbsDelta: null }, null, trx);
      expect(cleared.overrides).toBeNull();
      expect(await trx("backtest_lab_ticker_overrides").where({ symbol }).first()).toBeUndefined();
      const history = await loadBacktestLabAudit({ symbol }, trx);
      expect(history.filter((row) => row.newValue === "global")).toHaveLength(3);
    }));
});

describe("globalChangeReachesTicker", () => {
  const none = { potDollars: null, ladderSharesPct: null, ladderRungs: null, ladderShockPct: null, minAbsDelta: null, maxAbsDelta: null };
  it("reaches a ticker without its own values", () => {
    expect(globalChangeReachesTicker(["baseline.ladderRungs"], null)).toBe(true);
    expect(globalChangeReachesTicker(["baseline.ladderRungs"], none)).toBe(true);
  });
  it("skips a ticker whose own values replace every changed value; a fixed shock replaces the whole shock rule", () => {
    expect(globalChangeReachesTicker(["baseline.ladderRungs"], { ...none, ladderRungs: 6 })).toBe(false);
    expect(globalChangeReachesTicker(["baseline.ladderShockMaxPct", "baseline.ladderShockLookbackYears"], { ...none, ladderShockPct: 60 })).toBe(false);
    expect(globalChangeReachesTicker(["lab.defaultPotDollars"], { ...none, potDollars: 50_000 })).toBe(false);
  });
  it("reaches it when any changed value is not one of its own", () => {
    expect(globalChangeReachesTicker(["baseline.ladderRungs", "baseline.maxSpreadPctOfMid"], { ...none, ladderRungs: 6 })).toBe(true);
    expect(globalChangeReachesTicker(["baseline.minAbsDelta"], { ...none, maxAbsDelta: 0.25 })).toBe(true);
  });
  it("never reaches it with values an analysis doesn't read: Pluto's own rows and the decision maker", () => {
    expect(globalChangeReachesTicker(["pluto.capitalBudgetPct", "kellyFraction", "policy.roll", "trading.maxOrderPctOfPortfolio", "decisionMaker"], null)).toBe(false);
    expect(globalChangeReachesTicker(["kellyFraction", "trading.spreadCostChargedPct"], null)).toBe(true);
  });
});
