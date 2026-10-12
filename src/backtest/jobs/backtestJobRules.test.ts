import { describe, expect, it } from "vitest";
import {
  appendProgressSample,
  deriveJobDisplayStatus,
  estimateSecondsLeft,
  computeJobRunSeconds,
  formatDownloadProgressLabel,
  isIsoCalendarDate,
  lastFinishedBacktestSessionDate,
  recentPaceWindowMilliseconds,
  weekdaysBetweenInclusive,
} from "./backtestJobRules.js";

describe("deriveJobDisplayStatus", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  it("shows a running job with a heartbeat older than 60 s as stopped", () => {
    expect(deriveJobDisplayStatus("running", new Date("2026-10-12T09:58:59Z"), now)).toBe("stopped");
    expect(deriveJobDisplayStatus("running", null, now)).toBe("stopped");
  });
  it("keeps a running job with a fresh heartbeat running, and every other status as stored", () => {
    expect(deriveJobDisplayStatus("running", new Date("2026-10-12T09:59:30Z"), now)).toBe("running");
    expect(deriveJobDisplayStatus("queued", null, now)).toBe("queued");
    expect(deriveJobDisplayStatus("failed", new Date("2026-10-12T08:00:00Z"), now)).toBe("failed");
  });
});

describe("lastFinishedBacktestSessionDate", () => {
  it("counts today only from 18:00 ET on a weekday", () => {
    // Monday 2026-10-12: 17:59 EDT = 21:59 UTC, 18:00 EDT = 22:00 UTC.
    expect(lastFinishedBacktestSessionDate(new Date("2026-10-12T21:59:00Z"))).toBe("2026-10-09");
    expect(lastFinishedBacktestSessionDate(new Date("2026-10-12T22:00:00Z"))).toBe("2026-10-12");
  });
  it("takes the last weekday before today otherwise, over a weekend", () => {
    expect(lastFinishedBacktestSessionDate(new Date("2026-10-11T23:00:00Z"))).toBe("2026-10-09");
    expect(lastFinishedBacktestSessionDate(new Date("2026-10-13T12:00:00Z"))).toBe("2026-10-12");
  });
  it("uses the Eastern date, not the UTC one", () => {
    // 02:00 UTC Tuesday is 22:00 ET Monday: Monday's session is finished.
    expect(lastFinishedBacktestSessionDate(new Date("2026-10-13T02:00:00Z"))).toBe("2026-10-12");
  });
});

describe("isIsoCalendarDate", () => {
  it("accepts real calendar dates only", () => {
    expect(isIsoCalendarDate("2024-02-29")).toBe(true);
    expect(isIsoCalendarDate("2023-02-29")).toBe(false);
    expect(isIsoCalendarDate("2024-2-1")).toBe(false);
    expect(isIsoCalendarDate(20240201)).toBe(false);
  });
});

describe("weekdaysBetweenInclusive", () => {
  it("counts both ends and skips weekends", () => {
    expect(weekdaysBetweenInclusive("2026-10-05", "2026-10-09")).toBe(5);
    expect(weekdaysBetweenInclusive("2026-10-09", "2026-10-12")).toBe(2);
    expect(weekdaysBetweenInclusive("2026-10-10", "2026-10-11")).toBe(0);
  });
});

describe("formatDownloadProgressLabel", () => {
  it("shows the last saved day (the counts are shown beside it)", () => {
    expect(formatDownloadProgressLabel("2024-03-15")).toBe("saved up to 2024-03-15");
    expect(formatDownloadProgressLabel(null)).toBe("starting");
  });
});

describe("estimateSecondsLeft", () => {
  it("projects the remaining work at the pace between the first and last sample", () => {
    // 10 days in 50 s = 5 s a day; 100 days left = 500 s.
    expect(estimateSecondsLeft([{ atMilliseconds: 0, done: 100 }, { atMilliseconds: 50_000, done: 110 }], 110, 210)).toBe(500);
  });
  it("is null without a measurable pace or when nothing is left", () => {
    expect(estimateSecondsLeft([{ atMilliseconds: 0, done: 5 }], 5, 10)).toBeNull();
    expect(estimateSecondsLeft([{ atMilliseconds: 0, done: 5 }, { atMilliseconds: 10_000, done: 5 }], 5, 10)).toBeNull();
    expect(estimateSecondsLeft([{ atMilliseconds: 0, done: 5 }, { atMilliseconds: 10_000, done: 10 }], 10, 10)).toBeNull();
    expect(estimateSecondsLeft([{ atMilliseconds: 0, done: 0 }, { atMilliseconds: 10_000, done: 0 }], 0, 0)).toBeNull();
  });
});

describe("appendProgressSample", () => {
  it("ignores a repeat of the newest observation and drops samples outside the window", () => {
    const samples = appendProgressSample([{ atMilliseconds: 0, done: 1 }], { atMilliseconds: 0, done: 1 });
    expect(samples).toEqual([{ atMilliseconds: 0, done: 1 }]);
    const later = appendProgressSample(samples, { atMilliseconds: recentPaceWindowMilliseconds + 1, done: 9 });
    expect(later).toEqual([{ atMilliseconds: recentPaceWindowMilliseconds + 1, done: 9 }]);
  });
  it("starts over when progress goes backwards (a re-run)", () => {
    expect(appendProgressSample([{ atMilliseconds: 0, done: 50 }], { atMilliseconds: 5_000, done: 2 })).toEqual([{ atMilliseconds: 5_000, done: 2 }]);
  });
});

describe("computeJobRunSeconds", () => {
  const startedAt = new Date("2026-10-12T04:00:00Z");
  const now = new Date("2026-10-12T05:30:00Z");

  it("counts a running job up to now, a finished one up to its finish and a stopped one up to its last heartbeat", () => {
    expect(computeJobRunSeconds({ earlierRunSeconds: 0, startedAt, finishedAt: null, heartbeatAt: now }, "running", now)).toBe(5_400);
    expect(computeJobRunSeconds({ earlierRunSeconds: 0, startedAt, finishedAt: new Date("2026-10-12T04:12:30Z"), heartbeatAt: null }, "succeeded", now)).toBe(750);
    expect(computeJobRunSeconds({ earlierRunSeconds: 0, startedAt, finishedAt: null, heartbeatAt: new Date("2026-10-12T04:20:00Z") }, "stopped", now)).toBe(1_200);
  });

  it("adds the earlier runs of a resumed download, and shows only those while it waits in the queue", () => {
    expect(computeJobRunSeconds({ earlierRunSeconds: 3_600, startedAt, finishedAt: null, heartbeatAt: now }, "running", now)).toBe(9_000);
    expect(computeJobRunSeconds({ earlierRunSeconds: 3_600, startedAt, finishedAt: null, heartbeatAt: null }, "queued", now)).toBe(3_600);
  });

  it("is null for a job that has never run", () => {
    expect(computeJobRunSeconds({ earlierRunSeconds: 0, startedAt: null, finishedAt: null, heartbeatAt: null }, "queued", now)).toBeNull();
  });
});
