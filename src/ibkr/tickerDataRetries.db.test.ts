import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { TickerDataRetryDependencies } from "./tickerDataRetries.js";

// The retry pass on a private copy of the test tables, with only IBKR faked: what counts as missing (a chain not fetched today,
// a 5-year history never completed), the tries counted in ticker_data_retries, the give-up and its one alert, and a history
// completed by a retry counting as complete (dailyBarsStatus.ts).
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { defaultTickerDataRetryDependencies, loadTickerDataRetryRows, recordTickerDataSuccess, runTickerDataRetryPass } = await import("./tickerDataRetries.js");
const { loadDailyBarsStatus } = await import("../lib/dailyBarsStatus.js");
const testDb: Knex = db;

const today = "2026-11-09";
const now = new Date("2026-11-09T15:00:00Z");
const ids = { staleChain: randomUUID(), fresh: randomUUID(), noHistory: randomUUID(), preparing: randomUUID() };

async function shortlist(tickerId: string, symbol: string): Promise<void> {
  await testDb("tickers").insert({ id: tickerId, symbol, company_name: `${symbol} Co`, ibkr_contract_id: 1000 });
  await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: randomUUID(), bot_enabled: false });
}

const historyDone = JSON.stringify([{ key: "history", status: "done" }]);

beforeAll(async () => {
  await shortlist(ids.staleChain, "STALE");
  await shortlist(ids.fresh, "FRESH");
  await shortlist(ids.noHistory, "NOHIST");
  await shortlist(ids.preparing, "PREP");
  await testDb("option_chain_params").insert([
    { ticker_id: ids.staleChain, expirations: ["20261113"], fetched_at: "2026-11-06T09:01:00Z" },
    { ticker_id: ids.fresh, expirations: ["20261113"], fetched_at: "2026-11-09T09:01:00Z" },
    { ticker_id: ids.noHistory, expirations: ["20261113"], fetched_at: "2026-11-09T09:02:00Z" },
  ]);
  // STALE's history came from its setup; FRESH's, a young listing, from a retry on an earlier day; NOHIST has recent bars only.
  await testDb("ticker_backfill_runs").insert({ ticker_id: ids.staleChain, status: "complete", steps: historyDone, progress_percent: 100, started_at: "2026-11-01T00:00:00Z", finished_at: "2026-11-01T00:01:00Z" });
  await testDb("ticker_data_retries").insert({ ticker_id: ids.fresh, data_kind: "daily_bars_history", trading_date: "2026-11-02", attempts: 1, succeeded_at: "2026-11-02T10:00:00Z" });
  for (const tickerId of [ids.staleChain, ids.fresh, ids.noHistory]) await testDb("daily_price_bars").insert({ ticker_id: tickerId, trading_date: "2026-06-12", close_price: 10 });
  // PREP is being set up: neither kind is retried while its setup runs.
  await testDb("ticker_backfill_runs").insert({ ticker_id: ids.preparing, status: "running", steps: JSON.stringify([]), progress_percent: 10 });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const tried: string[] = [];
const alerts: string[] = [];
let historyFails = true;
const dependencies: TickerDataRetryDependencies = {
  ...defaultTickerDataRetryDependencies,
  now: () => now,
  isMarketClosedToday: async () => false,
  loadSpotPrices: async () => new Map(),
  connect: async () => ({ ib: {} as never, disconnect: () => {} }),
  refreshOptionChain: async (_connection, need) => {
    tried.push(`${need.symbol} chain`);
    await testDb("option_chain_params").where({ ticker_id: need.tickerId }).update({ fetched_at: now });
  },
  fetchDailyBarsHistory: async (_connection, need) => {
    tried.push(`${need.symbol} history`);
    if (historyFails) throw new Error(`Historical data timeout for ${need.symbol}`);
  },
  alert: async (message) => {
    alerts.push(message);
  },
};

describe("runTickerDataRetryPass on the database", () => {
  it("finds the chain not fetched today and the history never completed, skipping a ticker being set up", async () => {
    const result = await runTickerDataRetryPass(dependencies);
    expect(tried).toEqual(["STALE chain", "NOHIST history"]);
    expect(result).toMatchObject({ ran: true, stoppedAfterTimeout: "NOHIST" });
    const rows = await loadTickerDataRetryRows(today);
    expect(rows.find((row) => row.tickerId === ids.staleChain)).toMatchObject({ kind: "option_chain", attempts: 1, lastError: null });
    expect(rows.find((row) => row.tickerId === ids.staleChain)!.succeededAt).not.toBeNull();
    expect(rows.find((row) => row.tickerId === ids.noHistory)).toMatchObject({ kind: "daily_bars_history", attempts: 1, lastError: "Historical data timeout for NOHIST", gaveUpAt: null });
    expect(rows.some((row) => row.tickerId === ids.preparing || row.tickerId === ids.fresh)).toBe(false);
  });

  it("gives up on the third failed try with one alert, then leaves the ticker alone for the day", async () => {
    tried.length = 0;
    await runTickerDataRetryPass(dependencies);
    expect(alerts).toEqual([]);
    await runTickerDataRetryPass(dependencies);
    expect(tried).toEqual(["NOHIST history", "NOHIST history"]);
    expect(alerts).toEqual(["⚠️ NOHIST: the 5-year daily history is still missing after 3 tries today (Historical data timeout for NOHIST). Shortlist → NOHIST → Actions → Populate Daily Bars."]);
    expect((await loadTickerDataRetryRows(today, [ids.noHistory]))[0]).toMatchObject({ attempts: 3 });
    expect((await loadTickerDataRetryRows(today, [ids.noHistory]))[0]!.gaveUpAt).not.toBeNull();
    expect(await runTickerDataRetryPass(dependencies)).toEqual({ ran: false, reason: "nothing_due" });
    expect(alerts).toHaveLength(1);
  });

  it("counts a history fetched by hand as complete, so it is no longer missing", async () => {
    expect((await loadDailyBarsStatus(ids.noHistory, now)).dailyBarsPlan).toBe("full");
    await recordTickerDataSuccess(ids.noHistory, "daily_bars_history", today, false);
    expect((await loadDailyBarsStatus(ids.noHistory, now)).dailyBarsPlan).not.toBe("full");
    expect((await loadTickerDataRetryRows(today, [ids.noHistory]))[0]).toMatchObject({ attempts: 3 });
  });
});
