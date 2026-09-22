import { describe, expect, it, vi } from "vitest";
import { waitUntilDrained } from "./waitUntilDrained.js";

describe("waitUntilDrained", () => {
  it("resolves immediately (drained: true) when already drained", async () => {
    const result = await waitUntilDrained(() => true, 1000, 10);
    expect(result.drained).toBe(true);
  });

  it("polls until isDrained() flips true, then resolves drained: true", async () => {
    vi.useFakeTimers();
    let remainingChecksUntilDrained = 3;
    const isDrained = vi.fn(() => {
      if (remainingChecksUntilDrained > 0) {
        remainingChecksUntilDrained -= 1;
        return false;
      }
      return true;
    });
    const promise = waitUntilDrained(isDrained, 10_000, 100);
    await vi.advanceTimersByTimeAsync(350);
    const result = await promise;
    expect(result.drained).toBe(true);
    expect(isDrained.mock.calls.length).toBeGreaterThanOrEqual(4);
    vi.useRealTimers();
  });

  it("resolves drained: false once maxWaitMs elapses while still not drained", async () => {
    vi.useFakeTimers();
    const promise = waitUntilDrained(() => false, 500, 100);
    await vi.advanceTimersByTimeAsync(600);
    const result = await promise;
    expect(result.drained).toBe(false);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
    vi.useRealTimers();
  });
});
