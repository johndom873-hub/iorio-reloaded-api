import knexLibrary from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): the counters' Eastern trading date (easternIsoDate) agrees with Postgres' AT TIME ZONE across the
// DST change. Rows are dated in 2001 so no other row in the shared test database falls on these dates.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the counters audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(), notifyPlutoTelegram: vi.fn() }));

const { db } = await import("../db/connection.js");
const { loadPlutoOrdersTodayBreakdown, loadPlutoTodayCounters } = await import("./counters.js");
let passId = "";

async function insertAction(createdAtIso: string, outcome: string): Promise<void> {
  await db("pluto_actions").insert({ pass_id: passId, kind: "open_covered_call", symbol: "AUDITA", outcome, gate_results: "[]", created_at: new Date(createdAtIso) });
}

beforeAll(async () => {
  const [row] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ audit: "a-counters" }), started_at: new Date("2001-11-04T15:00:00Z"), finished_at: new Date("2001-11-04T15:00:00Z") }).returning("id");
  passId = row.id;
  await insertAction("2001-11-04T03:30:00Z", "filled"); // 23:30 EDT on 11-03
  await insertAction("2001-11-04T05:30:00Z", "filled"); // 00:30 EST on 11-04 (after the fall-back)
  await insertAction("2001-11-05T04:30:00Z", "confirmed"); // 23:30 EST on 11-04
  await insertAction("2001-11-05T05:30:00Z", "blocked"); // 00:30 EST on 11-05
});

afterAll(async () => {
  await db("pluto_passes").where({ id: passId }).delete(); // cascades to the actions
  await db.destroy();
});

describe("Pluto counters across the fall DST change (audit A)", () => {
  it("counts only actions on the instant's Eastern date", async () => {
    const breakdown = await loadPlutoOrdersTodayBreakdown(new Date("2001-11-04T20:00:00Z"));
    expect(breakdown).toEqual({ sent: 2, filled: 1, working: 1, blocked: 0 });
    expect((await loadPlutoTodayCounters(new Date("2001-11-05T04:59:00Z"))).actionsToday).toBe(2); // 23:59 EST on 11-04
    expect((await loadPlutoOrdersTodayBreakdown(new Date("2001-11-05T12:00:00Z"))).blocked).toBe(1);
  });
});
