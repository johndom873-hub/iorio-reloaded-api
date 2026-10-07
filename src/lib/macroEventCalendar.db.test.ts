import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The major macro event store against the real test database. The network sources and every Telegram send are mocked.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the macro event store tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const sources = vi.hoisted(() => ({ fredDatesByReleaseId: new Map<number, string[] | Error>(), fomcPage: "" as string | Error }));
vi.mock("./majorMacroEventSources.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./majorMacroEventSources.js")>();
  return {
    ...actual,
    fetchFredReleaseDates: async (releaseId: number, fromDateIso: string) => {
      const dates = sources.fredDatesByReleaseId.get(releaseId);
      if (dates instanceof Error) throw dates;
      return (dates ?? []).filter((date) => date >= fromDateIso);
    },
    fetchFomcCalendarPage: async () => {
      if (sources.fomcPage instanceof Error) throw sources.fomcPage;
      return sources.fomcPage;
    },
  };
});
const alerts = vi.hoisted(() => ({ notifyDownThrottled: vi.fn(), clearDownState: vi.fn(), notifyTelegramTracked: vi.fn() }));
vi.mock("./throttledAlert.js", () => ({ notifyDownThrottled: alerts.notifyDownThrottled, clearDownState: alerts.clearDownState }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: alerts.notifyTelegramTracked }));

const { db } = await import("../db/connection.js");
const store = await import("./macroEventCalendar.js");
const testDb: Knex = db;

const realEventKeys = ["cpi", "gdp", "fed_rate_decision", "us_federal_election"];
const loaderKeyPrefix = `loader-test-${Date.now() % 100_000_000}`;

function fomcPage(meetingsByYear: Record<number, [string, string][]>): string {
  return Object.entries(meetingsByYear)
    .map(
      ([year, meetings]) =>
        `<h4><a id="1">${year} FOMC Meetings</a></h4>` +
        meetings.map(([month, days]) => `<div class="fomc-meeting__month col-md-2"><strong>${month}</strong></div><div class="fomc-meeting__date col-lg-1">${days}</div>`).join(""),
    )
    .join("");
}

async function storedRows(): Promise<{ event_key: string; title: string; event_at: string; source: string }[]> {
  return testDb("major_macro_events")
    .whereIn("event_key", realEventKeys)
    .orderBy("event_at")
    .select("event_key", "title", db.raw(`to_char(event_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS event_at`), "source");
}

beforeEach(async () => {
  await testDb("major_macro_events").whereIn("event_key", realEventKeys).del();
  sources.fredDatesByReleaseId.clear();
  sources.fomcPage = "";
  for (const mock of Object.values(alerts)) mock.mockReset();
});

afterAll(async () => {
  await testDb("major_macro_events").whereIn("event_key", realEventKeys).del();
  await testDb("major_macro_events").where("event_key", "like", `${loaderKeyPrefix}%`).del();
  await testDb.destroy();
});

describe("captureMajorMacroEvents", () => {
  const now = new Date("2026-10-07T20:00:00Z"); // 16:00 ET, the job's slot

  beforeEach(() => {
    sources.fredDatesByReleaseId.set(10, ["2026-09-11", "2026-10-14", "2026-11-10", "2026-12-10"]);
    sources.fredDatesByReleaseId.set(53, ["2026-10-29", "2026-11-25", "2026-12-23"]);
    sources.fomcPage = fomcPage({ 2026: [["September", "15-16*"], ["October", "27-28"], ["December", "8-9*"]], 2027: [["January", "26-27"], ["March", "16-17*"]] });
  });

  it("stores each event at its release instant in ET, from today to 90 days ahead", async () => {
    const result = await store.captureMajorMacroEvents(now);
    expect(result.failures).toEqual([]);
    expect(result.horizonShortfalls).toEqual([]);
    expect(await storedRows()).toEqual([
      { event_key: "cpi", title: "CPI", event_at: "2026-10-14T12:30:00Z", source: "fred" }, // 08:30 EDT
      { event_key: "fed_rate_decision", title: "Fed rate decision", event_at: "2026-10-28T18:00:00Z", source: "federal_reserve" }, // 14:00 EDT
      { event_key: "gdp", title: "GDP", event_at: "2026-10-29T12:30:00Z", source: "fred" },
      { event_key: "us_federal_election", title: "US midterm elections", event_at: "2026-11-04T00:00:00Z", source: "election_rule" }, // 19:00 EST on 11-03
      { event_key: "cpi", title: "CPI", event_at: "2026-11-10T13:30:00Z", source: "fred" }, // 08:30 EST
      { event_key: "gdp", title: "GDP", event_at: "2026-11-25T13:30:00Z", source: "fred" },
      { event_key: "fed_rate_decision", title: "Fed rate decision", event_at: "2026-12-09T19:00:00Z", source: "federal_reserve" }, // 14:00 EST
      { event_key: "cpi", title: "CPI", event_at: "2026-12-10T13:30:00Z", source: "fred" },
      { event_key: "gdp", title: "GDP", event_at: "2026-12-23T13:30:00Z", source: "fred" },
    ]); // 2027-01-27 is past now + 90 days
    expect(result.writtenBySource).toEqual({ "CPI (FRED)": 3, "GDP (FRED)": 3, "Fed rate decision (Federal Reserve)": 2, "US federal elections (rule)": 1 });
  });

  it("drops a date the source moved on the next run", async () => {
    await store.captureMajorMacroEvents(now);
    sources.fredDatesByReleaseId.set(10, ["2026-10-15", "2026-11-10", "2026-12-10"]);
    await store.captureMajorMacroEvents(now);
    expect((await storedRows()).filter((row) => row.event_key === "cpi").map((row) => row.event_at)).toEqual(["2026-10-15T12:30:00Z", "2026-11-10T13:30:00Z", "2026-12-10T13:30:00Z"]);
  });

  it("keeps a failing source's rows and reports it, while the others refresh", async () => {
    await store.captureMajorMacroEvents(now);
    sources.fomcPage = new Error("federalreserve.gov FOMC calendar responded 503");
    sources.fredDatesByReleaseId.set(53, ["2026-10-30"]);
    const result = await store.captureMajorMacroEvents(now);
    expect(result.failures).toEqual([{ source: "Fed rate decision (Federal Reserve)", message: "federalreserve.gov FOMC calendar responded 503" }]);
    const rows = await storedRows();
    expect(rows.filter((row) => row.event_key === "fed_rate_decision")).toHaveLength(2);
    expect(rows.filter((row) => row.event_key === "gdp").map((row) => row.event_at)).toEqual(["2026-10-30T12:30:00Z"]);
  });

  it("fails a FOMC page it cannot read instead of storing nothing", async () => {
    sources.fomcPage = "<html>redesigned</html>";
    const result = await store.captureMajorMacroEvents(now);
    expect(result.failures.map((failure) => failure.source)).toEqual(["Fed rate decision (Federal Reserve)"]);
  });

  it("reports a source whose schedule ends less than 45 days ahead, including one with no future dates", async () => {
    const lateNovember = new Date("2026-11-20T21:00:00Z"); // + 45 days = 2027-01-04
    sources.fredDatesByReleaseId.set(53, ["2026-10-29", "2026-11-25", "2026-12-23"]);
    sources.fredDatesByReleaseId.set(10, ["2026-11-10"]); // nothing left after 11-20
    const result = await store.captureMajorMacroEvents(lateNovember);
    expect(result.failures).toEqual([]);
    expect(result.horizonShortfalls).toEqual(["CPI (FRED)", "GDP (FRED)"]); // the Fed page already lists 2027
    expect((await storedRows()).filter((row) => row.event_key === "cpi")).toEqual([]);
  });
});

