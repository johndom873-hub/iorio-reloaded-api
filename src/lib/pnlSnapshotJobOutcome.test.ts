import { describe, expect, it } from "vitest";
import { buildPnlSnapshotJobOutcome } from "./pnlSnapshotJobOutcome.js";

describe("buildPnlSnapshotJobOutcome", () => {
  it("is empty when nothing went wrong", () => {
    expect(buildPnlSnapshotJobOutcome([])).toEqual({});
  });

  it("completes with errors for skipped positions and missing greeks, counting each position and leg", () => {
    expect(
      buildPnlSnapshotJobOutcome([
        { message: "2 of 9 positions skipped for a missing price: AAA, BBB", errorCount: 2, nothingUsable: false },
        { message: "greeks saved for 4/7 open option leg(s)", errorCount: 3, nothingUsable: false },
        { message: "Flex cash-flow reconcile failed", errorCount: 1, nothingUsable: false },
      ]),
    ).toEqual({ completedWithErrors: { errorCount: 6, message: "2 of 9 positions skipped for a missing price: AAA, BBB; greeks saved for 4/7 open option leg(s); Flex cash-flow reconcile failed" } });
  });

  it("fails when the account-level row or every position snapshot is missing, keeping every problem in the message", () => {
    expect(
      buildPnlSnapshotJobOutcome([
        { message: "Flex cash-flow reconcile failed", errorCount: 1, nothingUsable: false },
        { message: "account-level P&L failed for 2026-10-14 - timeout", errorCount: 1, nothingUsable: true },
      ]),
    ).toEqual({ failureMessage: "Flex cash-flow reconcile failed; account-level P&L failed for 2026-10-14 - timeout" });
  });
});
