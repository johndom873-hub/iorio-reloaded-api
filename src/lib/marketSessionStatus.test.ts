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
const { computeMarketSessionStatus, easternDayStart, lastCompletedSessionDate } = await import("./marketSessionStatus.js");
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

// Weekday-only calendar, plus 2026-09-07 (Labor Day) closed: the injected stand-in for market_calendar.
const openDayStub = async (dateIso: string) => {
  const day = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
  return day >= 1 && day <= 5 && dateIso !== "2026-09-07";
};

describe("lastCompletedSessionDate (the date end-of-day jobs file their rows under)", () => {
  it("is the same day at the scheduled P&L and market-data slots, in summer and winter time", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-10-01T22:30:00Z"), openDayStub)).toBe("2026-10-01"); // 18:30 EDT
    expect(await lastCompletedSessionDate(new Date("2026-10-01T22:00:00Z"), openDayStub)).toBe("2026-10-01"); // 18:00 EDT
    expect(await lastCompletedSessionDate(new Date("2026-12-01T22:30:00Z"), openDayStub)).toBe("2026-12-01"); // 17:30 EST
    expect(await lastCompletedSessionDate(new Date("2026-12-01T22:00:00Z"), openDayStub)).toBe("2026-12-01"); // 17:00 EST
  });

  it("files the 2026-08-25 02:11 UTC rerun under Monday 08-24, not Tuesday 08-25", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-08-25T02:11:00Z"), openDayStub)).toBe("2026-08-24");
  });

  it("files the 2026-08-31 04:37 UTC rerun (Monday 00:37 ET) under the previous Friday 08-28", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-08-31T04:37:00Z"), openDayStub)).toBe("2026-08-28");
  });

  it("files the 2026-09-30 05:04 UTC rerun (Wednesday 01:04 ET) under Tuesday 09-29", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-09-30T05:04:00Z"), openDayStub)).toBe("2026-09-29");
  });

  it("files a Friday 23:00 ET rerun (Saturday 03:00 UTC) under that Friday", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-10-03T03:00:00Z"), openDayStub)).toBe("2026-10-02");
  });

  it("walks back over a holiday", async () => {
    expect(await lastCompletedSessionDate(new Date("2026-09-08T02:00:00Z"), openDayStub)).toBe("2026-09-04"); // Mon 09-07 closed
  });
});

describe("easternDayStart", () => {
  it("is 00:00 ET of the Eastern day, so a 02:00 UTC rerun still belongs to the previous day", () => {
    expect(easternDayStart(new Date("2026-10-05T14:00:00Z")).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(easternDayStart(new Date("2026-10-05T02:00:00Z")).toISOString()).toBe("2026-10-04T04:00:00.000Z");
    expect(easternDayStart(new Date("2026-12-01T14:00:00Z")).toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
});
