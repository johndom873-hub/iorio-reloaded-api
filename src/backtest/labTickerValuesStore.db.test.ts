import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// A ticker's own Vol Farmer v4 values on a private copy of the test database: saved and audited, a value equal to the
// lab's stored as null, a ticker left with none deleted, refusals; and how they reach the stored analyses' out of date.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { up: createTickerValuesTable } = await import("../db/migrations/20261102300001_create_backtest_lab_ticker_values.js");
const { BacktestLabSettingsValidationError, loadBacktestLabAudit, loadBacktestLabSettings, updateBacktestLabSettings } = await import("./labSettingsStore.js");
const { loadAllTickerOwnValues, loadTickerOwnValues, loadTickerOwnValuesOverview, saveTickerOwnValues } = await import("./labTickerValuesStore.js");
const { analysesOutOfDateAfter, analysisLabValuesOf, loadAnalysesForTable } = await import("./analysis/analysisStore.js");
const { analysisFormulasVersion } = await import("./analysis/analysisFigures.js");

const testDb: Knex = db;
const symbol = "TVAL";
let userId: string;

beforeAll(async () => {
  // The lab seeds from Pluto's and the trading settings: copied from the shared schema. The table comes with the copy once
  // the test database is migrated; until then, from the migration.
  await testDb.raw("INSERT INTO pluto_settings SELECT * FROM public.pluto_settings");
  await testDb.raw("INSERT INTO trading_settings SELECT * FROM public.trading_settings");
  if (!(await testDb.schema.hasTable("backtest_lab_ticker_values"))) await createTickerValuesTable(testDb);
  const [user] = await testDb("users").insert({ username: "ticker-values-tester", display_name: "Ticker Values Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;
  await loadBacktestLabSettings();
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("a ticker's own values", () => {
  it("saves the given values, a value equal to the lab's as null, and audits each change under the ticker", async () => {
    const { saved, changes } = await saveTickerOwnValues("tval", { callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: 80 }, userId);
    // The lab's First position is 80%: not a value of its own.
    expect(saved?.values).toEqual({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: null, putMaxAbsDelta: null, leapsMaxAccountPct: null });
    expect(changes).toEqual([
      { field: "volFarmerV4.callMinAbsDelta", oldValue: null, newValue: 0.1 },
      { field: "volFarmerV4.callMaxAbsDelta", oldValue: null, newValue: 0.4 },
    ]);
    const row = await testDb("backtest_lab_ticker_values").where({ symbol }).first();
    expect(row).toMatchObject({ call_min_abs_delta: "0.1000", call_max_abs_delta: "0.4000", first_position_pct: null, updated_by_user_id: userId });
    const audit = await loadBacktestLabAudit({ symbol });
    expect(audit.map(({ symbol: auditSymbol, field, oldValue, newValue }) => ({ auditSymbol, field, oldValue, newValue }))).toEqual([
      { auditSymbol: symbol, field: "volFarmerV4.callMaxAbsDelta", oldValue: null, newValue: "0.4" },
      { auditSymbol: symbol, field: "volFarmerV4.callMinAbsDelta", oldValue: null, newValue: "0.1" },
    ]);
    expect(await loadBacktestLabAudit({ symbol: null })).toEqual([]);
  });

  it("keeps the fields left out, and reads back one ticker, all of them and the lab's five", async () => {
    const { saved, changes } = await saveTickerOwnValues(symbol, { leapsMaxAccountPct: 0 }, userId);
    expect(saved?.values).toEqual({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4, firstPositionPct: null, putMaxAbsDelta: null, leapsMaxAccountPct: 0 });
    expect(changes).toEqual([{ field: "volFarmerV4.leapsMaxAccountPct", oldValue: null, newValue: 0 }]);
    expect((await loadTickerOwnValues(symbol))?.values.leapsMaxAccountPct).toBe(0);
    expect(Object.keys(await loadAllTickerOwnValues())).toEqual([symbol]);
    const overview = await loadTickerOwnValuesOverview();
    expect(overview.labValues).toEqual({ callMinAbsDelta: 0.05, callMaxAbsDelta: 0.5, firstPositionPct: 80, putMaxAbsDelta: 0.3, leapsMaxAccountPct: 10 });
    expect(overview.bySymbol[symbol]?.values.callMaxAbsDelta).toBe(0.4);
  });

  it("refuses a value out of the lab's range, one not of the five, and a Calls' range whose from is above its to with the lab's", async () => {
    await expect(saveTickerOwnValues(symbol, { firstPositionPct: 95 }, userId)).rejects.toThrow(/firstPositionPct must be a number from 10 to 90, or null for the lab's value/);
    await expect(saveTickerOwnValues(symbol, { putMaxAbsDelta: "0.2" }, userId)).rejects.toThrow(BacktestLabSettingsValidationError);
    await expect(saveTickerOwnValues(symbol, { rebalanceBandPct: 5 }, userId)).rejects.toThrow(/not a value a ticker can have/);
    // Its own to is 0.40: a from of 0.45 is above it.
    await expect(saveTickerOwnValues(symbol, { callMinAbsDelta: 0.45 }, userId)).rejects.toThrow(/TVAL: volFarmerV4.callMinAbsDelta must not be above volFarmerV4.callMaxAbsDelta/);
    // Its to back to the lab's 0.50: the merged range is checked, so a from of 0.45 is fine then.
    await expect(saveTickerOwnValues(symbol, { callMinAbsDelta: 0.45, callMaxAbsDelta: null }, userId)).resolves.toMatchObject({ saved: { values: { callMinAbsDelta: 0.45, callMaxAbsDelta: null } } });
    await saveTickerOwnValues(symbol, { callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4 }, userId);
    expect((await loadTickerOwnValues(symbol))?.values).toMatchObject({ callMinAbsDelta: 0.1, callMaxAbsDelta: 0.4 });
  });

  it("a save that changes nothing writes nothing", async () => {
    const before = (await loadBacktestLabAudit({ symbol })).length;
    const { changes } = await saveTickerOwnValues(symbol, { callMinAbsDelta: 0.1 }, userId);
    expect(changes).toEqual([]);
    expect(await loadBacktestLabAudit({ symbol })).toHaveLength(before);
  });

  it("a lab change to a value the ticker holds leaves its analysis current; one of its own values puts it out of date", async () => {
    const lab = await loadBacktestLabSettings();
    const own = (await loadTickerOwnValues(symbol))!.values;
    const values = analysisLabValuesOf(lab, own, null);
    const { hash, ...labValues } = values;
    await testDb("backtest_ticker_analyses").insert({ symbol, status: "succeeded", formulas_version: analysisFormulasVersion, lab_values: JSON.stringify(labValues), lab_values_hash: hash, reason: "ticker_settings", summary_status: "skipped", finished_at: testDb.fn.now() });
    expect((await loadAnalysesForTable()).bySymbol[symbol]?.outOfDate).toBe(false);

    // The lab's Calls' |delta| from: TVAL holds its own.
    const fromSaved = await updateBacktestLabSettings({ overrides: { volFarmerV4: { callMinAbsDelta: 0.08 } } }, userId);
    expect(await analysesOutOfDateAfter(fromSaved.lab, ["volFarmerV4.callMinAbsDelta"])).toEqual({ outOfDate: [], byPath: { "volFarmerV4.callMinAbsDelta": [] } });
    expect((await loadAnalysesForTable()).bySymbol[symbol]?.outOfDate).toBe(false);

    // The lab's Put |delta|: TVAL reads the lab's.
    const putSaved = await updateBacktestLabSettings({ overrides: { volFarmerV4: { putMaxAbsDelta: 0.25 } } }, userId);
    expect(await analysesOutOfDateAfter(putSaved.lab, ["volFarmerV4.putMaxAbsDelta"])).toEqual({ outOfDate: [symbol], byPath: { "volFarmerV4.putMaxAbsDelta": [symbol] } });
    await updateBacktestLabSettings({ overrides: { volFarmerV4: { putMaxAbsDelta: 0.3 } } }, userId);
    expect((await loadAnalysesForTable()).bySymbol[symbol]?.outOfDate).toBe(false);

    // Its own Calls' |delta| to changed after the analysis ran.
    await saveTickerOwnValues(symbol, { callMaxAbsDelta: 0.45 }, userId);
    const table = await loadAnalysesForTable();
    expect(table.bySymbol[symbol]?.outOfDate).toBe(true);
    expect(table.outOfDate).toEqual([symbol]);
    expect(table.tickerValuesBySymbol[symbol]?.values.callMaxAbsDelta).toBe(0.45);
    expect(table.labTickerFieldValues.callMinAbsDelta).toBe(0.08);
  });

  it("a ticker left with no values of its own has no row", async () => {
    const { saved, changes } = await saveTickerOwnValues(symbol, { callMinAbsDelta: null, callMaxAbsDelta: null, leapsMaxAccountPct: null }, userId);
    expect(saved).toBeNull();
    expect(changes.map((change) => change.field)).toEqual(["volFarmerV4.callMinAbsDelta", "volFarmerV4.callMaxAbsDelta", "volFarmerV4.leapsMaxAccountPct"]);
    expect(changes.every((change) => change.newValue === null)).toBe(true);
    expect(await testDb("backtest_lab_ticker_values").where({ symbol }).first()).toBeUndefined();
    expect(await loadAllTickerOwnValues()).toEqual({});
  });
});
