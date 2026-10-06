import { EventEmitter } from "node:events";
import type { Knex } from "knex";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("dbQueryTimingTracker", () => {
  let tracker: typeof import("./dbQueryTimingTracker.js");
  let fakeKnex: EventEmitter;

  const startQuery = (uid: string) => fakeKnex.emit("query", { __knexQueryUid: uid });
  const finishQuery = (uid: string) => fakeKnex.emit("query-response", {}, { __knexQueryUid: uid });
  const failQuery = (uid: string) => fakeKnex.emit("query-error", new Error("boom"), { __knexQueryUid: uid });

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    vi.resetModules();
    tracker = await import("./dbQueryTimingTracker.js");
    fakeKnex = new EventEmitter();
    tracker.installDbQueryTimingTracker(fakeKnex as unknown as Knex);
  });
  afterEach(() => vi.useRealTimers());

  it("reports nulls when no query finished", () => {
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: null, slowestMs: null });
  });

  it("times a query from start to response", () => {
    startQuery("a");
    vi.advanceTimersByTime(40);
    finishQuery("a");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 40, slowestMs: 40 });
  });

  it("times a failed query through query-error as well", () => {
    startQuery("a");
    vi.advanceTimersByTime(25);
    failQuery("a");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 25, slowestMs: 25 });
  });

  it("averages and takes the maximum over several queries, including overlapping ones", () => {
    startQuery("a");
    startQuery("b");
    vi.advanceTimersByTime(10);
    finishQuery("a");
    vi.advanceTimersByTime(20);
    finishQuery("b");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 20, slowestMs: 30 });
  });

  it("ignores a response for a query it never saw start", () => {
    finishQuery("unknown");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: null, slowestMs: null });
  });

  it("counts a query once: a second completion event for the same uid is ignored", () => {
    startQuery("a");
    vi.advanceTimersByTime(10);
    finishQuery("a");
    failQuery("a");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 10, slowestMs: 10 });
  });

  it("drops samples that finished more than 5 minutes ago and keeps the rest", () => {
    startQuery("old");
    vi.advanceTimersByTime(100);
    finishQuery("old");
    vi.advanceTimersByTime(5 * 60_000);
    startQuery("recent");
    vi.advanceTimersByTime(10);
    finishQuery("recent");
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 10, slowestMs: 10 });
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: null, slowestMs: null });
  });

  it("keeps a sample that finished exactly 5 minutes ago", () => {
    startQuery("a");
    vi.advanceTimersByTime(10);
    finishQuery("a");
    vi.advanceTimersByTime(5 * 60_000);
    expect(tracker.dbQueryTimingStats().averageMs).toBe(10);
  });

  it("caps memory at the 10,000 newest samples", () => {
    for (let index = 0; index < 10_001; index += 1) {
      startQuery(`q${index}`);
      // The first query takes 1000 ms, every other one 1 ms: once the first is evicted the slowest drops to 1.
      vi.advanceTimersByTime(index === 0 ? 1000 : 1);
      finishQuery(`q${index}`);
    }
    expect(tracker.dbQueryTimingStats()).toEqual({ averageMs: 1, slowestMs: 1 });
  });
});
