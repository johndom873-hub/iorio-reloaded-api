import { describe, expect, it, vi } from "vitest";
import type { IbkrConnection } from "../ibkr/connectIbkr.js";
import { describePlutoSplitCheckOutcome, runPlutoSplitCheck, type PlutoSplitCheckDependencies } from "./plutoSplitCheck.js";

function dependencies(overrides: Partial<PlutoSplitCheckDependencies> = {}): PlutoSplitCheckDependencies & { disconnect: ReturnType<typeof vi.fn> } {
  const disconnect = vi.fn();
  return {
    disconnect,
    loadPlutoTickers: async () => [
      { tickerId: "t1", symbol: "AAA" },
      { tickerId: "t2", symbol: "BBB" },
    ],
    connect: async () => ({ ib: {}, disconnect }) as unknown as IbkrConnection,
    topUp: vi.fn(async () => undefined),
    loadPendingSplits: async () => [{ tickerId: "t2", ratio: 2, effectiveDateIso: "2026-10-20", recordsRewrittenAt: null }],
    ...overrides,
  };
}

describe("runPlutoSplitCheck", () => {
  it("does nothing while no ticker is enabled in Pluto", async () => {
    const deps = dependencies({ loadPlutoTickers: async () => [] });
    const connect = vi.spyOn(deps, "connect");
    expect(await runPlutoSplitCheck(deps)).toEqual({ checkedSymbols: [], failed: [], pendingSplits: [] });
    expect(connect).not.toHaveBeenCalled();
  });

  it("tops up each Pluto ticker's daily bars (which records a split it finds) and reports the pending splits", async () => {
    const deps = dependencies();
    const result = await runPlutoSplitCheck(deps);
    expect(deps.topUp).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ checkedSymbols: ["AAA", "BBB"], failed: [], pendingSplits: [{ tickerId: "t2", symbol: "BBB", ratio: 2, effectiveDateIso: "2026-10-20", recordsRewrittenAt: null }] });
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(describePlutoSplitCheckOutcome(result)).toEqual({});
  });

  it("a ticker that fails is an error of its own; all failing is a failure", async () => {
    const oneFails = await runPlutoSplitCheck(dependencies({ topUp: async (_connection, _tickerId, symbol) => { if (symbol === "AAA") throw new Error("no data"); } }));
    expect(oneFails.failed).toEqual([{ symbol: "AAA", message: "no data" }]);
    expect(describePlutoSplitCheckOutcome(oneFails)).toEqual({ completedWithErrors: { errorCount: 1, message: "split check failed for AAA: no data" } });
    const allFail = await runPlutoSplitCheck(dependencies({ topUp: async () => { throw new Error("timeout"); } }));
    expect(describePlutoSplitCheckOutcome(allFail).failureMessage).toBe("no Pluto ticker's daily bars could be checked for a split (AAA: timeout; BBB: timeout)");
  });
});
