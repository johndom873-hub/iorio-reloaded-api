import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// Pluto's per-ticker settings (the allocation) and the Tickers tab's allocations and pots against the real test database,
// through the routes: stored, read back, audited, and the 100% allocation rule.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run ticker settings tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const { plutoRouter } = await import("../routes/pluto.js");
const { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadShortlistedPlutoTickerSettings } = await import("./tickerSettingsStore.js");

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
    await testDb("shortlist_entries").insert({ ticker_id: ticker.id, added_by_user_id: userId, bot_enabled: botEnabled });
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
  await testDb("pluto_events").whereRaw("payload->>'symbol' in (?, ?)", [enabledSymbol, otherSymbol]).del();
  await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb("pluto_settings_audit").where({ user_id: userId }).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

describe("the shortlist's settings for the after-close volume capture", () => {
  it("lists every shortlisted ticker with its settings and whether Pluto is enabled on it", async () => {
    const ours = (await loadShortlistedPlutoTickerSettings()).filter((ticker) => ticker.symbol === enabledSymbol || ticker.symbol === otherSymbol);
    expect(ours.map((ticker) => [ticker.symbol, ticker.enabled])).toEqual([[enabledSymbol, true], [otherSymbol, false]]);
    expect((await loadEnabledPlutoTickerSettings()).some((ticker) => ticker.symbol === otherSymbol)).toBe(false);
  });
});

describe("ticker settings routes", () => {
  it("reads a ticker with nothing set as all defaults, and 404s an unknown symbol", async () => {
    const read = await call("GET", `/ticker-settings/${enabledSymbol.toLowerCase()}`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual({ symbol: enabledSymbol, tickerId: tickerIds[0], allocationPct: null, updatedAt: null, updatedByUserId: null });
    expect((await call("GET", "/ticker-settings/NOSUCHTICKERX")).status).toBe(404);
    expect((await call("PUT", "/ticker-settings/NOSUCHTICKERX", { allocationPct: 10 })).status).toBe(404);
  });

  it("stores, reads back and audits the allocation; null puts it back to an equal share", async () => {
    const saved = await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: 20 });
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ allocationPct: 20, updatedByUserId: userId });
    expect(Number((await testDb("pluto_ticker_settings").where({ ticker_id: tickerIds[0] }).first()).allocation_pct)).toBe(20);
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: null })).json).toMatchObject({ allocationPct: null });
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: 12.5 })).json).toMatchObject({ allocationPct: 12.5 });

    const audit = await call("GET", `/ticker-settings/audit?symbol=${enabledSymbol}`);
    const rows = audit.json as unknown as { field: string; oldValue: string | null; newValue: string | null; userDisplayName: string }[];
    expect(rows.map((row) => [row.field, row.oldValue, row.newValue])).toEqual([
      ["allocationPct", null, "12.5"],
      ["allocationPct", "20", null],
      ["allocationPct", null, "20"],
    ]);
    expect(rows[0]?.userDisplayName).toBe("Ticker Settings Tester");
    const event = await testDb("pluto_events").where({ type: "settings_changed" }).whereRaw("payload->>'symbol' = ?", [enabledSymbol]).orderBy("id", "desc").first();
    expect(event.payload.fields).toEqual([{ field: "allocationPct", from: null, to: 12.5 }]);
  });

  it("refuses bad values and a total of set allocations above 100%, counting tickers that are not enabled", async () => {
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { allocationPct: 0 })).status).toBe(400);
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { maxAbsDelta: 0.2 })).status).toBe(400);
    // The CC + Put Ladder's per-ticker values and strategy choice retired with it (2026-11-02).
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { ladderSharesPct: 30 })).status).toBe(400);
    expect((await call("PUT", `/ticker-settings/${enabledSymbol}`, { strategy: "cc_put_ladder" })).status).toBe(400);

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

