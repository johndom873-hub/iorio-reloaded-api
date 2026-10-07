import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFredReleaseDates, generateUsFederalElectionDays, parseFomcRateDecisionDates, scheduleKnownThroughIso } from "./majorMacroEventSources.js";

// Markup copied from federalreserve.gov/monetarypolicy/fomccalendars.htm (sections are not in year order on the page).
function meeting(month: string, days: string): string {
  return `
        <div class="row fomc-meeting" ">
            <div class="fomc-meeting__month col-xs-5 col-sm-3 col-md-2"><strong>${month}</strong></div>
            <div class="fomc-meeting__date col-xs-4 col-sm-9 col-md-10 col-lg-1">${days}</div>
            <div class="col-xs-12 col-md-4 col-lg-4 fomc-meeting__minutes"></div>
        </div>`;
}

function section(year: number, meetings: string[]): string {
  return `<div class="panel panel-default"><div class="panel-heading"><h4><a id="1">${year} FOMC Meetings</a></h4></div>${meetings.join("")}
<div class="panel-footer">* Meeting associated with a Summary of Economic Projections. </div></div>`;
}

describe("parseFomcRateDecisionDates", () => {
  it("returns the last day of each scheduled meeting across all sections, ascending", () => {
    const html = [
      section(2026, [meeting("October", "27-28"), meeting("December", "8-9*")]),
      section(2025, [meeting("July", "29-30"), meeting("August", "22 (notation vote)")]),
      section(2024, [meeting("Apr/May", "30-1")]),
      section(2027, [meeting("January", "26-27"), meeting("March", "16-17*")]),
    ].join("\n");
    expect(parseFomcRateDecisionDates(html)).toEqual(["2024-05-01", "2025-07-30", "2026-10-28", "2026-12-09", "2027-01-27", "2027-03-17"]);
  });

  it("skips unscheduled meetings and reads a single-day meeting", () => {
    expect(parseFomcRateDecisionDates(section(2020, [meeting("March", "15 (unscheduled)"), meeting("June", "10")]))).toEqual(["2020-06-10"]);
  });

  it("puts a meeting across the year end in the next year", () => {
    expect(parseFomcRateDecisionDates(section(2030, [meeting("Dec/Jan", "31-1")]))).toEqual(["2031-01-01"]);
  });

  it.each([
    ["no sections", "<html>nothing here</html>", 'no "YYYY FOMC Meetings" sections'],
    ["a section without meetings", section(2027, []), "no meetings found in the 2027 section"],
    ["an unknown month", section(2027, [meeting("Smarch", "1-2")]), 'unknown month "Smarch"'],
    ["unreadable days", section(2027, [meeting("March", "16 to 17")]), 'unreadable meeting days "16 to 17"'],
    ["an impossible date", section(2027, [meeting("February", "30-31")]), "invalid date 2027-2-31"],
  ])("throws on %s", (_label, html, message) => {
    expect(() => parseFomcRateDecisionDates(html)).toThrow(message);
  });
});

describe("generateUsFederalElectionDays", () => {
  it("returns the Tuesday after the first Monday in November of even years", () => {
    expect(generateUsFederalElectionDays(2025, 2032)).toEqual([
      { dateIso: "2026-11-03", title: "US midterm elections" },
      { dateIso: "2028-11-07", title: "US presidential election" },
      { dateIso: "2030-11-05", title: "US midterm elections" },
      { dateIso: "2032-11-02", title: "US presidential election" },
    ]);
  });

  it("never falls on November 1 (a Tuesday November 1 means the first Monday is the 7th)", () => {
    expect(generateUsFederalElectionDays(2022, 2022)).toEqual([{ dateIso: "2022-11-08", title: "US midterm elections" }]);
  });

  it("returns nothing for an odd-year-only range", () => {
    expect(generateUsFederalElectionDays(2027, 2027)).toEqual([]);
  });
});

describe("scheduleKnownThroughIso", () => {
  it("is Dec 31 of the latest year with a date", () => {
    expect(scheduleKnownThroughIso(["2026-10-14", "2026-12-10"])).toBe("2026-12-31");
    expect(scheduleKnownThroughIso(["2026-12-10", "2027-01-13"])).toBe("2027-12-31");
  });

  it("is null without dates", () => {
    expect(scheduleKnownThroughIso([])).toBeNull();
  });
});

describe("fetchFredReleaseDates", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv("FRED_API_KEY", "test-key");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks for future release dates including those with no data yet, and keeps dates from the given day on", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ release_dates: [{ date: "2026-10-06" }, { date: "2026-10-14" }, { date: "2026-11-10" }] })));
    expect(await fetchFredReleaseDates(10, "2026-10-07")).toEqual(["2026-10-14", "2026-11-10"]);
    const url = new URL(fetchMock.mock.calls[0]![0]);
    expect(url.origin + url.pathname).toBe("https://api.stlouisfed.org/fred/release/dates");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      release_id: "10",
      realtime_start: "2026-10-07",
      realtime_end: "9999-12-31",
      include_release_dates_with_no_data: "true",
      sort_order: "asc",
      file_type: "json",
      api_key: "test-key",
    });
  });

  it("throws when the body has no release_dates", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error_message: "Bad Request" })));
    await expect(fetchFredReleaseDates(10, "2026-10-07")).rejects.toThrow("FRED release 10 returned no release_dates");
  });

  it("throws on a malformed date", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ release_dates: [{ date: "10/14/2026" }] })));
    await expect(fetchFredReleaseDates(10, "2026-10-07")).rejects.toThrow("malformed date: 10/14/2026");
  });
});