describe("loadUpcomingMajorMacroEvents", () => {
  it("returns events from the start of today (Eastern) on, with the Eastern date and the UTC instant", async () => {
    const easternMidnight = "((CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date::timestamp AT TIME ZONE 'America/New_York')";
    const insert = (slug: string, minutesFromEasternMidnight: number) =>
      testDb("major_macro_events").insert({
        event_key: `${loaderKeyPrefix}-${slug}`,
        title: `${loaderKeyPrefix}-${slug}`,
        source: "fred",
        event_at: testDb.raw(`${easternMidnight} + (?::int * interval '1 minute')`, [minutesFromEasternMidnight]),
      });
    await insert("yesterday-evening", -5 * 60);
    await insert("today-0830", 8 * 60 + 30);
    await insert("tomorrow-2330", 24 * 60 + 23 * 60 + 30); // the next UTC day, still tomorrow in ET

    const today = (await testDb.raw("SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date, 'YYYY-MM-DD') AS iso")).rows[0].iso as string;
    const tomorrow = (await testDb.raw("SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date + 1, 'YYYY-MM-DD') AS iso")).rows[0].iso as string;
    const mine = (await store.loadUpcomingMajorMacroEvents()).filter((event) => event.title.startsWith(loaderKeyPrefix));
    expect(mine.map((event) => [event.title.slice(loaderKeyPrefix.length + 1), event.dateIso])).toEqual([
      ["today-0830", today],
      ["tomorrow-2330", tomorrow],
    ]);
    const tomorrowLate = mine[1]!;
    expect(new Date(tomorrowLate.eventAtIso).toISOString().slice(0, 10)).not.toBe(tomorrowLate.dateIso);
    expect(tomorrowLate.eventAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  });
});

describe("reportMajorMacroEventHorizon", () => {
  it("alerts with a daily reminder while a schedule is short", async () => {
    await store.reportMajorMacroEventHorizon({ horizonShortfalls: ["CPI (FRED)"], failures: [] });
    expect(alerts.notifyDownThrottled).toHaveBeenCalledWith("major_macro_events_horizon", store.buildMajorMacroEventHorizonMessage(["CPI (FRED)"]), 24 * 60 * 60 * 1000);
    expect(alerts.clearDownState).not.toHaveBeenCalled();
  });

  it("announces once when every schedule is long enough again", async () => {
    alerts.clearDownState.mockResolvedValueOnce(3 * 24 * 60 * 60 * 1000);
    await store.reportMajorMacroEventHorizon({ horizonShortfalls: [], failures: [] });
    expect(alerts.notifyTelegramTracked).toHaveBeenCalledWith(expect.stringContaining("every schedule reaches 45 days ahead again"));
  });

  it("stays quiet when nothing was short", async () => {
    alerts.clearDownState.mockResolvedValueOnce(null);
    await store.reportMajorMacroEventHorizon({ horizonShortfalls: [], failures: [] });
    expect(alerts.notifyTelegramTracked).not.toHaveBeenCalled();
  });

  it("does not clear the alert on a run where a source failed (its schedule was not checked)", async () => {
    await store.reportMajorMacroEventHorizon({ horizonShortfalls: [], failures: [{ source: "CPI (FRED)", message: "FRED release 10 responded 500" }] });
    expect(alerts.clearDownState).not.toHaveBeenCalled();
    expect(alerts.notifyDownThrottled).not.toHaveBeenCalled();
  });
});

describe("buildMajorMacroEventHorizonMessage", () => {
  it("names the short sources and has no '): ' (Telegram truncation)", () => {
    const message = store.buildMajorMacroEventHorizonMessage(["CPI (FRED)", "GDP (FRED)"]);
    expect(message).toContain("CPI (FRED), GDP (FRED)");
    expect(message).not.toContain("): ");
  });
});
