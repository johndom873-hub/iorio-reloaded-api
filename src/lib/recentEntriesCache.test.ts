import { describe, expect, it } from "vitest";
import { RecentEntriesCache } from "./recentEntriesCache.js";

describe("RecentEntriesCache", () => {
  it("keeps the latest entries across a generation change and drops the oldest", () => {
    const cache = new RecentEntriesCache<string, number | null>(2);
    cache.set("a", 1);
    cache.set("b", null);
    cache.set("c", 3); // the full generation (a, b) becomes the previous one
    expect(cache.has("b")).toBe(true);
    expect(cache.get("a")).toBe(1); // a moves to the current generation (c, a)
    cache.set("d", 4); // (c, a) becomes the previous one, b is dropped
    expect(cache.has("b")).toBe(false);
    expect(cache.get("b")).toBeUndefined();
    expect([cache.get("c"), cache.get("a"), cache.get("d")]).toEqual([3, 1, 4]);
  });

  it("keeps a cached null apart from a missing entry", () => {
    const cache = new RecentEntriesCache<string, number | null>(5);
    cache.set("unsolvable", null);
    expect(cache.get("unsolvable")).toBeNull();
    expect(cache.get("never asked")).toBeUndefined();
  });

  it("refuses a limit under 1", () => {
    expect(() => new RecentEntriesCache(0)).toThrow(RangeError);
  });
});
