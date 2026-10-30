import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createExpiringPromiseCache } from "./expiringPromiseCache.js";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-30T01:00:00Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("createExpiringPromiseCache", () => {
  it("shares one load between callers asking for the same key while it runs", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 5 });
    const pending = deferred<string>();
    const load = vi.fn(() => pending.promise);
    const first = cache.get("IREN:1D", load);
    const second = cache.get("IREN:1D", load);
    pending.resolve("bars");
    expect(await first).toBe("bars");
    expect(await second).toBe("bars");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("keeps a resolved value for the time to live, then loads again", async () => {
    const cache = createExpiringPromiseCache<number>({ ttlMs: 30_000, maxEntries: 5 });
    let loads = 0;
    const load = vi.fn(async () => ++loads);
    expect(await cache.get("key", load)).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(await cache.get("key", load)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await cache.get("key", load)).toBe(2);
  });

  it("frees an entry when its time is up even if nobody reads it again, leaving no timer behind", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 5 });
    await cache.get("a", async () => "x");
    await cache.get("b", async () => "y");
    expect(cache.size()).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cache.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a failed load at once, passes the error on and loads again on the next call", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 5 });
    await expect(cache.get("key", async () => Promise.reject(new Error("Historical data timeout")))).rejects.toThrow("Historical data timeout");
    expect(cache.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await cache.get("key", async () => "second try")).toBe("second try");
  });

  it("treats a load that throws before returning a promise as a failed load", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 5 });
    await expect(
      cache.get("key", () => {
        throw new Error("no connection");
      }),
    ).rejects.toThrow("no connection");
    expect(cache.size()).toBe(0);
  });

  it("never holds more than the maximum: the oldest entry and its timer go first", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 2 });
    await cache.get("first", async () => "1");
    await cache.get("second", async () => "2");
    await cache.get("third", async () => "3");
    expect(cache.size()).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    const reload = vi.fn(async () => "1 again");
    expect(await cache.get("first", reload)).toBe("1 again");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(await cache.get("third", async () => "unused")).toBe("3");
  });

  it("a load evicted while it was still running does not come back or leave a timer when it finishes", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 1 });
    const slow = deferred<string>();
    const slowResult = cache.get("slow", () => slow.promise);
    await cache.get("fast", async () => "fast");
    slow.resolve("slow");
    expect(await slowResult).toBe("slow");
    expect(cache.size()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("clear empties the cache and cancels every timer", async () => {
    const cache = createExpiringPromiseCache<string>({ ttlMs: 30_000, maxEntries: 5 });
    await cache.get("a", async () => "x");
    await cache.get("b", async () => "y");
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
