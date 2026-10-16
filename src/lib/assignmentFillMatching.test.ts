import { describe, expect, it } from "vitest";
import { assignmentFillWindowMs, isAssignmentFillOf, matchAssignmentFills, type AssignedOptionLeg, type RecordedStockFill } from "./assignmentFillMatching.js";

// A $104 put, 3 contracts, whose leg exited at 01:45 UTC the night after its expiry, and IBKR's buy of its 300 shares.
const exitAt = new Date("2026-09-26T01:45:00Z");
const assignedPut = (overrides: Partial<AssignedOptionLeg> = {}): AssignedOptionLeg => ({ id: "put", optionType: "put", strike: 104, quantity: 3, multiplier: 100, exitAt, ...overrides });
const fill = (overrides: Partial<RecordedStockFill> = {}): RecordedStockFill => ({ at: new Date("2026-09-26T01:44:46Z"), side: "buy", quantity: 300, price: 104, ...overrides });

describe("isAssignmentFillOf", () => {
  it("matches the assignment's side, share count and strike within 36 hours of the leg's exit", () => {
    expect(isAssignmentFillOf(assignedPut(), fill())).toBe(true);
    expect(isAssignmentFillOf(assignedPut({ optionType: "call" }), fill({ side: "sell" }))).toBe(true);
    expect(isAssignmentFillOf(assignedPut(), fill({ at: new Date(exitAt.getTime() + assignmentFillWindowMs) }))).toBe(true);
    expect(isAssignmentFillOf(assignedPut(), fill({ price: 104.00004 }))).toBe(true);
  });

  it("rejects the wrong side, another share count, another price, a fill more than 36 hours away, and a leg still open", () => {
    expect(isAssignmentFillOf(assignedPut(), fill({ side: "sell" }))).toBe(false);
    expect(isAssignmentFillOf(assignedPut({ optionType: "call" }), fill())).toBe(false);
    expect(isAssignmentFillOf(assignedPut(), fill({ quantity: 200 }))).toBe(false);
    expect(isAssignmentFillOf(assignedPut(), fill({ price: 104.01 }))).toBe(false);
    expect(isAssignmentFillOf(assignedPut(), fill({ at: new Date(exitAt.getTime() - assignmentFillWindowMs - 1) }))).toBe(false);
    expect(isAssignmentFillOf(assignedPut({ exitAt: null }), fill())).toBe(false);
  });
});

describe("matchAssignmentFills", () => {
  it("gives each leg at most one fill, the closest in time, and each fill to one leg", () => {
    const fills = [fill({ at: new Date("2026-09-26T03:00:00Z") }), fill({ at: new Date("2026-09-26T01:50:00Z") }), fill({ at: new Date("2026-09-26T02:00:00Z") })];
    expect(matchAssignmentFills([assignedPut()], fills)).toEqual(new Map([["put", 1]]));
    const secondPut = assignedPut({ id: "second-put", exitAt: new Date("2026-09-26T01:46:00Z") });
    expect(matchAssignmentFills([secondPut, assignedPut()], fills)).toEqual(new Map([["put", 1], ["second-put", 2]]));
  });

  it("leaves a leg without a matching fill out", () => {
    expect(matchAssignmentFills([assignedPut()], [fill({ quantity: 100 })])).toEqual(new Map());
    expect(matchAssignmentFills([], [fill()])).toEqual(new Map());
  });
});
