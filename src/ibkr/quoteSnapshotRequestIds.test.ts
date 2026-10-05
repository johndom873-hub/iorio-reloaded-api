import { describe, expect, it } from "vitest";
import { allocateQuoteSnapshotRequestId } from "./quoteSnapshotRequestIds.js";

describe("allocateQuoteSnapshotRequestId", () => {
  it("never hands the same id to two concurrent snapshots", () => {
    const ids = Array.from({ length: 500 }, () => allocateQuoteSnapshotRequestId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays inside 80_000-89_999, clear of the contract-resolution ids below and the order ids, wrapping instead of growing", () => {
    const ids = Array.from({ length: 25_000 }, () => allocateQuoteSnapshotRequestId());
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(80_000);
    expect(Math.max(...ids)).toBeLessThan(90_000);
  });
});
