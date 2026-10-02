import { describe, expect, it } from "vitest";
import { waitForOpenPositions } from "./positionExposure.js";
import { sleepUnlessAborted } from "./sleepUnlessAborted.js";

describe("sleepUnlessAborted", () => {
  it("resolves when the time is up, or at once when the signal aborts or already has", async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    await sleepUnlessAborted(20, controller.signal);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(15);

    const abortingController = new AbortController();
    setTimeout(() => abortingController.abort(), 10);
    const abortStartedAt = Date.now();
    await sleepUnlessAborted(60_000, abortingController.signal);
    expect(Date.now() - abortStartedAt).toBeLessThan(1_000);

    await sleepUnlessAborted(60_000, abortingController.signal);
  });
});

describe("waitForOpenPositions", () => {
  it("reports an empty reading for each empty load and returns the first load with a position", async () => {
    const loads = [{ positions: [] }, { positions: [] }, { positions: ["position"] }];
    let loadCount = 0;
    let emptyReadings = 0;
    const result = await waitForOpenPositions(
      async () => loads[loadCount++]!,
      () => emptyReadings++,
      1,
      new AbortController().signal,
    );
    expect(result).toBe(loads[2]);
    expect(loadCount).toBe(3);
    expect(emptyReadings).toBe(2);
  });

  it("returns at once, with no empty reading, when a position is already open", async () => {
    let emptyReadings = 0;
    const result = await waitForOpenPositions(async () => ({ positions: ["position"] }), () => emptyReadings++, 60_000, new AbortController().signal);
    expect(result).toEqual({ positions: ["position"] });
    expect(emptyReadings).toBe(0);
  });

  it("stays idle between empty readings and returns null as soon as the signal aborts", async () => {
    const controller = new AbortController();
    let emptyReadings = 0;
    const waiting = waitForOpenPositions(
      async () => ({ positions: [] }),
      () => emptyReadings++,
      60_000,
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(emptyReadings).toBe(1);
    controller.abort();
    expect(await waiting).toBeNull();
    expect(emptyReadings).toBe(1);
  });
});
