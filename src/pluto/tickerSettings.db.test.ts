import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Pluto's per-ticker settings, the strategy switch and the ladder's settings reader against the real test database,
// through the routes: stored, read back, audited, the 100% allocation rule and the paused-only switch.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run ticker settings tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("../routes/pluto.js");
const { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings } = await import("./tickerSettingsStore.js");
const { loadLadderCycleMemory, saveLadderCycleMemory } = await import("./ladderCycleMemory.js");

const testDb: Knex = db;
const suffix = `${Date.now() % 100000}`;
const enabledSymbol = `TSE${suffix}`;
const otherSymbol = `TSO${suffix}`;
const tickerIds: string[] = [];
let server: Server;
let baseUrl: string;
let userId: string;
let savedState: { mode: string; paused: boolean } | undefined;

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/pluto${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `ticker-settings-${suffix}`, display_name: "Ticker Settings Tester", password_hash: "not-a-real-hash", access_level: "admin" }).returning("id");
  userId = user.id;
  for (const [symbol, botEnabled] of [[enabledSymbol, true], [otherSymbol, false]] as const) {
    const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Ticker Settings Co" }).returning("id");
    tickerIds.push(ticker.id);
    await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, signals_enabled: true, bot_enabled: botEnabled });
  }
  savedState = await testDb("pluto_state").where({ id: 1 }).first("mode", "paused");
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
  if (savedState) await testDb("pluto_state").where({ id: 1 }).update(savedState);
  await testDb("pluto_settings").where({ id: 1 }).update({ execution_strategy: "edge_margin" });
  await testDb("pluto_events").whereRaw("payload->>'symbol' in (?, ?)", [enabledSymbol, otherSymbol]).del();
  await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb("pluto_settings_audit").where({ user_id: userId }).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("ticker settings routes", () => {
  it("reads a ticker with nothing set as all defaults, and 404s an unknown symbol", async () => {
    const read = await call("GET", `/ticker-settings/${enabledSymbol.toLowerCase()}`);
    expect(read.status).toBe(200);
    expect(read.json).toMatchObject({ symbol: enabledSymbol, allocationPct: null, ladderSharesPct: null, ladderShockOverridePct: null, updatedAt: null });
    expect((await call("GET", "/ticker-settings/NOSUCHTICKERX")).status).toBe(404);
    expect((await call("PUT", "/ticker-settings/NOSUCHTICKERX", { allocationPct: 10 })).status).toBe(404);
  });

  it("stores, reads back and audits each changed field; null puts one back to the default", async () => {
    const saved = await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: 12.5, ladderSharesPct: 30, ladderShockOverridePct: 70 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ allocationPct: 12.5, ladderSharesPct: 30, ladderShockOverridePct: 70, updatedByUserId: userId });
    const stored = await testDb("pluto_ticker_settings").where({ ticker_id: tickerIds[0] }).first();
    expect([Number(stored.allocation_pct), Number(stored.ladder_shares_pct), Number(stored.ladder_shock_override_pct)]).toEqual([12.5, 30, 70]);

    const cleared = await call("PUT", `/ticker-settings/${enabledSymbol}`, { ladderShockOverridePct: null, ladderSharesPct: 30 });
    expect(cleared.json).toMatchObject({ allocationPct: 12.5, ladderSharesPct: 30, ladderShockOverridePct: null });

    const audit = await call("GET", `/ticker-settings/audit?symbol=${enabledSymbol}`);
    const rows = audit.json as unknown as { field: string; oldValue: string | null; newValue: string | null; userDisplayName: string }[];
    expect(rows.map((row) => [row.field, row.oldValue, row.newValue])).toEqual([
      ["ladderShockOverridePct", "70", null],
      ["ladderShockOverridePct", null, "70"],
      ["ladderSharesPct", null, "30"],
      ["allocationPct", null, "12.5"],
    ]);
    expect(rows[0]?.userDisplayName).toBe("Ticker Settings Tester");
    const event = await testDb("pluto_events").where({ type: "settings_changed" }).whereRaw("payload->>'symbol' = ?", [enabledSymbol]).orderBy("id", "desc").first();
    expect(event.payload.fields).toEqual([{ field: "ladderShockOverridePct", from: 70, to: null }]);
  });

  it("refuses bad values and a total of set allocations above 100%, counting tickers that are not enabled", async () => {
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: 0 })).status).toBe(400);
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { ladderSharesPct: 100 })).status).toBe(400);
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { maxAbsDelta: 0.2 })).status).toBe(400);

    const othersRow = await testDb("pluto_ticker_settings").whereNotIn("ticker_id", tickerIds).sum({ total: "allocation_pct" }).first();
    const othersTotal = Number(othersRow?.total ?? 0);
    const room = 100 - othersTotal - 12.5;
    expect((await call("PUT", `/ticker-settings/${otherSymbol}`, { allocationPct: room })).status).toBe(200);
    const refused = await call("PUT", `/ticker-settings/${otherSymbol}`, { allocationPct: room + 0.5 });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/at most 100%/);
    expect((await call("PUT", `/ticker-settings/${otherSymbol}`, { allocationPct: null })).json).toMatchObject({ allocationPct: null });
  });

  it("lists enabled tickers only, each with its allocation after the equal split", async () => {
    const listed = (await call("GET", "/ticker-settings")).json as unknown as { symbol: string; allocationPct: number | null; effectiveAllocationPct: number }[];
    expect(listed.some((ticker) => ticker.symbol === otherSymbol)).toBe(false);
    expect(listed.find((ticker) => ticker.symbol === enabledSymbol)).toMatchObject({ allocationPct: 12.5, effectiveAllocationPct: 12.5 });
  });
});

