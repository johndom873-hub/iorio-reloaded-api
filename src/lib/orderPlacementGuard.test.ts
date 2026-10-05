import { describe, expect, it } from "vitest";
import { findOrderPlacementBlockReason, maximumConfirmedOrderAgeMs } from "./orderPlacementGuard.js";
import type { TradingHalt } from "./platformControls.js";

const now = Date.parse("2026-10-05T14:00:00Z");
const haltOff: TradingHalt = { enabled: false, reason: null, setByUserId: null, setByDisplayName: null, setAt: null };
const haltOn: TradingHalt = { enabled: true, reason: "IBKR data looks wrong", setByUserId: "u1", setByDisplayName: "Marce", setAt: new Date(now - 60_000) };
const freshVerdict = { blocks: [], warnings: [], evaluatedAt: new Date(now - 30_000).toISOString() };

const check = (overrides: Partial<Parameters<typeof findOrderPlacementBlockReason>[0]> = {}) =>
  findOrderPlacementBlockReason({ gateEvaluation: freshVerdict, halt: haltOff, nowMs: now, ...overrides });

describe("findOrderPlacementBlockReason", () => {
  it("lets an order through that passed the gate a moment ago while trading is not halted", () => {
    expect(check()).toBeNull();
  });

  it("refuses everything while halted, naming who and why, even with a perfect verdict", () => {
    expect(check({ halt: haltOn })).toBe("Trading is halted — switched off by Marce 1m ago: IBKR data looks wrong");
  });

  it("the halt outranks every other problem", () => {
    expect(check({ halt: haltOn, gateEvaluation: null })).toContain("Trading is halted");
  });

  it("refuses an order with no stored verdict (never confirmed through the gate)", () => {
    expect(check({ gateEvaluation: null })).toContain("no stored gate verdict");
    expect(check({ gateEvaluation: undefined })).toContain("no stored gate verdict");
  });

  it("refuses a malformed verdict: no list of blocks, or no usable time", () => {
    expect(check({ gateEvaluation: { evaluatedAt: freshVerdict.evaluatedAt } })).toContain("malformed");
    expect(check({ gateEvaluation: { blocks: "none", evaluatedAt: freshVerdict.evaluatedAt } })).toContain("malformed");
    expect(check({ gateEvaluation: { blocks: [] } })).toContain("no valid time");
    expect(check({ gateEvaluation: { blocks: [], evaluatedAt: "not a date" } })).toContain("no valid time");
    expect(check({ gateEvaluation: { blocks: [], evaluatedAt: 12345 } })).toContain("no valid time");
  });

  it("refuses a verdict that recorded blocks, listing them", () => {
    expect(check({ gateEvaluation: { blocks: ["AAPL would be 25% of portfolio value.", "Delta is outside the band."], evaluatedAt: freshVerdict.evaluatedAt } })).toBe(
      "The order's stored gate verdict has blocks: AAPL would be 25% of portfolio value. Delta is outside the band.",
    );
  });

  it("allows a verdict exactly at the maximum age and refuses one a millisecond older", () => {
    expect(check({ gateEvaluation: { blocks: [], evaluatedAt: new Date(now - maximumConfirmedOrderAgeMs).toISOString() } })).toBeNull();
    const expired = check({ gateEvaluation: { blocks: [], evaluatedAt: new Date(now - maximumConfirmedOrderAgeMs - 1).toISOString() } });
    expect(expired).toContain("expired");
    expect(expired).toContain("5 minutes");
  });

  it("says how long ago a long-waiting order was confirmed", () => {
    expect(check({ gateEvaluation: { blocks: [], evaluatedAt: new Date(now - 3 * 60 * 60_000).toISOString() } })).toContain("confirmed 180 minutes ago");
  });

  it("does not treat a verdict stamped slightly in the future (clock skew) as expired", () => {
    expect(check({ gateEvaluation: { blocks: [], evaluatedAt: new Date(now + 2_000).toISOString() } })).toBeNull();
  });
});
