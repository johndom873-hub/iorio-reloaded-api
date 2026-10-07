import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// Audit B (2026-10-07): maxDayMoveMultiple replaces maxAbsDayChangePct (column max_day_move_multiple, decimal(6,2), default 3).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { loadPlutoSettings, plutoSettingsColumns, validatePlutoSettingsInput } = await import("./settingsStore.js");
const testDb: Knex = db;

afterAll(async () => {
  await testDb.destroy();
});

describe("maxDayMoveMultiple setting", () => {
  it("maps to max_day_move_multiple; the old field is gone", () => {
    expect(plutoSettingsColumns.maxDayMoveMultiple).toEqual({ column: "max_day_move_multiple", kind: "number", min: 0.5, max: 100 });
    expect(Object.keys(plutoSettingsColumns)).not.toContain("maxAbsDayChangePct");
  });

  it("the old maxAbsDayChangePct field is refused as unknown (an old client gets a 400, not a silent no-op)", async () => {
    const current = await loadPlutoSettings(testDb);
    expect(validatePlutoSettingsInput({ maxAbsDayChangePct: 6 } as never, current)).toBe("maxAbsDayChangePct is not a Pluto setting.");
  });

  it("validates as a number from 0.5 to 100", async () => {
    const current = await loadPlutoSettings(testDb);
    expect(validatePlutoSettingsInput({ maxDayMoveMultiple: -1 }, current)).toBe("maxDayMoveMultiple cannot be below 0.5.");
    expect(validatePlutoSettingsInput({ maxDayMoveMultiple: "3" as unknown as number }, current)).toBe("maxDayMoveMultiple must be a number.");
    expect(validatePlutoSettingsInput({ maxDayMoveMultiple: 2.5 }, current)).toBeNull();
  });

  // The column is decimal(6,2): 10000 would overflow at UPDATE (a 500), and 0 would block every ticker that moved at all.
  it("refuses 0 and 10000 (the column cannot hold 10000)", async () => {
    const current = await loadPlutoSettings(testDb);
    expect(validatePlutoSettingsInput({ maxDayMoveMultiple: 0 }, current)).toBe("maxDayMoveMultiple cannot be below 0.5.");
    expect(validatePlutoSettingsInput({ maxDayMoveMultiple: 10_000 }, current)).toBe("maxDayMoveMultiple cannot be above 100.");
    const column = await testDb("information_schema.columns").where({ table_name: "pluto_settings", column_name: "max_day_move_multiple" }).first("numeric_precision", "numeric_scale", "column_default", "is_nullable");
    expect(column).toMatchObject({ numeric_precision: 6, numeric_scale: 2, is_nullable: "NO" });
    await expect(testDb.raw("select ?::numeric(6,2) as v", [10_000])).rejects.toThrow(/numeric field overflow/);
  });

  it("loads from the migrated test database as a number", async () => {
    const settings = await loadPlutoSettings(testDb);
    expect(typeof settings.maxDayMoveMultiple).toBe("number");
    expect(Number.isFinite(settings.maxDayMoveMultiple)).toBe(true);
    expect(settings).not.toHaveProperty("maxAbsDayChangePct");
    const columns = (await testDb("information_schema.columns").where({ table_name: "pluto_settings" }).pluck("column_name")) as string[];
    expect(columns).not.toContain("max_abs_day_change_pct");
    const actionColumns = (await testDb("information_schema.columns").where({ table_name: "pluto_actions" }).pluck("column_name")) as string[];
    expect(actionColumns).not.toContain("pessimistic_pnl");
  });

  it("the prompt_version default follows the last prompt migration (v3.6)", async () => {
    const column = await testDb("information_schema.columns").where({ table_name: "pluto_settings", column_name: "prompt_version" }).first("column_default");
    expect(String(column.column_default)).toContain("v3.6");
  });
});
