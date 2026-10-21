import { describe, expect, it } from "vitest";
import { classifyRoutineOrderProblem } from "./routineOrderProblems.js";

describe("classifyRoutineOrderProblem", () => {
  it("names the routine problems the worker and IBKR report", () => {
    expect(classifyRoutineOrderProblem("The order's limit price failed the live-quote check at placement: Limit price 0.80 for AAA Sell $45 Put · 20 Nov (31DTE) · 2× is 0.10 below the live mid 0.90 (bid 0.88, ask 0.92); at most 0.05 is allowed.")).toBe("drifted_price");
    expect(classifyRoutineOrderProblem("The order's limit price failed the live-quote check at placement: No live two-sided quote for AAA Sell $45 Put · 20 Nov (31DTE) · 2×, so its limit price 0.80 cannot be checked.")).toBe("missing_quote");
    expect(classifyRoutineOrderProblem("The order's limit price could not be checked against a live quote at placement (timeout).")).toBe("missing_quote");
    expect(classifyRoutineOrderProblem("IBKR error 110: The price does not conform to the minimum price variation for this contract.")).toBe("tick_size");
    expect(classifyRoutineOrderProblem("IBKR error 201: Order rejected - reason:YOUR ORDER IS NOT ACCEPTED. IN ORDER TO OBTAIN THE DESIRED POSITION YOUR EQUITY WITH LOAN VALUE [10000 USD] MUST EXCEED THE INITIAL MARGIN [12000 USD]")).toBe("margin");
  });

  it("leaves every other error to the breaker", () => {
    expect(classifyRoutineOrderProblem("IBKR error 201: Order rejected - reason:The contract is not available for trading.")).toBeNull();
    expect(classifyRoutineOrderProblem("IBKR error 200: No security definition has been found for the request")).toBeNull();
    expect(classifyRoutineOrderProblem("Trading blocked by account binding: mismatch")).toBeNull();
    expect(classifyRoutineOrderProblem(null)).toBeNull();
  });
});
