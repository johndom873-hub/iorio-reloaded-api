import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Audit E (2026-10-07): the order-review macro warning query (fetchMacroEventWarningEvents) against the real test database,
// inside a transaction rolled back at the end. Rows are far in the future so the real clock (CURRENT_TIMESTAMP) is irrelevant.
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
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));

const { fetchMacroEventWarningEvents } = await import("./calendarConflict.js");
const { expirySpansMacroEvent } = await import("../lib/volatilityEdge.js");

const events = [
  { title: "audit-e CPI on expiry", at: "2034-11-03T13:30:00Z" }, // 08:30 EST
  { title: "audit-e election on expiry", at: "2034-11-08T00:00:00Z" }, // 19:00 EST on 11-07
  { title: "audit-e at the close", at: "2034-11-10T21:00:00Z" }, // 16:00 EST exactly
  { title: "audit-e fed in daylight time", at: "2034-10-25T18:00:00Z" }, // 14:00 EDT
];
let transaction: Knex.Transaction;

beforeAll(async () => {
  transaction = await holder.root.transaction();
  holder.current = transaction;
  await transaction("major_macro_events").insert(events.map((event, index) => ({ event_key: `audit_e_${index}`, title: event.title, event_at: new Date(event.at), source: "fred" })));
});
afterAll(async () => {
  await transaction.rollback();
  holder.current = holder.root;
  await holder.root.destroy();
});

const titlesBefore = async (expiryYyyymmdd: string): Promise<string[]> => (await fetchMacroEventWarningEvents(expiryYyyymmdd)).filter((event) => event.title.startsWith("audit-e")).map((event) => event.title);

describe("fetchMacroEventWarningEvents edges", () => {
  it("counts an 08:30 release on the expiry date and a 14:00 EDT one before it", async () => {
    expect(await titlesBefore("20341103")).toEqual(["audit-e fed in daylight time", "audit-e CPI on expiry"]);
  });

  it("does not count an election evening on the expiry date, counts it for the next day's expiry, and labels it with its Eastern date", async () => {
    expect(await titlesBefore("20341107")).not.toContain("audit-e election on expiry");
    const nextDay = (await fetchMacroEventWarningEvents("20341108")).find((event) => event.title === "audit-e election on expiry");
    expect(nextDay?.eventDate).toBe("2034-11-07");
  });

  it("does not count an event exactly at 16:00 ET on the expiry date (EST)", async () => {
    expect(await titlesBefore("20341110")).not.toContain("audit-e at the close");
    expect(await titlesBefore("20341113")).toContain("audit-e at the close");
  });

  it("agrees with the Signals flag rule (expirySpansMacroEvent) on every case", async () => {
    const nowMs = Date.now();
    for (const expiry of ["2034-10-25", "2034-11-03", "2034-11-07", "2034-11-08", "2034-11-10", "2034-11-13"]) {
      const fromQuery = await titlesBefore(expiry.replace(/-/g, ""));
      const fromRule = events.filter((event) => expirySpansMacroEvent(nowMs, expiry, [{ eventAtMs: Date.parse(event.at) }])).map((event) => event.title);
      expect([...fromQuery].sort()).toEqual([...fromRule].sort());
    }
  });
});
