import { describe, expect, it } from "vitest";
import { recordedDepositsAsCashFlows, staleRecordedDepositProblems } from "./recordedDeposits.js";

describe("staleRecordedDepositProblems", () => {
  const deposit = { id: "d1", amount: 1_050_003.7, effectiveAt: new Date("2026-11-09T15:00:00Z"), description: "x" };
  it("reports a recorded deposit only once the statement runs 3 weekdays past its day", () => {
    expect(staleRecordedDepositProblems([deposit], "2026-11-11")).toEqual([]);
    expect(staleRecordedDepositProblems([deposit], "2026-11-12")).toEqual(["the deposit of 1050003.70 recorded on 2026-11-09 is still not in IBKR's statement (through 2026-11-12)"]);
  });
});

describe("recordedDepositsAsCashFlows", () => {
  const deposit = { id: "d1", amount: 1_050_000, effectiveAt: new Date("2026-11-09T04:07:07Z"), description: "x" };
  it("a recorded deposit counts as a cash flow at its recorded time while no statement flow of the same cents is near it", () => {
    expect(recordedDepositsAsCashFlows([deposit], [])).toEqual([{ isoDate: "2026-11-08", occurredAt: deposit.effectiveAt, amount: 1_050_000 }]);
    // A different amount, or the same amount weeks away, is other money.
    expect(recordedDepositsAsCashFlows([deposit], [{ isoDate: "2026-11-09", occurredAt: null, amount: 1_049_975 }])).toHaveLength(1);
    expect(recordedDepositsAsCashFlows([deposit], [{ isoDate: "2026-10-01", occurredAt: new Date("2026-10-01T15:00:00Z"), amount: 1_050_000 }])).toHaveLength(1);
  });
  it("stops counting once the statement holds the transfer (same cents, within 10 days), with or without a time of day", () => {
    expect(recordedDepositsAsCashFlows([deposit], [{ isoDate: "2026-11-10", occurredAt: new Date("2026-11-10T14:00:00Z"), amount: 1_050_000.001 }])).toEqual([]);
    expect(recordedDepositsAsCashFlows([deposit], [{ isoDate: "2026-11-06", occurredAt: null, amount: 1_050_000 }])).toEqual([]);
  });
});
