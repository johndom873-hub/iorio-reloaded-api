import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Runs the real trading_settings SQL (singleton row, check constraints) against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run trading settings database tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { loadTradingSettings, loadTradingSettingsForEditing, saveTradingSettings } = await import("./tradingSettingsStore.js");
const { loadRecoveryTargetWindow } = await import("./recoveryTargetWindow.js");

const testDb: Knex = db;

type StoredRow = Record<string, unknown>;
let originalRow: StoredRow;
const createdUserIds: string[] = [];

const knownValues = {
  max_position_pct_of_portfolio: 10,
  max_concentration_per_ticker_pct: 20,
  min_cash_reserve_pct: 5,
  delta_target_min: 0.2,
  delta_target_max: 0.3,
  recovery_dte_min: 30,
  recovery_dte_max: 45,
  min_annualized_yield_pct: 50,
  commission_warn_share_of_premium_pct: 5,
  updated_by_user_id: null,
  updated_at: new Date("2026-01-01T00:00:00.000Z"),
};

async function createUser(displayName: string): Promise<string> {
  const [user] = await testDb("users")
    .insert({ username: `tsdb-${Date.now()}-${createdUserIds.length}`, display_name: displayName, password_hash: "not-a-real-hash" })
    .returning("id");
  createdUserIds.push(user.id);
  return user.id;
}

async function readRawRow(): Promise<StoredRow> {
  return (await testDb("trading_settings").first()) as StoredRow;
}

beforeAll(async () => {
  originalRow = await readRawRow();
});

beforeEach(async () => {
  await testDb("trading_settings").update(knownValues);
});

afterAll(async () => {
  const count = Number((await testDb("trading_settings").count({ count: "*" }).first())!.count);
  if (count === 0) await testDb("trading_settings").insert(originalRow);
  else await testDb("trading_settings").update(originalRow);
  await testDb("users").whereIn("id", createdUserIds).del();
  await testDb.destroy();
});

/** Runs `body` with the singleton row removed, and always puts the row back. */
async function withoutSettingsRow(body: () => Promise<void>): Promise<void> {
  const row = await readRawRow();
  await testDb("trading_settings").del();
  try {
    await body();
  } finally {
    await testDb("trading_settings").insert(row);
  }
}

const completeInput = {
  maxPositionPctOfPortfolio: 11,
  maxConcentrationPerTickerPct: 22,
  minCashReservePct: 3.5,
  deltaTargetMin: 0.15,
  deltaTargetMax: 0.35,
  recoveryDteMin: 5,
  recoveryDteMax: 60,
  minAnnualizedYieldPct: 40,
  commissionWarnSharePctOfPremium: 7.5,
};

describe("the seeded trading_settings row", () => {
  it("is exactly one row, and the loader returns every field as a number", async () => {
    const count = Number((await testDb("trading_settings").count({ count: "*" }).first())!.count);
    expect(count).toBe(1);
    const settings = await loadTradingSettings();
    const { commissionEstimator, ...numbers } = settings;
    expect(numbers).toEqual({
      maxPositionPctOfPortfolio: 10,
      maxConcentrationPerTickerPct: 20,
      minCashReservePct: 5,
      deltaTargetMin: 0.2,
      deltaTargetMax: 0.3,
      recoveryDteMin: 30,
      recoveryDteMax: 45,
      minAnnualizedYieldPct: 50,
      commissionWarnSharePctOfPremium: 5,
    });
    for (const value of Object.values(numbers)) expect(typeof value).toBe("number");
    expect(typeof commissionEstimator?.perContractDollars).toBe("function");
  });

  it("loadTradingSettings throws when the row is missing", async () => {
    await withoutSettingsRow(async () => {
      await expect(loadTradingSettings()).rejects.toThrow("No trading_settings row found.");
    });
  });
});

