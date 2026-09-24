import { EventEmitter } from "node:events";
import type { IBApi } from "@stoqey/ib";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRollingQuoteWindow, type WindowContract, type WindowQuote } from "./daySignalsQuoteWindow.js";

class FakeIb extends EventEmitter {
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
  reqIdAt(index: number): number {
    return this.reqMktData.mock.calls[index]![0] as number;
  }
}
const asIb = (fake: FakeIb) => fake as unknown as IBApi;

const option = (strike: number, right: "C" | "P" = "P"): WindowContract => ({ key: `t1|2026-10-16|${strike}|${right}`, legType: "option", symbol: "AAA", expiry: "20261016", strike, right });
const stock: WindowContract = { key: "t1|stock", legType: "stock", symbol: "AAA" };

function harness(contracts: WindowContract[], concurrency: number, timeoutMs = 4_000) {
  const ib = new FakeIb();
  let nextReqId = 100;
  const settled: { contract: WindowContract; quote: WindowQuote }[] = [];
  const abort = new AbortController();
  const result = runRollingQuoteWindow(contracts, { ib: asIb(ib), allocateReqId: () => nextReqId++, concurrency, timeoutMs, signal: abort.signal, onSettled: (contract, quote) => settled.push({ contract, quote }) });
  return { ib, settled, abort, result };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("runRollingQuoteWindow", () => {
  it("keeps at most `concurrency` lines open and refills a slot the moment a contract settles", async () => {
    const { ib, settled, result } = harness([option(90), option(95), option(100), stock], 2);
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    ib.emit(EventName.tickPrice, ib.reqIdAt(0), 1, 1.1, {});
    ib.emit(EventName.tickPrice, ib.reqIdAt(0), 2, 1.2, {});
    expect(ib.cancelMktData).toHaveBeenCalledWith(ib.reqIdAt(0));
    expect(ib.reqMktData).toHaveBeenCalledTimes(3); // slot refilled immediately
    expect(settled[0]).toMatchObject({ contract: option(90), quote: { bid: 1.1, ask: 1.2, errorCode: null, timedOut: false } });
    for (const index of [1, 2, 3]) {
      ib.emit(EventName.tickPrice, ib.reqIdAt(index), 4, 5, {});
      ib.emit(EventName.tickPrice, ib.reqIdAt(index), 1, 4.9, {});
      ib.emit(EventName.tickPrice, ib.reqIdAt(index), 2, 5.1, {});
    }
    await expect(result).resolves.toEqual({ settled: 4, disconnected: false, aborted: false });
    expect(settled.map((entry) => entry.contract.key)).toEqual(["t1|2026-10-16|90|P", "t1|2026-10-16|95|P", "t1|2026-10-16|100|P", "t1|stock"]);
    expect(settled[3]!.quote.last).toBe(5);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });

  it("settles on an explicit no-data (-1) side, on an IBKR error, and on the per-contract timeout", async () => {
    const { ib, settled, result } = harness([option(80), option(85), option(90)], 3, 4_000);
    ib.emit(EventName.tickPrice, ib.reqIdAt(0), 1, -1, {});
    ib.emit(EventName.error, new Error("using delayed data"), 10167, ib.reqIdAt(1)); // informational, must not settle
    ib.emit(EventName.error, new Error("No security definition"), 200, ib.reqIdAt(1));
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(result).resolves.toMatchObject({ settled: 3 });
    expect(settled.map((entry) => entry.quote)).toMatchObject([
      { bid: null, ask: null, errorCode: null, timedOut: false },
      { errorCode: 200, timedOut: false },
      { errorCode: null, timedOut: true },
    ]);
    expect(ib.cancelMktData).toHaveBeenCalledTimes(3);
  });

  it("stops on a connection drop without reporting the in-flight contracts, and stops on abort", async () => {
    const dropped = harness([option(90), option(95), option(100)], 2);
    dropped.ib.emit(EventName.disconnected);
    await expect(dropped.result).resolves.toEqual({ settled: 0, disconnected: true, aborted: false });
    expect(dropped.settled).toHaveLength(0);
    expect(dropped.ib.reqMktData).toHaveBeenCalledTimes(2);

    const aborted = harness([option(90), option(95)], 1);
    aborted.abort.abort();
    await expect(aborted.result).resolves.toEqual({ settled: 0, disconnected: false, aborted: true });
    expect(aborted.ib.cancelMktData).toHaveBeenCalledTimes(1);
  });

  it("subscribes an option with its expiry/strike/right and a stock as SMART/USD, and resolves at once for an empty list", async () => {
    const { ib, result } = harness([option(120, "C"), stock], 2);
    expect(ib.reqMktData.mock.calls[0]![1]).toMatchObject({ symbol: "AAA", lastTradeDateOrContractMonth: "20261016", strike: 120, right: "C" });
    expect(ib.reqMktData.mock.calls[1]![1]).toMatchObject({ symbol: "AAA", secType: "STK", currency: "USD" });
    await vi.advanceTimersByTimeAsync(4_000);
    await result;
    const empty = harness([], 2);
    await expect(empty.result).resolves.toEqual({ settled: 0, disconnected: false, aborted: false });
  });
});
