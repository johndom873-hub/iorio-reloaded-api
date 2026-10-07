import type { Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit E (2026-10-07): which trading date the readiness data checks describe (dataSessionIso), against the real test
// database inside one transaction rolled back at the end (job_runs is shared).
const holder = vi.hoisted(() => ({ root: null as unknown as Knex, current: null as unknown as Knex }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the audit tests.");
  const knexLibrary = (await import("knex")).default;
  holder.root = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } });
  holder.current = holder.root;
  return {
    get db() {
      return holder.current;
    },
  };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));
vi.mock("./marketSessionStatus.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./marketSessionStatus.js")>()),
  lastCompletedSessionDate: async () => "previous-session",
}));

const { createDefaultReadinessDependencies } = await import("./preOpenReadinessCollectors.js");
const { evaluateDataChecks } = await import("./preOpenReadiness.js");

let transaction: Knex.Transaction;
beforeAll(async () => {
  transaction = await holder.root.transaction();
  holder.current = transaction;
});
beforeEach(async () => {
  await transaction("job_runs").where({ job_name: "day_signals_seed" }).del();
});
afterAll(async () => {
  await transaction.rollback();
  holder.current = holder.root;
  await holder.root.destroy();
});

const run = (startedAt: string, finishedAt: string | null, status: "running" | "success" | "failure") => ({ job_name: "day_signals_seed", started_at: new Date(startedAt), finished_at: finishedAt ? new Date(finishedAt) : null, status });
const at1020Et = new Date("2026-10-07T14:20:00Z");

describe("dataSessionIso", () => {
  it("is today once today's capture has finished", async () => {
    await transaction("job_runs").insert(run("2026-10-07T14:00:00Z", "2026-10-07T14:06:00Z", "success"));
    expect(await createDefaultReadinessDependencies().dataSessionIso(at1020Et)).toBe("2026-10-07");
  });

  it("is the previous session while today's capture is still running", async () => {
    await transaction("job_runs").insert(run("2026-10-07T14:00:00Z", null, "running"));
    expect(await createDefaultReadinessDependencies().dataSessionIso(at1020Et)).toBe("previous-session");
  });

  it("does not take a run that started at 23:00 ET yesterday (03:00Z today) as today's", async () => {
    await transaction("job_runs").insert(run("2026-10-07T03:00:00Z", "2026-10-07T03:10:00Z", "success"));
    expect(await createDefaultReadinessDependencies().dataSessionIso(at1020Et)).toBe("previous-session");
  });

  it("takes a run that started at 20:30 ET today (00:30Z tomorrow) as today's, evaluated at 21:00 ET", async () => {
    await transaction("job_runs").insert(run("2026-10-08T00:30:00Z", "2026-10-08T00:40:00Z", "failure"));
    expect(await createDefaultReadinessDependencies().dataSessionIso(new Date("2026-10-08T01:00:00Z"))).toBe("2026-10-07");
  });
});

describe("evaluateDataChecks", () => {
  it("makes the new Earnings dates check a fail (not warn-only), and the macro freshness a warn", () => {
    const checks = evaluateDataChecks(
      [
        { name: "Earnings dates", ok: false, detail: "two earnings dates within 45 days: WDC (2026-08-04 and 2026-08-05)" },
        { name: "Major macro events", ok: false, detail: "never captured" },
      ],
      "2026-10-06",
    );
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["Data: Earnings dates (2026-10-06)", "fail"],
      ["Data: Major macro events (2026-10-06)", "warn"],
    ]);
  });
});
