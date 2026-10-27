import type { IBApi } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import type { RollingQuoteWindowOptions, WindowContract } from "../ibkr/rollingQuoteWindow.js";
import { MarketQuoteLoop, type MarketQuoteConsumer, type MarketQuoteLoopDependencies, type QuoteLoopContract, type QuoteLoopCycle, type QuoteLoopOptionQuote } from "./marketQuoteLoop.js";

// A Tuesday, 11:00 ET.
const now = new Date("2026-10-27T15:00:00Z");

function dependencies(windows: WindowContract[][], stop: () => void): MarketQuoteLoopDependencies {
  return {
    now: () => now,
    isMarketOpen: async () => true,
    reserveLines: vi.fn(async () => ({ ok: true }) as never),
    releaseLines: vi.fn(async () => {}),
    borrowLiveConnection: async () => ({ ib: {} as IBApi }),
    allocateReqId: () => 1,
    runQuoteWindow: async (contracts: WindowContract[], options: RollingQuoteWindowOptions) => {
      windows.push(contracts);
      for (const contract of contracts) {
        options.onSettled(contract, { bid: contract.legType === "stock" ? 99.9 : 1, ask: contract.legType === "stock" ? 100.1 : 1.1, last: contract.legType === "stock" ? 100 : null, impliedVolatility: contract.withImpliedVolatility ? 0.3 : null, errorCode: null, timedOut: false, settledAt: now });
      }
      return { settled: contracts.length, disconnected: false, aborted: false };
    },
    writeHeartbeat: async () => {},
    // The first sleep ends the test: one cycle, then stop.
    sleep: async () => stop(),
  };
}

function consumer(name: string, tickers: string[], contracts: QuoteLoopContract[], extra: Partial<MarketQuoteConsumer> = {}): MarketQuoteConsumer & { cycles: QuoteLoopCycle[]; completed: QuoteLoopOptionQuote[][] } {
  const cycles: QuoteLoopCycle[] = [];
  const completed: QuoteLoopOptionQuote[][] = [];
  return {
    name,
    cycles,
    completed,
    tickers: async () => tickers.map((tickerId) => ({ tickerId, symbol: tickerId.toUpperCase() })),
    contracts: async (cycle) => {
      cycles.push(cycle);
      return contracts;
    },
    onCycleComplete: async (quotes) => {
      completed.push(quotes);
    },
    ...extra,
  };
}

const call = (tickerId: string, strike: number): QuoteLoopContract => ({ tickerId, symbol: tickerId.toUpperCase(), expiry: "2026-11-06", strike, right: "C" });

async function runOneCycle(consumers: MarketQuoteConsumer[]) {
  const windows: WindowContract[][] = [];
  let loop: MarketQuoteLoop | null = null;
  const deps = dependencies(windows, () => loop!.stop());
  loop = new MarketQuoteLoop(consumers, deps);
  await loop.start();
  return { windows, deps, status: loop.getStatus() };
}

describe("MarketQuoteLoop", () => {
  it("holds no lines and quotes nothing when no consumer needs a ticker", async () => {
    const { windows, deps } = await runOneCycle([consumer("idle", [], [])]);
    expect(windows).toEqual([]);
    expect(deps.reserveLines).not.toHaveBeenCalled();
  });

  it("quotes the union of the consumers' stocks (with the IV where wanted), then their contracts once each, consumers in priority order", async () => {
    const ladder = consumer("ladder", ["a"], [call("a", 105), call("b", 50)]);
    const volatility = consumer("volatility", ["a", "b"], [call("b", 50), call("b", 55)], { wantsImpliedVolatility: true });
    const { windows, status } = await runOneCycle([ladder, volatility]);
    expect(windows[0]!.map((contract) => [contract.key, contract.withImpliedVolatility])).toEqual([
      ["a|stock", true],
      ["b|stock", true],
    ]);
    expect(windows[1]!.map((contract) => contract.key)).toEqual(["a|2026-11-06|105|C", "b|2026-11-06|50|C", "b|2026-11-06|55|C"]);
    expect(volatility.cycles[0]!.impliedVolatilityByTicker.get("b")).toBe(0.3);
    expect(volatility.cycles[0]!.spotByTicker.get("a")).toBe(100);
    // A contract both wanted reaches both; each only gets its own.
    expect(ladder.completed[0]!.map((quote) => quote.contract.strike)).toEqual([105, 50]);
    expect(volatility.completed[0]!.map((quote) => quote.contract.strike)).toEqual([50, 55]);
    expect(status.lastCycleContractsByConsumer).toEqual({ ladder: 2, volatility: 2 });
  });

  it("carries on without a consumer whose step throws", async () => {
    const broken = consumer("broken", ["a"], [], { contracts: async () => Promise.reject(new Error("boom")) });
    const working = consumer("working", ["a"], [call("a", 100)]);
    const { windows } = await runOneCycle([broken, working]);
    expect(windows[1]!.map((contract) => contract.key)).toEqual(["a|2026-11-06|100|C"]);
    expect(working.completed[0]).toHaveLength(1);
  });
});
