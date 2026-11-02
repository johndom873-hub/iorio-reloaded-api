import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Against the test database: the P&L Over Time chart's daily series. The database is shared with other test files, so
// each test measures what its own positions add to the series, on days 20 and 19 back where nothing else writes.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { computeStrategyDailyPnlSeries } = await import("./strategyPeriodPnl.js");
const testDb: Knex = db;
const createdTickerIds: string[] = [];

const isoDateDaysAgo = async (days: number): Promise<string> => (await testDb.raw("SELECT (CURRENT_DATE - ?::int)::text AS d", [days])).rows[0].d;

async function createTicker(): Promise<string> {
  const [ticker] = await testDb("tickers").insert({ symbol: `SP${Date.now() % 100_000}${createdTickerIds.length}`, company_name: "Period P&L Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return ticker.id;
}

// pg reads a DATE as local midnight: its local calendar date is the stored one in any time zone.
const localIsoDate = (value: string | Date): string => {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

async function seriesFor(strategyKey: string, dates: string[]): Promise<number[]> {
  const series = await computeStrategyDailyPnlSeries(30);
  return dates.map((date) => series.find((row) => row.strategyKey === strategyKey && localIsoDate(row.snapshotDate) === date)?.dailyPnl ?? 0);
}

afterAll(async () => {
  const positionIds = (await testDb("positions").whereIn("ticker_id", createdTickerIds).select("id")).map((row) => row.id);
  await testDb("position_pnl_snapshots").whereIn("position_id", positionIds).del();
  await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", positionIds).select("id")).del();
  await testDb("position_legs").whereIn("position_id", positionIds).del();
  await testDb("positions").whereIn("id", positionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

describe("computeStrategyDailyPnlSeries", () => {
  it("INTC e8d3b29b: opened day 1 at -$1,248.10, closed day 2 with +$79.94 lifetime: day 1 -$1,248.10, day 2 +$1,328.04 (was $0 and +$1,328.04)", async () => {
    const [dayOne, dayTwo] = [await isoDateDaysAgo(20), await isoDateDaysAgo(19)];
    const before = await seriesFor("covered_call", [dayOne, dayTwo]);
    const tickerId = await createTicker();
    const [position] = await testDb("positions").insert({ strategy_key: "covered_call", ticker_id: tickerId, status: "closed" }).returning(["id"]);
    // Closed at 15:00 New York on day 2 (19:00 UTC in winter, 20:00 in summer: the same New York date either way).
    const closedAt = `${dayTwo}T19:30:00Z`;
    await testDb("position_legs").insert([
      { position_id: position.id, leg_type: "stock", side: "long", quantity: 200, multiplier: 1, entry_price: 93.380453, entry_at: `${dayOne}T14:00:00Z`, exit_price: 93.380453, exit_at: closedAt, ibkr_contract_id: "1" },
      { position_id: position.id, leg_type: "option", side: "short", option_type: "call", strike_price: 95, expiry_date: dayTwo, quantity: 2, multiplier: 100, entry_price: 1.2, entry_at: `${dayOne}T14:00:00Z`, exit_price: 0.8, exit_at: closedAt, ibkr_contract_id: "2" },
    ]);
    const [callLeg] = await testDb("position_legs").where({ position_id: position.id, leg_type: "option" }).select("id");
    await testDb("trades").insert({ position_leg_id: callLeg.id, ibkr_exec_id: `period-pnl-${position.id}`, side: "buy", quantity: 2, price: 0.8, commission: 0.06, executed_at: closedAt, is_closing_trade: true });
    await testDb("position_pnl_snapshots").insert({ position_id: position.id, snapshot_date: dayOne, unrealized_pnl: -1248.1 });

    const after = await seriesFor("covered_call", [dayOne, dayTwo]);
    expect(after[0]! - before[0]!).toBeCloseTo(-1248.1, 6);
    expect(after[1]! - before[1]!).toBeCloseTo(1328.04, 6);
  });

  it("a partial close on a still-open position: the sold slice's realized P&L counts that day without netting off the whole position's unrealized", async () => {
    const [dayOne, dayTwo] = [await isoDateDaysAgo(20), await isoDateDaysAgo(19)];
    const before = await seriesFor("unstructured", [dayOne, dayTwo]);
    const tickerId = await createTicker();
    const [position] = await testDb("positions").insert({ strategy_key: "unstructured", ticker_id: tickerId, status: "open" }).returning(["id"]);
    // 100 shares bought at $50; 40 sold at $55 on day 2 (+$200); the 60 left marked at $54 that evening (+$240).
    await testDb("position_legs").insert([
      { position_id: position.id, leg_type: "stock", side: "long", quantity: 40, multiplier: 1, entry_price: 50, entry_at: `${dayOne}T14:00:00Z`, exit_price: 55, exit_at: `${dayTwo}T18:00:00Z`, ibkr_contract_id: "1" },
      { position_id: position.id, leg_type: "stock", side: "long", quantity: 60, multiplier: 1, entry_price: 50, entry_at: `${dayOne}T14:00:00Z`, ibkr_contract_id: "1" },
    ]);
    await testDb("position_pnl_snapshots").insert([
      { position_id: position.id, snapshot_date: dayOne, unrealized_pnl: 300 },
      { position_id: position.id, snapshot_date: dayTwo, unrealized_pnl: 240 },
    ]);

    const after = await seriesFor("unstructured", [dayOne, dayTwo]);
    // Day 1: 100 shares from $50 to $53 = +$300. Day 2: total P&L $200 + $240 = $440, so +$140 on the day.
    expect(after[0]! - before[0]!).toBeCloseTo(300, 6);
    expect(after[1]! - before[1]!).toBeCloseTo(140, 6);
  });
});
