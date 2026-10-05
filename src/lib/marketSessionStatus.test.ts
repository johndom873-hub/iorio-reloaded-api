import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary, { type Knex } from "knex";

// Dates are in 2099, past market_calendar's coverage, so the plain weekday fallback decides trading days
// and the test needs no calendar rows. 2099-01-05 is a Monday (EST, UTC-5): 09:30 ET = 14:30Z.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run these tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { computeMarketSessionStatus } = await import("./marketSessionStatus.js");
const testDb: Knex = db;

afterAll(async () => {
  await testDb.destroy();
});

describe("computeMarketSessionStatus", () => {
  it("pre-market counts down to the regular open", async () => {
    expect(await computeMarketSessionStatus(new Date("2099-01-05T12:00:00Z"))).toEqual({ state: "pre-market", label: "opens in 2h 30m", nextChangeAt: "2099-01-05T14:30:00.000Z" });
  });

  it("open counts down to the regular close", async () => {
    expect(await computeMarketSessionStatus(new Date("2099-01-05T15:00:00Z"))).toEqual({ state: "open", label: "closes in 6h 0m", nextChangeAt: "2099-01-05T21:00:00.000Z" });
  });

  it("after-hours counts down to the 20:00 ET end", async () => {
    expect(await computeMarketSessionStatus(new Date("2099-01-05T22:00:00Z"))).toEqual({ state: "after-hours", label: "closes in 3h 0m", nextChangeAt: "2099-01-06T01:00:00.000Z" });
  });

  it("closed before pre-market counts down to the same day's open", async () => {
    expect(await computeMarketSessionStatus(new Date("2099-01-05T08:00:00Z"))).toEqual({ state: "closed", label: "opens in 6h 30m", nextChangeAt: "2099-01-05T14:30:00.000Z" });
  });

  it("closed on a weekend counts down to Monday's open", async () => {
    const status = await computeMarketSessionStatus(new Date("2099-01-10T17:00:00Z"));
    expect(status.state).toBe("closed");
    expect(status.nextChangeAt).toBe("2099-01-12T14:30:00.000Z");
  });
});
