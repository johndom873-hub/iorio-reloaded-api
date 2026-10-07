import knexLibrary from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// The abandoned-pass sweep against the real test database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the abandoned-pass sweep tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { closeAbandonedPlutoPasses } = await import("./ledger.js");
const createdPassIds: string[] = [];

async function insertPass(startedMinutesAgo: number, finished: boolean, now: Date): Promise<string> {
  const startedAt = new Date(now.getTime() - startedMinutesAgo * 60_000);
  const [row] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}", started_at: startedAt, finished_at: finished ? startedAt : null }).returning("id");
  createdPassIds.push(row.id);
  return row.id as string;
}

afterAll(async () => {
  await db("pluto_passes").whereIn("id", createdPassIds).delete();
  await db.destroy();
});

describe("closeAbandonedPlutoPasses", () => {
  it("closes unfinished passes older than 10 minutes and leaves younger and finished ones alone", async () => {
    const now = new Date();
    const abandoned = await insertPass(11, false, now);
    const stillRunning = await insertPass(5, false, now);
    const finished = await insertPass(30, true, now);
    await closeAbandonedPlutoPasses(now);
    const rows: { id: string; finished_at: Date | null; skipped_reason: string | null }[] = await db("pluto_passes").whereIn("id", [abandoned, stillRunning, finished]).select("id", "finished_at", "skipped_reason");
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(abandoned)?.skipped_reason).toBe("abandoned (round never finished)");
    expect(byId.get(abandoned)?.finished_at).not.toBeNull();
    expect(byId.get(stillRunning)?.finished_at).toBeNull();
    expect(byId.get(finished)?.skipped_reason).toBeNull();
  });
});
