import { describe, expect, it, vi } from "vitest";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { describeLadderSplitCheckOutcome, runLadderSplitCheck, type LadderSplitCheckDependencies } from "./ladderSplitCheck.js";

function dependencies(overrides: Partial<LadderSplitCheckDependencies> = {}): LadderSplitCheckDependencies & { disconnect: ReturnType<typeof vi.fn> } {
  const disconnect = vi.fn();
  return {
    disconnect,
    loadLadderTickers: async () => [
      { tickerId: "t1", symbol: "AAA" },
      { tickerId: "t2", symbol: "BBB" },
    ],
    connect: async () => ({ ib: {}, disconnect }) as unknown as IbkrConnection,
    topUp: vi.fn(async () => undefined),
    loadPendingSplits: async () => [{ tickerId: "t2", ratio: 2, effectiveDateIso: "2026-10-20", recordsRewrittenAt: null }],
    ...overrides,
  };
}

describe("runLadderSplitCheck", () => {
  it("does nothing while no ladder ticker is enabled (another strategy active)", async () => {
    const deps = dependencies({ loadLadderTickers: async () => [] });
    const connect = vi.spyOn(deps, "connect");
    expect(await runLadderSplitCheck(deps)).toEqual({ checkedSymbols: [], failed: [], pendingSplits: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("tops up each ladder ticker's daily bars (which records a split it finds) and reports the pending splits", async () => {
    const deps = dependencies();
    const result = await runLadderSplitCheck(deps);
    expect(deps.topUp).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checkedSymbols: ["AAA", "BBB"], failed: [], pendingSplits: [{ tickerId: "t2", symbol: "BBB", ratio: 2, effectiveDateIso: "2026-10-20", recordsRewrittenAt: null }] });
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(describeLadderSplitCheckOutcome(result)).toEqual({});
  });

  it("a ticker that fails is an error of its own; all failing is a failure", async () => {
    const oneFails = await runLadderSplitCheck(dependencies({ topUp: async (_connection, _tickerId, symbol) => { if (symbol === "AAA") throw new Error("no data"); } }));
    expect(oneFails.failed).toEqual([{ symbol: "AAA", message: "no data" }]);
    expect(describeLadderSplitCheckOutcome(oneFails)).toEqual({ completedWithErrors: { errorCount: 1, message: "split check failed for AAA: no data" } });
    const allFail = await runLadderSplitCheck(dependencies({ topUp: async () => { throw new Error("timeout"); } }));
    expect(describeLadderSplitCheckOutcome(allFail).failureMessage).toBe("no ladder ticker's daily bars could be checked for a split (AAA: timeout; BBB: timeout)");
  });
});
