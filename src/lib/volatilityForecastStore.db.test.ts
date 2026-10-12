import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { computeYangZhangVolatility, type DailyOhlcvBar } from "./realizedVolatility.js";

// The forecast loader against the real test database: it must never read a bar dated today (a session still in
// progress) or after the snapshot date.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the forecast store tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { loadVolatilityForecasts } = await import("./volatilityForecastStore.js");
const testDb: Knex = db;
const symbol = `VFS${Date.now() % 100000}`;
let tickerId: string;

// 80 weekday bars ending Friday 2026-10-09, then a partial bar for Monday 2026-10-12 with a wild range. Prices are
// rounded to the column's 4 decimals so the stored bars are exactly these.
const toColumn = (price: number) => Math.round(price * 10_000) / 10_000;
const bars: DailyOhlcvBar[] = [];
for (let at = Date.parse("2026-10-09T12:00:00Z"), index = 0; bars.length < 80; at -= 86_400_000) {
  const day = new Date(at).getUTCDay();
  if (day === 0 || day === 6) continue;
  const close = 100 + 5 * Math.sin(index / 3) + index * 0.1;
  bars.unshift({ tradingDate: new Date(at).toISOString().slice(0, 10), open: toColumn(close * 0.995), high: toColumn(close * 1.02), low: toColumn(close * 0.98), close: toColumn(close), volume: 1_000_000 });
  index += 1;
}
const lastFullDate = bars.at(-1)!.tradingDate;
const partialBar: DailyOhlcvBar = { tradingDate: "2026-10-12", open: 100, high: 160, low: 60, close: 150, volume: 10 };

beforeAll(async () => {
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Forecast Store Co", sector: "Technology" }).returning("id");
  tickerId = ticker.id;
  await testDb("daily_price_bars").insert([...bars, partialBar].map((bar) => ({ ticker_id: tickerId, trading_date: bar.tradingDate, open_price: bar.open, high_price: bar.high, low_price: bar.low, close_price: bar.close, volume: bar.volume })));
});

afterAll(async () => {
  await testDb("daily_price_bars").where({ ticker_id: tickerId }).del();
  await testDb("tickers").where({ id: tickerId }).del();
  await testDb.destroy();
});

describe("loadVolatilityForecasts", () => {
  it("fixture: the last full bar is Friday 2026-10-09", () => {
    expect(lastFullDate).toBe("2026-10-09");
  });

  it("leaves out today's partial bar: Monday's forecasts are Friday's, YZ63 for the old Edge and YZ21 for the model", async () => {
    const forecasts = await loadVolatilityForecasts(tickerId, "2026-10-12", "2026-10-12");
    const yz63 = computeYangZhangVolatility(bars, 63);
    const yz21 = computeYangZhangVolatility(bars, 21);
    if (!yz63.available || !yz21.available) throw new Error("fixture must be fittable");
    expect(forecasts.edge).toEqual({ volatility: yz63.annualizedVolatility, windowDays: 63 });
    expect(forecasts.model!.annualizedVolatility).toBeCloseTo(yz21.annualizedVolatility, 12);
    expect(forecasts.model!.perSessionVariance).toBeCloseTo(yz21.annualizedVolatility ** 2 / 252, 15);
  });

  it("uses the bar once its day is over, and never one after the snapshot date", async () => {
    const tomorrow = await loadVolatilityForecasts(tickerId, "2026-10-12", "2026-10-13");
    const withMonday = computeYangZhangVolatility([...bars, partialBar], 21);
    if (!withMonday.available) throw new Error("fixture must be fittable");
    expect(tomorrow.model!.annualizedVolatility).toBeCloseTo(withMonday.annualizedVolatility, 12);
    const asOfFriday = await loadVolatilityForecasts(tickerId, "2026-10-09", "2026-10-13");
    expect(asOfFriday.model).toEqual((await loadVolatilityForecasts(tickerId, "2026-10-12", "2026-10-12")).model);
  });
});
