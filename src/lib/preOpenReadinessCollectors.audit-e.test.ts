import type { Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit E (2026-10-07): the readiness data checks, against the real test database inside one transaction rolled back at the end.
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
afterAll(async () => {
  await transaction.rollback();
  holder.current = holder.root;
  await holder.root.destroy();
});


describe("evaluateDataChecks", () => {
  it("warns for an Earnings dates conflict and for stale macro events: neither stops the open", () => {
    const checks = evaluateDataChecks(
      [
        { name: "Earnings dates", ok: false, detail: "two earnings dates within 45 days: WDC (2026-08-04 and 2026-08-05)" },
        { name: "Major macro events", ok: false, detail: "never captured" },
      ],
      "2026-10-06",
    );
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["Data: Earnings dates (2026-10-06)", "warn"],
      ["Data: Major macro events (2026-10-06)", "warn"],
    ]);
  });
});
