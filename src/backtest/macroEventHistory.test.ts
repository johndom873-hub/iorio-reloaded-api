import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { easternInstant } from "../lib/easternIsoDate.js";
import { loadMacroEventHistory, macroEventHistoryCacheCovers, macroEventHistoryCachePath, MacroEventHistory, parseFomcHistoricalRateDecisionDates, type HistoricalMacroEvent, type MacroEventHistoryCache } from "./macroEventHistory.js";

const heading = (text: string) => `<div class="panel panel-default"><h5 class="panel-heading panel-heading--shaded">${text}</h5><div>Statement</div></div>`;

describe("the Fed's page of a past year", () => {
  it("gives the last day of each scheduled meeting, skipping the unscheduled, cancelled and notation-vote entries", () => {
    const page2020 = ["January 28-29 Meeting - 2020", "March 2 (unscheduled) Meeting - 2020", "March 15 (unscheduled) Meeting - 2020", "March 17-18 (cancelled) Meeting - 2020", "March 19 (notation vote) - 2020", "April 28-29 Meeting - 2020", "June 9-10 Meeting - 2020", "July 28-29 Meeting - 2020", "August 27 (notation vote) - 2020", "September 15-16 Meeting - 2020", "November 4-5 Meeting - 2020", "December 15-16 Meeting - 2020"].map(heading).join("\n");
    expect(parseFomcHistoricalRateDecisionDates(page2020, 2020)).toEqual(["2020-01-29", "2020-04-29", "2020-06-10", "2020-07-29", "2020-09-16", "2020-11-05", "2020-12-16"]);
  });

  it("reads a meeting across two months and a one-day meeting", () => {
    const page = ["April/May 30-1 Meeting - 2019", "October 4 (unscheduled) - 2019", "June 19 Meeting - 2019", "December/January 31-1 Meeting - 2019"].map(heading).join("");
    expect(parseFomcHistoricalRateDecisionDates(page, 2019)).toEqual(["2019-05-01", "2019-06-19", "2020-01-01"]);
  });

  it("fails on a page without a scheduled meeting of the year, or with a month it cannot read", () => {
    expect(() => parseFomcHistoricalRateDecisionDates(heading("January 28-29 Meeting - 2020"), 2019)).toThrow("FOMC 2019 page: no scheduled meeting found");
    expect(() => parseFomcHistoricalRateDecisionDates("<html></html>", 2020)).toThrow("FOMC 2020 page: no scheduled meeting found");
    expect(() => parseFomcHistoricalRateDecisionDates(heading("Januar 28-29 Meeting - 2020"), 2020)).toThrow('FOMC 2020 page: unknown month in "Januar 28-29 Meeting - 2020"');
  });
});

const event = (eventKey: HistoricalMacroEvent["eventKey"], title: string, dateIso: string, hour: number, minute: number): HistoricalMacroEvent => ({ eventKey, title, dateIso, eventAtIso: easternInstant(dateIso, hour, minute).toISOString() });
const events = [event("cpi", "CPI", "2024-03-12", 8, 30), event("fed_rate_decision", "Fed rate decision", "2024-03-20", 14, 0), event("jobs_report", "Jobs report", "2024-04-05", 8, 30), event("cpi", "CPI", "2024-07-11", 8, 30)];

describe("the events still ahead on a day", () => {
  const history = new MacroEventHistory(events);

  it("are those dated from that day through the calendar's 90 days, in time order", () => {
    expect(history.upcomingOn("2024-03-12").map((entry) => entry.dateIso)).toEqual(["2024-03-12", "2024-03-20", "2024-04-05"]);
    expect(history.upcomingOn("2024-03-13").map((entry) => entry.title)).toEqual(["Fed rate decision", "Jobs report"]);
    // 11 July is 91 days after 11 April and 90 after 12 April.
    expect(history.upcomingOn("2024-04-11").map((entry) => entry.dateIso)).toEqual([]);
    expect(history.upcomingOn("2024-04-12").map((entry) => entry.dateIso)).toEqual(["2024-07-11"]);
    expect(history.upcomingOn("2024-03-20")[0]).toEqual({ dateIso: "2024-03-20", eventAtIso: "2024-03-20T18:00:00.000Z", title: "Fed rate decision" });
  });
});

describe("the history's cache in the data folder", () => {
  let dataDirectory: string;
  beforeEach(() => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), "backtest-macro-"));
  });
  afterEach(() => rmSync(dataDirectory, { recursive: true, force: true }));
  const now = new Date("2026-10-12T15:00:00Z");
  const cacheBuiltAt = (builtAtIso: string, firstDateIso = "2019-01-01"): MacroEventHistoryCache => ({ builtAtIso, firstDateIso, events });

  it("serves a session that ended on or before the day it was built, and today's session only when built today", () => {
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-09T20:00:00Z"), "2026-10-09", now)).toBe(true);
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-09T20:00:00Z"), "2024-06-28", now)).toBe(true);
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-08T20:00:00Z"), "2026-10-09", now)).toBe(false);
    // A session reaching past today needs today's build, not one from its last day.
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-12T14:00:00Z"), "2026-12-31", now)).toBe(true);
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-11T14:00:00Z"), "2026-12-31", now)).toBe(false);
    expect(macroEventHistoryCacheCovers(cacheBuiltAt("2026-10-12T14:00:00Z", "2021-01-01"), "2024-06-28", now)).toBe(false);
  });

  it("is read without asking the sources when it covers the session, and rebuilt and rewritten when it does not", async () => {
    let fetches = 0;
    const fetchHistory = async () => {
      fetches += 1;
      return events;
    };
    const built = await loadMacroEventHistory(dataDirectory, "2026-10-09", fetchHistory, now);
    expect(built.count).toBe(4);
    expect(fetches).toBe(1);
    expect(JSON.parse(readFileSync(macroEventHistoryCachePath(dataDirectory), "utf8"))).toEqual({ builtAtIso: now.toISOString(), firstDateIso: "2019-01-01", events });
    await loadMacroEventHistory(dataDirectory, "2025-01-31", fetchHistory, now);
    expect(fetches).toBe(1);
    await loadMacroEventHistory(dataDirectory, "2026-10-13", fetchHistory, new Date("2026-10-14T15:00:00Z"));
    expect(fetches).toBe(2);
  });

  it("fails with what to check when the sources cannot be read and no cache covers the session", async () => {
    const failing = async () => {
      throw new Error("FRED release 10 responded 503");
    };
    await expect(loadMacroEventHistory(dataDirectory, "2026-10-09", failing, now)).rejects.toThrow("The macro-event history could not be built (FRED release 10 responded 503): the macro flag and the closes before a macro event need it. Check FRED_API_KEY and the connection, then run the session again.");
    writeFileSync(macroEventHistoryCachePath(dataDirectory), JSON.stringify(cacheBuiltAt("2026-10-09T20:00:00Z")));
    expect((await loadMacroEventHistory(dataDirectory, "2026-10-09", failing, now)).count).toBe(4);
  });
});
