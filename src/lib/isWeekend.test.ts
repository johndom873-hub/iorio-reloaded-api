import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// 2099 is past market_calendar's coverage, so the weekday fallback decides and no calendar rows are needed.
// 2099-01-09 is a Friday and 2099-01-10 a Saturday (EST, UTC-5).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { isMarketClosedToday } = await import("./isWeekend.js");
const testDb: Knex = db;

afterAll(async () => {
  await testDb.destroy();
});

describe("isMarketClosedToday", () => {
  it("is open at the P&L slot on a weekday (22:30 UTC)", async () => {
    expect(await isMarketClosedToday(new Date("2099-01-08T22:30:00Z"))).toBe(false);
  });

  it("is closed at a weekend slot", async () => {
    expect(await isMarketClosedToday(new Date("2099-01-10T22:30:00Z"))).toBe(true);
  });

  it("stays open for a Friday-evening run that is already Saturday in UTC (Friday 23:00 ET = Saturday 04:00 UTC)", async () => {
    expect(await isMarketClosedToday(new Date("2099-01-10T04:00:00Z"))).toBe(false);
  });

  it("is closed from Saturday ET midnight on (Saturday 00:30 ET = 05:30 UTC)", async () => {
    expect(await isMarketClosedToday(new Date("2099-01-10T05:30:00Z"))).toBe(true);
  });

  it("is still closed on Sunday evening ET even though UTC is already Monday (Sunday 20:00 ET = Monday 01:00 UTC)", async () => {
    expect(await isMarketClosedToday(new Date("2099-01-12T01:00:00Z"))).toBe(true);
  });
});
