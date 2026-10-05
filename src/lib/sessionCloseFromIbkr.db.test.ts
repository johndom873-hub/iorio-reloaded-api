import { afterAll, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";

// The stored close every screen, order label and Pluto reads: written from IBKR's liquid hours, against the test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run this test.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { recordSessionCloseFromIbkr } = await import("./sessionCloseFromIbkr.js");
const { resolveSessionSchedule } = await import("./marketSessionStatus.js");

const dates = ["2099-11-26", "2099-11-27", "2099-11-28"];

afterAll(async () => {
  await db("market_calendar").whereIn("calendar_date", dates).del();
  await db.destroy();
});

describe("recordSessionCloseFromIbkr", () => {
  it("stores each listed day's close, leaves closed days alone, and the stored early close is what the session schedule reads", async () => {
    const now = new Date("2099-11-27T13:00:00Z"); // 08:00 ET on the half day
    const result = await recordSessionCloseFromIbkr(
      async () => [
        { dateIso: "2099-11-26", openHhmm: null, closeHhmm: null, closed: true },
        { dateIso: "2099-11-27", openHhmm: "09:30", closeHhmm: "13:00", closed: false },
        { dateIso: "2099-11-28", openHhmm: "09:30", closeHhmm: "16:00", closed: false },
      ],
      now,
    );
    expect(result).toEqual({ todayCloseTimeEt: "13:00", datesWritten: ["2099-11-27", "2099-11-28"] });
    expect((await resolveSessionSchedule("2099-11-27")).closeTimeEt).toBe("13:00");
    expect((await resolveSessionSchedule("2099-11-28")).closeTimeEt).toBe("16:00");
    expect(await db("market_calendar").where({ calendar_date: "2099-11-26" }).first()).toBeUndefined();
  });
});
