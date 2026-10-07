import knexLibrary, { type Knex } from "knex";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

// Audit (G3, 2026-10-07): which trading date the readiness data checks describe (dataSessionIso), against the real
// job_runs table of the test database. Fixtures sit in July 2097 only (no market_calendar rows, so weekdays are open).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the readiness collector audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
vi.mock("../config/env.js", async (importOriginal) => ({ ...(await importOriginal<typeof import("../config/env.js")>()), ibkrMarketDataLinesEnabled: () => false }));
vi.mock("./appEnvironment.js", () => ({ readAppEnvironment: () => "staging" }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const { createDefaultReadinessDependencies } = await import("./preOpenReadinessCollectors.js");
const testDb: Knex = db;

const rangeStart = "2097-07-01T00:00:00Z";
const rangeEnd = "2097-08-01T00:00:00Z";

async function clearFixtures(): Promise<void> {
  await testDb("job_runs").where({ job_name: "day_signals_seed" }).whereBetween("started_at", [rangeStart, rangeEnd]).del();
}

async function captureRun(startedAt: string, finishedAt: string | null, status: "running" | "success" | "failure"): Promise<void> {
  await testDb("job_runs").insert({ job_name: "day_signals_seed", started_at: startedAt, finished_at: finishedAt, status, triggered_by: "scheduler" });
}

afterEach(async () => {
  await clearFixtures();
});

afterAll(async () => {
  await clearFixtures();
  await testDb.destroy();
});

describe("dataSessionIso against job_runs (audit)", () => {
  // 2097-07-16 is a Tuesday (EDT): 11:00 ET = 15:00Z. The previous session is Monday 2097-07-15.
  const elevenAmTuesday = new Date("2097-07-16T15:00:00Z");

  it("is the previous session when no capture ran today", async () => {
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-15");
  });

  it("is today once today's capture finished, even as a failure", async () => {
    await captureRun("2097-07-16T14:00:00Z", "2097-07-16T14:20:00Z", "failure");
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-16");
  });

  it("stays on the previous session while today's capture is still running", async () => {
    await captureRun("2097-07-16T14:00:00Z", null, "running");
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-15");
  });

  it("does not count a capture that started late the previous Eastern evening (after midnight UTC)", async () => {
    // 03:30Z on 07-16 is 23:30 ET on 07-15.
    await captureRun("2097-07-16T03:30:00Z", "2097-07-16T03:50:00Z", "success");
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-15");
  });

  it("counts a capture that started just after Eastern midnight", async () => {
    // 04:30Z on 07-16 is 00:30 ET on 07-16 (a manual --force run).
    await captureRun("2097-07-16T04:30:00Z", "2097-07-16T04:50:00Z", "success");
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-16");
  });

  it("counts a run superseded as abandoned (finished_at set to its start) as finished", async () => {
    await captureRun("2097-07-16T14:00:00Z", "2097-07-16T14:00:00Z", "failure");
    expect(await createDefaultReadinessDependencies().dataSessionIso(elevenAmTuesday)).toBe("2097-07-16");
  });

  it("is today after the close even with no capture today (the last completed session is today)", async () => {
    // 16:30 ET on Tuesday: lastCompletedSessionDate is today.
    expect(await createDefaultReadinessDependencies().dataSessionIso(new Date("2097-07-16T20:30:00Z"))).toBe("2097-07-16");
  });

  it("before 16:00 ET on Monday skips the weekend back to Friday", async () => {
    // 2097-07-15 is a Monday; 9:00 ET = 13:00Z.
    expect(await createDefaultReadinessDependencies().dataSessionIso(new Date("2097-07-15T13:00:00Z"))).toBe("2097-07-12");
  });

  it("documents current behaviour: a forced capture on a Saturday makes the Saturday the data session", async () => {
    // 2097-07-20 is a Saturday; the scheduled capture skips closed days, only a --force run writes this row.
    await captureRun("2097-07-20T14:00:00Z", "2097-07-20T14:20:00Z", "success");
    expect(await createDefaultReadinessDependencies().dataSessionIso(new Date("2097-07-20T15:00:00Z"))).toBe("2097-07-20");
  });
});
