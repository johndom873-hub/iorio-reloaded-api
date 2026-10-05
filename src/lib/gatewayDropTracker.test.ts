import { describe, expect, it } from "vitest";
import { UnplannedDropTracker, isWithinPlannedGatewayRestartWindow, unplannedDropWindowMs } from "./gatewayDropTracker.js";

const utc = (time: string) => Date.parse(`2026-10-05T${time}Z`);

describe("isWithinPlannedGatewayRestartWindow", () => {
  it("covers 05:30:00 up to but not including 05:35:00 UTC", () => {
    expect(isWithinPlannedGatewayRestartWindow(utc("05:29:59.999"))).toBe(false);
    expect(isWithinPlannedGatewayRestartWindow(utc("05:30:00.000"))).toBe(true);
    expect(isWithinPlannedGatewayRestartWindow(utc("05:30:35"))).toBe(true);
    expect(isWithinPlannedGatewayRestartWindow(utc("05:34:59.999"))).toBe(true);
    expect(isWithinPlannedGatewayRestartWindow(utc("05:35:00.000"))).toBe(false);
  });

  it("applies on every date, not one day", () => {
    expect(isWithinPlannedGatewayRestartWindow(Date.parse("2026-12-25T05:31:00Z"))).toBe(true);
    expect(isWithinPlannedGatewayRestartWindow(Date.parse("2026-12-25T17:31:00Z"))).toBe(false);
  });
});

describe("UnplannedDropTracker", () => {
  it("counts nothing before any drop", () => {
    expect(new UnplannedDropTracker().countInLast24Hours(utc("12:00:00"))).toBe(0);
  });

  it("does not count the three drops of the daily restart but counts a drop right after the window", () => {
    const tracker = new UnplannedDropTracker();
    for (const time of ["05:30:00", "05:30:17", "05:30:35"]) tracker.recordDrop(utc(time));
    expect(tracker.countInLast24Hours(utc("06:00:00"))).toBe(0);
    tracker.recordDrop(utc("05:35:00"));
    expect(tracker.countInLast24Hours(utc("06:00:00"))).toBe(1);
  });

  it("counts every drop of one outage, failed retries included", () => {
    const tracker = new UnplannedDropTracker();
    for (let minute = 0; minute < 96; minute++) tracker.recordDrop(utc("06:00:00") + minute * 60_000);
    expect(tracker.countInLast24Hours(utc("08:00:00"))).toBe(96);
  });

  it("forgets a drop once it is 24 hours old", () => {
    const tracker = new UnplannedDropTracker();
    const dropTime = utc("12:00:00");
    tracker.recordDrop(dropTime);
    expect(tracker.countInLast24Hours(dropTime + unplannedDropWindowMs - 1)).toBe(1);
    expect(tracker.countInLast24Hours(dropTime + unplannedDropWindowMs)).toBe(0);
  });

  it("keeps counting drops from a different part of the window while old ones fall out", () => {
    const tracker = new UnplannedDropTracker();
    tracker.recordDrop(utc("10:00:00"));
    tracker.recordDrop(Date.parse("2026-10-06T09:00:00Z"));
    expect(tracker.countInLast24Hours(Date.parse("2026-10-06T10:30:00Z"))).toBe(1);
  });
});
