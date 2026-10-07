import knexLibrary from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): the abandoned-pass sweep and finishPlutoPass together, against the real test database.
// closeAbandonedPlutoPasses updates every old unfinished pass in the test DB (acceptable there only); our rows are removed afterwards.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the ledger audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: vi.fn(async () => {}) }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(), notifyPlutoTelegram: vi.fn() }));

const { db } = await import("../db/connection.js");
const { abandonedPassAfterMs, closeAbandonedPlutoPasses, finishPlutoPass } = await import("./ledger.js");
const createdPassIds: string[] = [];

async function insertUnfinishedPass(startedAt: Date): Promise<string> {
  const [row] = await db("pluto_passes").insert({ trigger: "manual", trigger_detail: JSON.stringify({ audit: "a" }), started_at: startedAt }).returning("id");
  createdPassIds.push(row.id);
  return row.id as string;
}

async function readPass(id: string): Promise<{ finished_at: Date | null; skipped_reason: string | null; model_called: boolean }> {
  return db("pluto_passes").where({ id }).first("finished_at", "skipped_reason", "model_called");
}

afterAll(async () => {
  await db("pluto_passes").whereIn("id", createdPassIds).delete();
  await db.destroy();
});

describe("closeAbandonedPlutoPasses + finishPlutoPass (audit A)", () => {
  it("the 10-minute boundary is strict: exactly 10 minutes old is still running", async () => {
    const now = new Date();
    const exactlyAtLimit = await insertUnfinishedPass(new Date(now.getTime() - abandonedPassAfterMs));
    const justPast = await insertUnfinishedPass(new Date(now.getTime() - abandonedPassAfterMs - 1_000));
    await closeAbandonedPlutoPasses(now);
    expect((await readPass(exactlyAtLimit)).finished_at).toBeNull();
    expect((await readPass(justPast)).skipped_reason).toBe("abandoned (round never finished)");
  });

  it("a second sweep leaves an already-closed abandoned pass alone (its finished_at does not move)", async () => {
    const now = new Date();
    const id = await insertUnfinishedPass(new Date(now.getTime() - 30 * 60_000));
    await closeAbandonedPlutoPasses(now);
    const first = await readPass(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await closeAbandonedPlutoPasses(new Date());
    expect((await readPass(id)).finished_at?.getTime()).toBe(first.finished_at?.getTime());
  });

  it("a round that fails after being swept replaces 'abandoned' with its own failure", async () => {
    const id = await insertUnfinishedPass(new Date(Date.now() - 11 * 60_000));
    await closeAbandonedPlutoPasses();
    await finishPlutoPass(id, { skippedReason: "round failed: boom" });
    expect((await readPass(id)).skipped_reason).toBe("round failed: boom");
  });

  it("BUG(edge): a slow round (>10 min) swept by its own process's housekeeping, then finishing with a model call, keeps skipped_reason 'abandoned'", async () => {
    const id = await insertUnfinishedPass(new Date(Date.now() - 11 * 60_000));
    await closeAbandonedPlutoPasses();
    await finishPlutoPass(id, { modelCalled: true, candidateCount: 2, tokensIn: 10, tokensOut: 5, costUsd: 0.01, servedModelIds: ["m"] });
    const row = await readPass(id);
    expect(row.model_called).toBe(true);
    expect(row.skipped_reason).toBeNull();
  });
});
