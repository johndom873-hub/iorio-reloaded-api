import { describe, expect, it, vi } from "vitest";

vi.mock("../db/connection.js", () => ({ db: {} }));

const { confirmPositionMismatches, positionMismatchConfirmationMs } = await import("./checkPositionReconciliation.js");

describe("confirmPositionMismatches", () => {
  it("a clean first read is the result, with no second read and no wait", async () => {
    const compare = vi.fn().mockResolvedValue([]);
    const wait = vi.fn().mockResolvedValue(undefined);
    expect(await confirmPositionMismatches(compare, wait)).toEqual([]);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it("a short reply that is whole again 30 s later reports nothing (the Gateway reconnecting)", async () => {
    const compare = vi.fn().mockResolvedValueOnce(["SNXX option leg(s) marked open (total quantity 80) but IBKR reports no holding for conId 856795342."]).mockResolvedValueOnce([]);
    const wait = vi.fn().mockResolvedValue(undefined);
    expect(await confirmPositionMismatches(compare, wait)).toEqual([]);
    expect(wait).toHaveBeenCalledWith(positionMismatchConfirmationMs);
    expect(positionMismatchConfirmationMs).toBe(30_000);
  });

  it("a discrepancy still there on the second read is reported as the second read found it", async () => {
    const compare = vi.fn().mockResolvedValueOnce(["first wording"]).mockResolvedValueOnce(["second wording"]);
    expect(await confirmPositionMismatches(compare, vi.fn().mockResolvedValue(undefined))).toEqual(["second wording"]);
  });
});