describe("rungs and delta range per ticker", () => {
  it("stores them, refuses a fractional rung count and a range whose lower limit passes the upper one (the strategy's side counts)", async () => {
    expect((await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderRungs: 2.5 })).status).toBe(400);
    expect((await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderRungs: 21 })).status).toBe(400);
    const settingsRow = await testDb("pluto_settings").where({ id: 1 }).first("ladder_max_abs_delta");
    const aboveStrategyTop = Number(settingsRow.ladder_max_abs_delta) + 0.05;
    const refused = await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderMinAbsDelta: aboveStrategyTop });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/lower limit cannot exceed the upper one/);
    expect((await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderMinAbsDelta: aboveStrategyTop, ladderMaxAbsDelta: aboveStrategyTop + 0.1 })).status).toBe(200);
    const saved = await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderRungs: 4, ladderMinAbsDelta: 0.08, ladderMaxAbsDelta: 0.25 });
    expect(saved.json).toMatchObject({ ladderRungs: 4, ladderMinAbsDelta: 0.08, ladderMaxAbsDelta: 0.25 });
  });

  it("the reader gives the effective values, the strategy's values and the overrides apart", async () => {
    const read = await call("GET", `/ladder-settings/${otherSymbol}`);
    const settingsRow = await testDb("pluto_settings").where({ id: 1 }).first("ladder_rungs", "ladder_min_abs_delta", "ladder_max_abs_delta");
    expect(read.json.baseline).toMatchObject({ ladderRungs: 4, minAbsDelta: 0.08, maxAbsDelta: 0.25 });
    expect(read.json.strategyBaseline).toMatchObject({ ladderRungs: settingsRow.ladder_rungs, minAbsDelta: Number(settingsRow.ladder_min_abs_delta), maxAbsDelta: Number(settingsRow.ladder_max_abs_delta) });
    expect(read.json.tickerOverrides).toEqual({ ladderSharesPct: null, ladderRungs: 4, minAbsDelta: 0.08, maxAbsDelta: 0.25 });
    await call("PUT", `/ticker-settings/${otherSymbol}`, { ladderRungs: null, ladderMinAbsDelta: null, ladderMaxAbsDelta: null });
    expect((await call("GET", `/ladder-settings/${otherSymbol}`)).json.tickerOverrides).toEqual({ ladderSharesPct: null, ladderRungs: null, minAbsDelta: null, maxAbsDelta: null });
  });
});

describe("ladder settings reader", () => {
  it("gives the ladder's values in backtest form with the ticker's overrides, and the pot from last night's account value", async () => {
    const read = await call("GET", `/ladder-settings/${enabledSymbol}`);
    expect(read.status).toBe(200);
    const settingsRow = await testDb("pluto_settings").where({ id: 1 }).first();
    expect(read.json).toMatchObject({ symbol: enabledSymbol, source: "live", enabled: false, allocationPct: 12.5, overrideShockPct: null });
    expect(read.json.baseline).toMatchObject({ entry: "covered_call", putsWhenNoCall: "reserve_ladder", ladderSharesPct: 30, maxAbsDelta: Number(settingsRow.ladder_max_abs_delta), ladderRungs: settingsRow.ladder_rungs });
    const version = await testDb("pluto_settings_versions").where({ id: read.json.settingsVersionId as string }).first("settings");
    expect(version.settings.executionStrategy).toBe(settingsRow.execution_strategy);

    const snapshot = await testDb("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value");
    const effective = effectiveAllocationPctBySymbol(await loadEnabledPlutoTickerSettings()).get(enabledSymbol)!;
    const expectedPot = snapshot ? (Number(snapshot.net_liquidation_value) * (Number(settingsRow.capital_budget_pct) / 100) * effective) / 100 : null;
    expect(read.json.potDollars).toBeCloseTo(expectedPot as number, 6);
  });

  it("gives a ticker not enabled in Pluto no pot, and an unknown symbol the strategy values only", async () => {
    expect((await call("GET", `/ladder-settings/${otherSymbol}`)).json).toMatchObject({ enabled: false, potDollars: null, allocationPct: null });
    const unknown = await call("GET", "/ladder-settings/nosuchtickery");
    expect(unknown.json).toMatchObject({ symbol: "NOSUCHTICKERY", enabled: false, potDollars: null, allocationPct: null, overrideShockPct: null, recommendedShockPct: null });
    // The test tickers have no daily bars: under 250 closes, the new-listing shock.
    expect((await call("GET", `/ladder-settings/${otherSymbol}`)).json.recommendedShockPct).toBe(90);
    expect((unknown.json.baseline as { ladderSharesPct: number }).ladderSharesPct).toBeGreaterThan(0);
  });
});

