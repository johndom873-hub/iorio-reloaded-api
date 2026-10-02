import { describe, expect, it } from "vitest";
import { isOptionPastExpiry, optionPastExpirySql } from "./optionExpiryClock.js";

describe("isOptionPastExpiry", () => {
  it("is not expired on the expiry date until 16:00 Eastern (daylight time)", () => {
    expect(isOptionPastExpiry("2026-10-02", new Date("2026-10-02T19:59:00Z"))).toBe(false);
    expect(isOptionPastExpiry("2026-10-02", new Date("2026-10-02T20:00:00Z"))).toBe(true);
  });

  it("uses the same 16:00 Eastern close in standard time", () => {
    expect(isOptionPastExpiry("2026-12-18", new Date("2026-12-18T20:59:00Z"))).toBe(false);
    expect(isOptionPastExpiry("2026-12-18", new Date("2026-12-18T21:00:00Z"))).toBe(true);
  });

  it("is not expired in the evening before the expiry date, when the UTC date has already turned", () => {
    expect(isOptionPastExpiry("2026-10-02", new Date("2026-10-02T01:00:00Z"))).toBe(false);
  });

  it("is expired on any later Eastern date and not before an earlier one", () => {
    expect(isOptionPastExpiry("2026-10-02", new Date("2026-10-03T05:00:00Z"))).toBe(true);
    expect(isOptionPastExpiry("2026-10-16", new Date("2026-10-02T20:00:00Z"))).toBe(false);
  });
});

describe("optionPastExpirySql", () => {
  it("names the column it is given", () => {
    expect(optionPastExpirySql("pl.expiry_date")).toContain("pl.expiry_date + interval '16 hours'");
  });
});
