import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchFomcCalendarPage, fetchFredReleaseDates, generateUsFederalElectionDays, parseFomcRateDecisionDates } from "./majorMacroEventSources.js";

// Audit E (2026-10-07): source edges not covered by majorMacroEventSources.test.ts. fetch is mocked: no network.

const meeting = (month: string, days: string) =>
  `<div class="row fomc-meeting"><div class="fomc-meeting__month col-xs-5"><strong> ${month} </strong></div>\n  <div class="fomc-meeting__date col-lg-1"> ${days} </div></div>`;
const section = (year: number, meetings: string[]) => `<div class="panel"><h4><a id="x">${year} FOMC Meetings</a></h4>${meetings.join("\n")}</div>`;

describe("parseFomcRateDecisionDates edges", () => {
  it("reads a meeting across two months inside one year (Jan/Feb 31-1) as Feb 1 of that year", () => {
    expect(parseFomcRateDecisionDates(section(2028, [meeting("Jan/Feb", "31-1")]))).toEqual(["2028-02-01"]);
  });

  it("tolerates whitespace around the month and days and a projection asterisk with spaces", () => {
    expect(parseFomcRateDecisionDates(section(2027, [meeting("September", "21-22 *")]))).toEqual(["2027-09-22"]);
  });

  it("de-duplicates a year whose section appears twice", () => {
    const html = section(2027, [meeting("January", "26-27")]) + section(2027, [meeting("January", "26-27")]);
    expect(parseFomcRateDecisionDates(html)).toEqual(["2027-01-27"]);
  });

  it("reads a leap day", () => {
    expect(parseFomcRateDecisionDates(section(2028, [meeting("February", "28-29")]))).toEqual(["2028-02-29"]);
  });
});

describe("generateUsFederalElectionDays edges", () => {
  it("2024 was a presidential election on Nov 5", () => {
    expect(generateUsFederalElectionDays(2024, 2024)).toEqual([{ dateIso: "2024-11-05", title: "US presidential election" }]);
  });

  it("is empty for a reversed range", () => {
    expect(generateUsFederalElectionDays(2027, 2026)).toEqual([]);
  });

  it("covers the capture's year and the next (2026 midterms seen from 2026, 2028 from 2027)", () => {
    expect(generateUsFederalElectionDays(2026, 2027).map((election) => election.dateIso)).toEqual(["2026-11-03"]);
    expect(generateUsFederalElectionDays(2027, 2028).map((election) => election.dateIso)).toEqual(["2028-11-07"]);
  });
});

describe("fetches (mocked fetch)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv("FRED_API_KEY", "test-key");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("FRED: retries an HTTP error three times, then throws with the status", async () => {
    fetchMock.mockImplementation(async () => new Response("{}", { status: 503 }));
    const outcome = fetchFredReleaseDates(10, "2026-10-07").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await outcome) as Error).message).toBe("FRED release 10 responded 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("FRED: a second attempt that succeeds returns its dates", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ release_dates: [{ date: "2026-10-14" }] })));
    const outcome = fetchFredReleaseDates(10, "2026-10-07");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await outcome).toEqual(["2026-10-14"]);
  });

  it("FRED: an empty release_dates array is no dates, not an error", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ release_dates: [] })));
    expect(await fetchFredReleaseDates(53, "2026-12-20")).toEqual([]);
  });

  it("FRED: throws (does not fetch) without FRED_API_KEY", async () => {
    vi.stubEnv("FRED_API_KEY", "");
    await expect(fetchFredReleaseDates(10, "2026-10-07")).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("FOMC page: returns the body, and throws with the status after three failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>ok</html>"));
    expect(await fetchFomcCalendarPage()).toBe("<html>ok</html>");
    fetchMock.mockImplementation(async () => new Response("", { status: 403 }));
    const outcome = fetchFomcCalendarPage().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(((await outcome) as Error).message).toBe("federalreserve.gov FOMC calendar responded 403");
  });
});