describe("the Tickers tab's allocations and pots", () => {
  it("gives each shortlisted ticker its allocation, its pot from last night's account value while enabled, and Pluto's budget", async () => {
    const list = await call("GET", "/ticker-allocations");
    expect(list.status).toBe(200);
    const rows = list.json as unknown as { symbol: string; enabled: boolean; allocationPct: number | null; potDollars: number | null; capitalBudgetDollars: number | null }[];
    const settingsRow = await testDb("pluto_settings").where({ id: 1 }).first("capital_budget_pct", "excess_allowance_pct");
    const snapshot = await testDb("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value");
    const effective = effectiveAllocationPctBySymbol(await loadEnabledPlutoTickerSettings()).get(enabledSymbol)!;
    const accountValue = snapshot ? Number(snapshot.net_liquidation_value) : null;
    // The pot: the account value × the allocation × (1 + the excess allowance) × Pluto's budget.
    const expectedPot = accountValue === null ? null : (accountValue * effective * (100 + Number(settingsRow.excess_allowance_pct)) * Number(settingsRow.capital_budget_pct)) / 1_000_000;
    const enabled = rows.find((row) => row.symbol === enabledSymbol)!;
    expect(enabled).toMatchObject({ enabled: true, allocationPct: 12.5, capitalBudgetDollars: accountValue === null ? null : (accountValue * Number(settingsRow.capital_budget_pct)) / 100 });
    if (expectedPot === null) expect(enabled.potDollars).toBeNull();
    else expect(enabled.potDollars).toBeCloseTo(expectedPot, 6);
    expect(rows.find((row) => row.symbol === otherSymbol)).toMatchObject({ enabled: false, allocationPct: null, potDollars: null });
    // The CC + Put Ladder's settings reads retired with it (2026-11-02).
    expect((await fetch(`${baseUrl}/pluto/ladder-settings`)).status).toBe(404);
  });
});

describe("Pluto's switch", () => {
  it("resumes and switches on with no strategy to choose, and refuses a strategy setting", async () => {
    await testDb("pluto_state").where({ id: 1 }).update({ mode: "on", paused: true });
    expect((await call("PUT", "/settings", { executionStrategy: "cc_put_ladder" })).json.error).toBe("executionStrategy is not a Pluto setting.");
    expect((await call("POST", "/resume")).status).toBe(200);
    expect((await testDb("pluto_state").where({ id: 1 }).first("paused")).paused).toBe(false);
    await testDb("pluto_state").where({ id: 1 }).update({ mode: "off", paused: true });
    expect((await call("PUT", "/mode", { mode: "on" })).status).toBe(200);
    expect((await call("GET", "/state")).json.blockReason).toMatch(/paused/);
    if (savedState) await testDb("pluto_state").where({ id: 1 }).update(savedState);
  });
});

describe("the settings version", () => {
  it("numbers the current settings version and says since when", async () => {
    const version = await call("GET", "/settings/version");
    expect(version.status).toBe(200);
    expect(version.json.number).toBeGreaterThanOrEqual(1);
    expect(typeof version.json.versionId).toBe("string");
  });
});