describe("strategy switch", () => {
  it("is refused while Pluto runs, allowed while paused; under the ladder Pluto resumes like under Edge Margin", async () => {
    await testDb("pluto_state").where({ id: 1 }).update({ mode: "on", paused: false });
    const refused = await call("PUT", "/settings", { executionStrategy: "cc_put_ladder" });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toMatch(/Pause Pluto/);

    await testDb("pluto_state").where({ id: 1 }).update({ paused: true });
    // A memory from an earlier ladder period is stored and read back, then forgotten by the switch: a cycle open at the switch starts there.
    const earlier = { startedOn: "2026-09-01", accountValueAtStart: 180_000, shock: 0.7 };
    await saveLadderCycleMemory(tickerIds[0]!, { ...earlier, shock: 0.65 });
    await saveLadderCycleMemory(tickerIds[0]!, earlier);
    expect(await loadLadderCycleMemory(tickerIds[0]!)).toEqual(earlier);
    const switched = await call("PUT", "/settings", { executionStrategy: "cc_put_ladder" });
    expect(switched.status).toBe(200);
    expect(await loadLadderCycleMemory(tickerIds[0]!)).toBeNull();
    expect(switched.json.executionStrategy).toBe("cc_put_ladder");
    expect((await call("GET", `/ladder-settings/${enabledSymbol}`)).json.enabled).toBe(true);

    // Under the ladder (built), Pluto resumes and switches on like under Edge Margin; switching back needs a pause again.
    expect((await call("POST", "/resume")).status).toBe(200);
    expect((await testDb("pluto_state").where({ id: 1 }).first("paused")).paused).toBe(false);
    expect((await call("PUT", "/settings", { executionStrategy: "edge_margin" })).status).toBe(400);
    await testDb("pluto_state").where({ id: 1 }).update({ mode: "off", paused: true });
    expect((await call("PUT", "/settings", { executionStrategy: "edge_margin" })).status).toBe(200);
    expect((await call("PUT", "/mode", { mode: "on" })).status).toBe(200);
    expect((await call("GET", "/state")).json.blockReason).toMatch(/paused/);
    if (savedState) await testDb("pluto_state").where({ id: 1 }).update(savedState);
  });
});

describe("ladder settings screen reads", () => {
  it("lists the shortlisted tickers' ladder settings with the fit checks' price, the budget and the shock's source", async () => {
    await testDb("daily_price_bars").insert({ ticker_id: tickerIds[0], trading_date: "2026-10-14", close_price: 106.01 });
    const list = await call("GET", "/ladder-settings");
    expect(list.status).toBe(200);
    const rows = list.json as unknown as { symbol: string; lastClose: { price: number; date: string } | null; recommendedShockSource: { closesUsed: number } | null; capitalBudgetDollars: number | null }[];
    const enabled = rows.find((row) => row.symbol === enabledSymbol)!;
    expect(enabled.lastClose).toEqual({ price: 106.01, date: "2026-10-14" });
    expect(enabled.recommendedShockSource).toMatchObject({ closesUsed: 1 });
    expect(rows.find((row) => row.symbol === otherSymbol)?.lastClose).toBeNull();
    const one = await call("GET", `/ladder-settings/${enabledSymbol.toLowerCase()}`);
    expect(one.json).toMatchObject({ symbol: enabledSymbol, lastClose: { price: 106.01 } });
    await testDb("daily_price_bars").where({ ticker_id: tickerIds[0] }).del();
  });

  it("numbers the current settings version and says since when", async () => {
    const version = await call("GET", "/settings/version");
    expect(version.status).toBe(200);
    expect(version.json.number).toBeGreaterThanOrEqual(1);
    expect(typeof version.json.versionId).toBe("string");
  });

  it("refuses a strategy |delta| change that would leave a ticker's own range empty, naming it", async () => {
    const before = (await call("GET", "/settings")).json as { ladderMinAbsDelta: number; ladderMaxAbsDelta: number };
    await call("PUT", `/ticker-settings/${enabledSymbol}`, { ladderMaxAbsDelta: 0.25 });
    const refused = await call("PUT", "/settings", { ladderMinAbsDelta: 0.3 });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain(`${enabledSymbol}'s |delta| range would be 0.30–0.25 (it sets its own upper limit)`);
    expect((await call("GET", "/settings")).json.ladderMinAbsDelta).toBe(before.ladderMinAbsDelta);
    await call("PUT", `/ticker-settings/${enabledSymbol}`, { ladderMaxAbsDelta: null });
  });
});
