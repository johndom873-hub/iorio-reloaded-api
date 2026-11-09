import { describe, expect, it } from "vitest";
import { staleRecordedDepositProblems } from "./recordedDeposits.js";

describe("staleRecordedDepositProblems", () => {
  const deposit = { id: "d1", amount: 1_050_003.7, effectiveAt: new Date("2026-11-09T15:00:00Z"), description: "x" };
  it("reports a recorded deposit only once the statement runs 3 weekdays past its day", () => {
    expect(staleRecordedDepositProblems([deposit], "2026-11-11")).toEqual([]);
    expect(staleRecordedDepositProblems([deposit], "2026-11-12")).toEqual(["the deposit of 1050003.70 recorded on 2026-11-09 is still not in IBKR's statement (through 2026-11-12)"]);
  });
});