describe("the Tickers tab's allocations save", () => {
  const allocationOf = async (symbol: string) => (await call("GET", `/ticker-settings/${symbol}`)).json.allocationPct as number | null;
  const allowanceNow = async () => Number((await testDb("pluto_settings").where({ id: 1 }).first("excess_allowance_pct")).excess_allowance_pct);

  it("saves the allocations and the excess allowance together, audited, with one event per ticker and one for the allowance; the pot includes the allowance", async () => {
    const [enabledBefore, otherBefore, allowanceBefore] = [await allocationOf(enabledSymbol), await allocationOf(otherSymbol), await allowanceNow()];
    try {
      const saved = await call("PUT", "/allocations", { allocations: { [enabledSymbol]: 20, [otherSymbol]: 5 }, excessAllowancePct: 26.3158 });
      expect(saved.status).toBe(200);
      expect(saved.json).toEqual({ allocations: [{ symbol: enabledSymbol, from: enabledBefore, to: 20 }, { symbol: otherSymbol, from: otherBefore, to: 5 }], excessAllowance: { from: allowanceBefore, to: 26.3158 } });
      expect([await allocationOf(enabledSymbol), await allocationOf(otherSymbol), await allowanceNow()]).toEqual([20, 5, 26.3158]);
      const tickerAudit = await testDb("pluto_ticker_settings_audit").whereIn("ticker_id", tickerIds).where({ field: "allocationPct" }).orderBy("id", "desc").limit(2).select("new_value");
      expect(tickerAudit.map((row) => row.new_value).sort()).toEqual(["20", "5"]);
      expect(await testDb("pluto_settings_audit").where({ user_id: userId, field: "excessAllowancePct" }).orderBy("id", "desc").first("new_value")).toEqual({ new_value: "26.3158" });
      const events = await testDb("pluto_events").where({ type: "settings_changed" }).whereRaw("payload->>'by' = ?", ["Ticker Settings Tester"]).orderBy("id", "desc").limit(3).select("payload");
      expect(events.map((event) => event.payload)).toEqual(
        expect.arrayContaining([
          { by: "Ticker Settings Tester", symbol: enabledSymbol, fields: [{ field: "allocationPct", from: enabledBefore, to: 20 }] },
          { by: "Ticker Settings Tester", symbol: otherSymbol, fields: [{ field: "allocationPct", from: otherBefore, to: 5 }] },
          { by: "Ticker Settings Tester", fields: [{ field: "excessAllowancePct", from: allowanceBefore, to: 26.3158 }] },
        ]),
      );
      // The pot: last night's account value × 20% × (1 + 26.3158%) × Pluto's budget.
      const snapshot = await testDb("account_pnl_snapshots").whereNotNull("net_liquidation_value").orderBy("snapshot_date", "desc").first("net_liquidation_value");
      const budgetPct = Number((await testDb("pluto_settings").where({ id: 1 }).first("capital_budget_pct")).capital_budget_pct);
      const pots = (await call("GET", "/ticker-allocations")).json as unknown as { symbol: string; potDollars: number | null }[];
      if (snapshot) expect(pots.find((row) => row.symbol === enabledSymbol)!.potDollars).toBeCloseTo((Number(snapshot.net_liquidation_value) * 20 * 126.3158 * budgetPct) / 1_000_000, 6);
    } finally {
      await testDb("pluto_ticker_settings").where({ ticker_id: tickerIds[0] }).update({ allocation_pct: enabledBefore });
      await testDb("pluto_ticker_settings").where({ ticker_id: tickerIds[1] }).update({ allocation_pct: otherBefore });
      await testDb("pluto_settings").where({ id: 1 }).update({ excess_allowance_pct: allowanceBefore });
      await testDb("pluto_events").where({ type: "settings_changed" }).whereRaw("payload->>'by' = ?", ["Ticker Settings Tester"]).del();
    }
  });

  it("changes nothing when any part is refused: a total above 100%, an unknown ticker, an allowance out of range, a bad body", async () => {
    const [enabledBefore, otherBefore, allowanceBefore] = [await allocationOf(enabledSymbol), await allocationOf(otherSymbol), await allowanceNow()];
    const othersRow = await testDb("pluto_ticker_settings").whereNotIn("ticker_id", tickerIds).sum({ total: "allocation_pct" }).first();
    const room = 100 - Number(othersRow?.total ?? 0);
    const overTotal = await call("PUT", "/allocations", { allocations: { [enabledSymbol]: room - 1, [otherSymbol]: 2 }, excessAllowancePct: 10 });
    expect(overTotal.status).toBe(400);
    expect(overTotal.json.error).toMatch(/at most 100%/);
    expect((await call("PUT", "/allocations", { allocations: { [enabledSymbol]: 1, NOSUCHTICKERZ: 1 }, excessAllowancePct: 10 })).status).toBe(404);
    expect((await call("PUT", "/allocations", { allocations: { [enabledSymbol]: 1 }, excessAllowancePct: 1001 })).status).toBe(400);
    expect((await call("PUT", "/allocations", { allocations: { [enabledSymbol]: 1 }, excessAllowancePct: -1 })).status).toBe(400);
    expect((await call("PUT", "/allocations", { allocations: { [enabledSymbol]: 0 } })).status).toBe(400);
    expect((await call("PUT", "/allocations", { allocations: [] })).status).toBe(400);
    expect((await call("PUT", "/allocations", { allocations: {}, budget: 5 })).status).toBe(400);
    expect([await allocationOf(enabledSymbol), await allocationOf(otherSymbol), await allowanceNow()]).toEqual([enabledBefore, otherBefore, allowanceBefore]);
  });
});
