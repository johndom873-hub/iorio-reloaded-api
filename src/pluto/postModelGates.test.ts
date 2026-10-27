import { describe, expect, it } from "vitest";
import { midLimitPrice, tickerCooldownStatus } from "./postModelGates.js";

describe("midLimitPrice", () => {
  it("is the mid rounded to cents, clamped inside the market", () => {
    expect(midLimitPrice(2.0, 2.1)).toBe(2.05);
    expect(midLimitPrice(1.01, 1.02)).toBe(1.02); // 1.015 rounds up to 1.02, still inside
    expect(midLimitPrice(0.61, 0.62)).toBe(0.62);
  });
});

describe("tickerCooldownStatus (the ladder round's ticker cooldown)", () => {
  const filledAt = new Date("2026-10-07T14:14:26Z");
  it("is over with no filled action, at exactly the cooldown, or with the cooldown set to 0", () => {
    expect(tickerCooldownStatus(null, filledAt.getTime(), 60)).toEqual({ cooledDown: true, detail: "no filled Pluto action on this symbol" });
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 60 * 60_000, 60).cooledDown).toBe(true);
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 60_000, 0).cooledDown).toBe(true);
  });
  it("is still running 48 minutes after a fill (the 10-07 SMCI case)", () => {
    expect(tickerCooldownStatus(filledAt, filledAt.getTime() + 48.7 * 60_000, 60)).toEqual({ cooledDown: false, detail: "last filled Pluto action on this symbol 48 min ago (cooldown 60 min)" });
  });
});
