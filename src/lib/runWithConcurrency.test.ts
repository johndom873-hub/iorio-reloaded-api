import { describe, expect, it } from "vitest";
import { runWithConcurrency } from "./runWithConcurrency.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

describe("runWithConcurrency", () => {
  it("handles every item once, never more than workerCount at a time", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const handled: number[] = [];
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, item % 3));
      handled.push(item);
      inFlight--;
    });
    expect(handled.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(mostInFlight).toBe(3);
  });

  it("hands the next item to whichever worker frees up first", async () => {
    const slow = deferred();
    const started: string[] = [];
    const run = runWithConcurrency(["slow", "fast", "next"], 2, async (item) => {
      started.push(item);
      if (item === "slow") await slow.promise;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual(["slow", "fast", "next"]);
    slow.resolve();
    await run;
  });

  it("starts no more workers than items, and at least one", async () => {
    let inFlight = 0;
    let mostInFlight = 0;
    const track = async () => {
      inFlight++;
      mostInFlight = Math.max(mostInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
    };
    await runWithConcurrency(["a", "b"], 20, track);
    expect(mostInFlight).toBe(2);
    mostInFlight = 0;
    await runWithConcurrency(["a", "b"], 0, track);
    expect(mostInFlight).toBe(1);
    await expect(runWithConcurrency([], 5, track)).resolves.toBeUndefined();
  });

  it("rejects when a handler throws", async () => {
    await expect(
      runWithConcurrency([1, 2], 2, async (item) => {
        if (item === 2) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
