import { describe, expect, it } from "vitest";
import { classifyOptionLegRetirement } from "./optionLegRetirement.js";

// 17:00 Eastern on 2026-09-24, after that day's option expiry close.
const today = new Date("2026-09-24T21:00:00Z");

describe("classifyOptionLegRetirement", () => {
  it("is still_open while any option leg has no exit", () => {
    expect(
      classifyOptionLegRetirement(
        [
          { exitAt: null, expiryDate: "2026-09-18", hasClosingTrade: false },
          { exitAt: "2026-09-19T02:00:00Z", expiryDate: "2026-09-18", hasClosingTrade: false },
        ],
        today,
      ),
    ).toBe("still_open");
  });

  it("is settled when every retired leg is past expiry", () => {
    expect(classifyOptionLegRetirement([{ exitAt: "2026-09-19T02:00:00Z", expiryDate: "2026-09-18", hasClosingTrade: false }], today)).toBe("settled");
  });

  it("treats expiry on the current Eastern trading date as settled once the 16:00 close has passed", () => {
    expect(classifyOptionLegRetirement([{ exitAt: new Date("2026-09-24T21:00:00Z"), expiryDate: "2026-09-24", hasClosingTrade: false }], today)).toBe("settled");
  });

  it("is ambiguous on the expiry date before the 16:00 close: the contract is still tradable, so its absence is a report gap", () => {
    const morning = new Date("2026-09-24T14:00:00Z");
    expect(classifyOptionLegRetirement([{ exitAt: morning, expiryDate: "2026-09-24", hasClosingTrade: false }], morning)).toBe("ambiguous");
  });

  it("is settled when a retired leg was closed by a real trade before expiry", () => {
    expect(classifyOptionLegRetirement([{ exitAt: "2026-09-22T15:00:00Z", expiryDate: "2026-10-16", hasClosingTrade: true }], today)).toBe("settled");
  });

  it("is ambiguous when a leg vanished before expiry with no closing trade", () => {
    expect(classifyOptionLegRetirement([{ exitAt: "2026-09-24T14:00:00Z", expiryDate: "2026-10-16", hasClosingTrade: false }], today)).toBe("ambiguous");
  });

  it("is ambiguous when a retired leg has no expiry date and no closing trade", () => {
    expect(classifyOptionLegRetirement([{ exitAt: "2026-09-24T14:00:00Z", expiryDate: null, hasClosingTrade: false }], today)).toBe("ambiguous");
  });

  it("one ambiguous leg makes the whole set ambiguous", () => {
    expect(
      classifyOptionLegRetirement(
        [
          { exitAt: "2026-09-19T02:00:00Z", expiryDate: "2026-09-18", hasClosingTrade: false },
          { exitAt: "2026-09-24T14:00:00Z", expiryDate: "2026-10-16", hasClosingTrade: false },
        ],
        today,
      ),
    ).toBe("ambiguous");
  });

  it("no option legs at all counts as settled (nothing to wait for)", () => {
    expect(classifyOptionLegRetirement([], today)).toBe("settled");
  });
});
