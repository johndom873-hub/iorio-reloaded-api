import { describe, expect, it } from "vitest";
import { allocateContractResolutionRequestId } from "./contractResolutionRequestIds.js";

describe("allocateContractResolutionRequestId", () => {
  it("never hands the same id to two concurrent resolutions", () => {
    const ids = Array.from({ length: 500 }, () => allocateContractResolutionRequestId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("stays inside its reserved range, wrapping instead of growing into order-id territory", () => {
    const ids = Array.from({ length: 25_000 }, () => allocateContractResolutionRequestId());
    expect(Math.min(...ids)).toBeGreaterThanOrEqual(70_000);
    expect(Math.max(...ids)).toBeLessThan(80_000);
  });
});
