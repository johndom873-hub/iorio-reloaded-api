import { describe, expect, it } from "vitest";
import { normalizeBarVolume } from "./normalizeBarVolume.js";

describe("normalizeBarVolume", () => {
  it("rounds fractional volumes to whole numbers (the value that broke the BMNR and DELL inserts)", () => {
    expect(normalizeBarVolume(134.5)).toBe(135);
    expect(normalizeBarVolume(134.4)).toBe(134);
    expect(normalizeBarVolume(1_234_567.49)).toBe(1_234_567);
  });
  it("leaves whole numbers and zero unchanged", () => {
    expect(normalizeBarVolume(0)).toBe(0);
    expect(normalizeBarVolume(2_150_000)).toBe(2_150_000);
  });
  it("turns missing or non-finite volumes into null, and never returns a negative", () => {
    expect(normalizeBarVolume(null)).toBeNull();
    expect(normalizeBarVolume(undefined)).toBeNull();
    expect(normalizeBarVolume(Number.NaN)).toBeNull();
    expect(normalizeBarVolume(Number.POSITIVE_INFINITY)).toBeNull();
    expect(normalizeBarVolume(-5)).toBe(0);
  });
});