describe("loadTradingSettingsForEditing", () => {
  it("has no saver name and an ISO updatedAt when nobody has saved yet", async () => {
    const editing = await loadTradingSettingsForEditing();
    expect(editing.updatedByDisplayName).toBeNull();
    expect(editing.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(editing.deltaTargetMin).toBe(0.2);
    expect(typeof editing.maxPositionPctOfPortfolio).toBe("number");
  });

  it("names the user who saved last, and updatedAt is the ISO form of the stored timestamp", async () => {
    const firstUserId = await createUser("First Saver");
    const secondUserId = await createUser("Second Saver");
    await saveTradingSettings(completeInput, firstUserId);
    expect((await loadTradingSettingsForEditing()).updatedByDisplayName).toBe("First Saver");
    await saveTradingSettings(completeInput, secondUserId);
    const editing = await loadTradingSettingsForEditing();
    expect(editing.updatedByDisplayName).toBe("Second Saver");
    expect(editing.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(editing.updatedAt).toBe(new Date((await readRawRow()).updated_at as Date).toISOString());
    expect(new Date(editing.updatedAt).getTime()).toBeGreaterThan(new Date("2026-01-02T00:00:00Z").getTime());
  });

  it("does not leak the commission estimator or the raw column names", async () => {
    const editing = await loadTradingSettingsForEditing();
    expect(Object.keys(editing).sort()).toEqual(
      [
        "commissionWarnSharePctOfPremium",
        "deltaTargetMax",
        "deltaTargetMin",
        "maxConcentrationPerTickerPct",
        "maxPositionPctOfPortfolio",
        "minAnnualizedYieldPct",
        "minCashReservePct",
        "recoveryDteMax",
        "recoveryDteMin",
        "updatedAt",
        "updatedByDisplayName",
      ].sort(),
    );
  });

  it("throws when the row is missing", async () => {
    await withoutSettingsRow(async () => {
      await expect(loadTradingSettingsForEditing()).rejects.toThrow("No trading_settings row found.");
    });
  });
});

describe("saveTradingSettings", () => {
  it("persists every field, stamps the saver and moves updated_at forward", async () => {
    const userId = await createUser("Saver");
    await saveTradingSettings(completeInput, userId);
    const row = await readRawRow();
    expect(Number(row.max_position_pct_of_portfolio)).toBe(11);
    expect(Number(row.max_concentration_per_ticker_pct)).toBe(22);
    expect(Number(row.min_cash_reserve_pct)).toBe(3.5);
    expect(Number(row.delta_target_min)).toBe(0.15);
    expect(Number(row.delta_target_max)).toBe(0.35);
    expect(row.recovery_dte_min).toBe(5);
    expect(row.recovery_dte_max).toBe(60);
    expect(Number(row.min_annualized_yield_pct)).toBe(40);
    expect(Number(row.commission_warn_share_of_premium_pct)).toBe(7.5);
    expect(row.updated_by_user_id).toBe(userId);
    expect((row.updated_at as Date).getTime()).toBeGreaterThan(new Date("2026-01-02T00:00:00Z").getTime());
    // And the loader reads back exactly what was saved.
    const { commissionEstimator: _estimator, ...loaded } = await loadTradingSettings();
    expect(loaded).toEqual(completeInput);
  });

  it("keeps exactly one row after a save", async () => {
    await saveTradingSettings(completeInput, await createUser("Saver"));
    expect(Number((await testDb("trading_settings").count({ count: "*" }).first())!.count)).toBe(1);
  });

  it("throws when no row exists, and creates none", async () => {
    const userId = await createUser("Saver");
    await withoutSettingsRow(async () => {
      await expect(saveTradingSettings(completeInput, userId)).rejects.toThrow("No trading_settings row found.");
      expect(Number((await testDb("trading_settings").count({ count: "*" }).first())!.count)).toBe(0);
    });
  });

  it("refuses an unknown saver id through the foreign key and leaves the row unchanged", async () => {
    await expect(saveTradingSettings(completeInput, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "23503" });
    const { commissionEstimator: _estimator, ...loaded } = await loadTradingSettings();
    expect(loaded.maxPositionPctOfPortfolio).toBe(10);
  });

  it("an invalid payload that skipped validation is stopped by the database and changes nothing", async () => {
    const userId = await createUser("Saver");
    await expect(saveTradingSettings({ ...completeInput, deltaTargetMin: 0.5, deltaTargetMax: 0.4 }, userId)).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_delta_band_valid" });
    const row = await readRawRow();
    expect(Number(row.delta_target_min)).toBe(0.2);
    expect(Number(row.max_position_pct_of_portfolio)).toBe(10);
    expect(row.updated_by_user_id).toBeNull();
  });
});

describe("database constraints on trading_settings", () => {
  it("rejects a second row, whichever id it carries", async () => {
    const { id: _id, ...values } = await readRawRow();
    await expect(testDb("trading_settings").insert({ ...values, id: true })).rejects.toMatchObject({ code: "23505", constraint: "trading_settings_pkey" });
    await expect(testDb("trading_settings").insert({ ...values, id: false })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_single_row" });
    expect(Number((await testDb("trading_settings").count({ count: "*" }).first())!.count)).toBe(1);
  });

  const percentageColumns = [
    "max_position_pct_of_portfolio",
    "max_concentration_per_ticker_pct",
    "min_cash_reserve_pct",
    "min_annualized_yield_pct",
    "commission_warn_share_of_premium_pct",
  ];

  for (const column of percentageColumns) {
    it(`${column} below 0 or above 100 is rejected, 0 and 100 are accepted`, async () => {
      for (const badValue of [-0.01, 100.01]) {
        await expect(testDb("trading_settings").update({ [column]: badValue })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_percentages_in_range" });
      }
      for (const edgeValue of [0, 100]) {
        await testDb("trading_settings").update({ [column]: edgeValue });
        expect(Number((await readRawRow())[column])).toBe(edgeValue);
      }
    });
  }

  it("rejects a delta band with min above max, and accepts min equal to max", async () => {
    await expect(testDb("trading_settings").update({ delta_target_min: 0.31, delta_target_max: 0.3 })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_delta_band_valid" });
    await testDb("trading_settings").update({ delta_target_min: 0.25, delta_target_max: 0.25 });
    const row = await readRawRow();
    expect(Number(row.delta_target_min)).toBe(0.25);
    expect(Number(row.delta_target_max)).toBe(0.25);
  });

  it("rejects a delta max above 1 and a negative delta min, and accepts the full 0 to 1 band", async () => {
    await expect(testDb("trading_settings").update({ delta_target_max: 1.0001 })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_delta_band_valid" });
    await expect(testDb("trading_settings").update({ delta_target_min: -0.0001 })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_delta_band_valid" });
    await testDb("trading_settings").update({ delta_target_min: 0, delta_target_max: 1 });
    expect(Number((await readRawRow()).delta_target_max)).toBe(1);
  });

  it("rejects a negative or inverted DTE window, and accepts 0 and a single-day window", async () => {
    await expect(testDb("trading_settings").update({ recovery_dte_min: -1 })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_dte_window_valid" });
    await expect(testDb("trading_settings").update({ recovery_dte_min: 46, recovery_dte_max: 45 })).rejects.toMatchObject({ code: "23514", constraint: "trading_settings_dte_window_valid" });
    await testDb("trading_settings").update({ recovery_dte_min: 0, recovery_dte_max: 0 });
    expect((await readRawRow()).recovery_dte_max).toBe(0);
  });

  it("rejects a null in any required column", async () => {
    await expect(testDb("trading_settings").update({ min_cash_reserve_pct: null })).rejects.toMatchObject({ code: "23502" });
    await expect(testDb("trading_settings").update({ recovery_dte_max: null })).rejects.toMatchObject({ code: "23502" });
  });
});

describe("loadRecoveryTargetWindow", () => {
  it("maps the delta band and the recovery_dte_* columns to dteTargetMin/dteTargetMax as numbers", async () => {
    await testDb("trading_settings").update({ delta_target_min: 0.12, delta_target_max: 0.34, recovery_dte_min: 7, recovery_dte_max: 21 });
    expect(await loadRecoveryTargetWindow()).toEqual({ deltaTargetMin: 0.12, deltaTargetMax: 0.34, dteTargetMin: 7, dteTargetMax: 21 });
  });

  it("returns null when trading_settings has no row", async () => {
    await withoutSettingsRow(async () => {
      expect(await loadRecoveryTargetWindow()).toBeNull();
    });
  });
});
