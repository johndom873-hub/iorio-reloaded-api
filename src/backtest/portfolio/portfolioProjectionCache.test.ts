import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { portfolioProjectionCodeHash, readSavedProjection, savedProjectionKey, saveProjection } from "./portfolioProjectionCache.js";

describe("the key a projection is saved under", () => {
  const input = () => ({ accountDollars: 1_000_000, history: { day: Float64Array.from([0.01, -0.02]) }, pathCount: 500 });

  it("is the same for the same input and code, and changes with any number in it or with the code", () => {
    expect(savedProjectionKey(input(), "code-a")).toBe(savedProjectionKey(input(), "code-a"));
    const changedDay = input();
    changedDay.history.day[1] = -0.021;
    expect(savedProjectionKey(changedDay, "code-a")).not.toBe(savedProjectionKey(input(), "code-a"));
    expect(savedProjectionKey({ ...input(), pathCount: 501 }, "code-a")).not.toBe(savedProjectionKey(input(), "code-a"));
    expect(savedProjectionKey(input(), "code-b")).not.toBe(savedProjectionKey(input(), "code-a"));
  });

  it("hashes the projection's code once per process", () => {
    expect(portfolioProjectionCodeHash()).toMatch(/^[0-9a-f]{64}$/);
    expect(portfolioProjectionCodeHash()).toBe(portfolioProjectionCodeHash());
  });
});

describe("saved projections", () => {
  let dataDirectory: string;

  beforeEach(() => {
    dataDirectory = mkdtempSync(path.join(tmpdir(), "saved-projections-"));
  });

  afterEach(() => {
    rmSync(dataDirectory, { recursive: true, force: true });
  });

  it("read back what was saved under a key, with when, and nothing under another", () => {
    saveProjection(dataDirectory, "key-a", { asOf: "2026-11-02", cagr: 0.15 }, new Date("2026-11-04T01:00:00Z"));
    expect(readSavedProjection(dataDirectory, "key-a")).toEqual({ projection: { asOf: "2026-11-02", cagr: 0.15 }, savedAt: "2026-11-04T01:00:00.000Z" });
    expect(readSavedProjection(dataDirectory, "key-b")).toBeNull();
  });

  it("are deleted after 14 days when another is saved", () => {
    saveProjection(dataDirectory, "old", { asOf: "2026-10-01" });
    const oldFile = path.join(dataDirectory, "portfolio-projections", "old.json");
    const fifteenDaysAgo = new Date(Date.now() - 15 * 86_400_000);
    utimesSync(oldFile, fifteenDaysAgo, fifteenDaysAgo);
    saveProjection(dataDirectory, "recent", { asOf: "2026-11-02" });
    expect(existsSync(oldFile)).toBe(false);
    expect(readSavedProjection(dataDirectory, "recent")).not.toBeNull();
  });
});
