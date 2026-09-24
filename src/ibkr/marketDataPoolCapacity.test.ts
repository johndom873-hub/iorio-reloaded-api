import { describe, expect, it } from "vitest";
import { planPoolCapacity, type PoolCapacityEntry } from "./marketDataPoolCapacity.js";

const entry = (poolKey: string, legType: "stock" | "option", sequence: number, paused = false): PoolCapacityEntry => ({ poolKey, legType, sequence, paused });

describe("planPoolCapacity", () => {
  const entries = [entry("stock|AAA", "stock", 1), entry("option|AAA|1", "option", 2), entry("stock|BBB", "stock", 3), entry("option|BBB|1", "option", 4), entry("option|CCC|1", "option", 5)];

  it("does nothing when everything fits", () => {
    expect(planPoolCapacity(entries, 5)).toEqual({ pauseKeys: [], resumeKeys: [] });
    expect(planPoolCapacity(entries, 90)).toEqual({ pauseKeys: [], resumeKeys: [] });
  });

  it("sheds option contracts first, newest first, then stocks newest first", () => {
    expect(planPoolCapacity(entries, 3).pauseKeys).toEqual(["option|CCC|1", "option|BBB|1"]);
    expect(planPoolCapacity(entries, 1).pauseKeys).toEqual(["option|CCC|1", "option|BBB|1", "option|AAA|1", "stock|BBB"]);
    expect(planPoolCapacity(entries, 0).pauseKeys).toHaveLength(5);
  });

  it("resumes in the reverse order (stocks first, oldest first) only as far as the room allows", () => {
    const shed = [entry("stock|AAA", "stock", 1), entry("option|AAA|1", "option", 2, true), entry("stock|BBB", "stock", 3, true), entry("option|BBB|1", "option", 4, true)];
    expect(planPoolCapacity(shed, 3).resumeKeys).toEqual(["stock|BBB", "option|AAA|1"]);
    expect(planPoolCapacity(shed, 1)).toEqual({ pauseKeys: [], resumeKeys: [] });
    expect(planPoolCapacity(shed, 10).resumeKeys).toEqual(["stock|BBB", "option|AAA|1", "option|BBB|1"]);
  });

  it("never pauses an already-paused entry or resumes an active one", () => {
    const mixed = [entry("stock|AAA", "stock", 1), entry("option|AAA|1", "option", 2, true)];
    expect(planPoolCapacity(mixed, 0)).toEqual({ pauseKeys: ["stock|AAA"], resumeKeys: [] });
  });
});
