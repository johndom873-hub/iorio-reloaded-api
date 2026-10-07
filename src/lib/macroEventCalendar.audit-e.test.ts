import type { Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit E (2026-10-07): major macro event store edges against the real test database. Every write runs inside one
// transaction that is rolled back at the end, because replaceMajorMacroEvents deletes every row of an event key.
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
const sources = vi.hoisted(() => ({ fredDatesByReleaseId: new Map<number, string[]>(), fomcPage: "" }));
vi.mock("./majorMacroEventSources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./majorMacroEventSources.js")>();
  return {
    ...actual,
    fetchFredReleaseDates: async (releaseId: number, fromDateIso: string) => (sources.fredDatesByReleaseId.get(releaseId) ?? []).filter((date) => date >= fromDateIso),
    fetchFomcCalendarPage: async () => sources.fomcPage,
  };
});
vi.mock("./throttledAlert.js", () => ({ notifyDownThrottled: vi.fn(), clearDownState: vi.fn(async () => null) }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: vi.fn() }));

const store = await import("./macroEventCalendar.js");

const fomcPage = (year: number, meetings: [string, string][]): string =>
  `<h4><a id="1">${year} FOMC Meetings</a></h4>` +
  meetings.map(([month, days]) => `<div class="fomc-meeting__month col-md-2"><strong>${month}</strong></div><div class="fomc-meeting__date col-lg-1">${days}</div>`).join("");

async function rowsOf(eventKey: string): Promise<string[]> {
  const rows: { at: string }[] = await holder.current("major_macro_events").where({ event_key: eventKey }).orderBy("event_at").select(holder.current.raw(`to_char(event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"') AS at`));
  return rows.map((row) => row.at);
}

let transaction: Knex.Transaction;
beforeAll(async () => {
  transaction = await holder.root.transaction();
  holder.current = transaction;
});
beforeEach(async () => {
  await transaction.raw("SAVEPOINT audit_e_case");
  sources.fredDatesByReleaseId.clear();
  sources.fomcPage = fomcPage(2026, [["October", "27-28"], ["December", "8-9*"]]) + fomcPage(2027, [["January", "26-27"]]);
});
afterAll(async () => {
  await transaction.rollback();
  holder.current = holder.root;
  await holder.root.destroy();
});

async function restoreCase(): Promise<void> {
  await transaction.raw("ROLLBACK TO SAVEPOINT audit_e_case");
}

describe("captureMajorMacroEvents edges", () => {
  it("stores the 2026 election at 19:00 EST = 00:00Z on Nov 4, and the Fed decision at 14:00 EDT = 18:00Z", async () => {
    await store.captureMajorMacroEvents(new Date("2026-10-07T20:00:00Z"));
    expect(await rowsOf("us_federal_election")).toEqual(["2026-11-04T00:00Z"]);
    expect(await rowsOf("fed_rate_decision")).toEqual(["2026-10-28T18:00Z", "2026-12-09T19:00Z"]); // Dec 9 is EST
    await restoreCase();
  });

  it("keeps a release earlier today (the capture runs after it) and drops yesterday's", async () => {
    sources.fredDatesByReleaseId.set(10, ["2026-10-06", "2026-10-07", "2026-11-12"]);
    await store.captureMajorMacroEvents(new Date("2026-10-07T20:00:00Z"));
    expect(await rowsOf("cpi")).toEqual(["2026-10-07T12:30Z", "2026-11-12T13:30Z"]);
    await restoreCase();
  });

  it("drops a date more than 90 days ahead", async () => {
    sources.fredDatesByReleaseId.set(53, ["2026-10-29", "2027-01-05", "2027-01-06"]);
    await store.captureMajorMacroEvents(new Date("2026-10-07T20:00:00Z")); // + 90 days = 2027-01-05T20:00Z
    expect(await rowsOf("gdp")).toEqual(["2026-10-29T12:30Z", "2027-01-05T13:30Z"]);
    await restoreCase();
  });

  it("in late December of an election year the past election row is removed and none is stored", async () => {
    await store.captureMajorMacroEvents(new Date("2026-10-07T20:00:00Z"));
    await store.captureMajorMacroEvents(new Date("2026-12-20T20:00:00Z"));
    expect(await rowsOf("us_federal_election")).toEqual([]);
    await restoreCase();
  });
});

describe("loadUpcomingMajorMacroEvents edges", () => {
  it("dates an event by its Eastern date: the election at 00:00Z is Nov 3, a 23:30 ET event yesterday is not today", async () => {
    const now = new Date();
    const todayEastern = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
    const yesterdayEastern = new Date(Date.parse(`${todayEastern}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    // Inserted directly: replaceMajorMacroEvents would drop yesterday's row.
    const { easternInstant } = await import("./easternIsoDate.js");
    await transaction("major_macro_events").insert([
      { event_key: "audit_e_late", title: "audit-e late yesterday", event_at: easternInstant(yesterdayEastern, 23, 30), source: "fred" },
      { event_key: "audit_e_election", title: "audit-e election", event_at: new Date("2030-11-06T00:00:00Z"), source: "election_rule" },
    ]);
    const events = (await store.loadUpcomingMajorMacroEvents()).filter((event) => event.title.startsWith("audit-e"));
    expect(events).toEqual([{ dateIso: "2030-11-05", eventAtIso: "2030-11-06T00:00:00Z", title: "audit-e election" }]);
    await restoreCase();
  });
});
