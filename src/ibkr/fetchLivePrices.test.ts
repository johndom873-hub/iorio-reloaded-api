import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestLivePrices, type PriceContract } from "./fetchLivePrices.js";

class FakeIbApi extends EventEmitter {
  reqMarketDataType = vi.fn();
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
}

const lastTickType = 4;
const stockLeg: PriceContract = { key: "stock", legType: "stock", symbol: "DRAM" };
const optionLeg: PriceContract = { key: "option", legType: "option", symbol: "DRAM", expiry: "20261002", strike: 62 };
const neverTickingLeg: PriceContract = { key: "leap", legType: "option", symbol: "TLT", expiry: "20280616", strike: 82 };

function startRequest(contracts: PriceContract[], settleGraceMs: number | null) {
  const ib = new FakeIbApi();
  let nextReqId = 1;
  const result = requestLivePrices(ib as unknown as IBApi, () => nextReqId++, contracts, 6_000, settleGraceMs);
  const tick = (reqId: number, price: number) => ib.emit(EventName.tickPrice, reqId, lastTickType, price);
  return { ib, result, tick };
}

describe("requestLivePrices settle grace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("without a grace, one leg that never ticks holds the batch to the 6 s ceiling", async () => {
    const { result, tick } = startRequest([stockLeg, optionLeg, neverTickingLeg], null);
    tick(1, 60);
    tick(2, 0.4);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ stock: 60, option: 0.4, leap: null });
  });

  it("with a grace, returns 1 s after the last price that arrived and leaves the silent leg null", async () => {
    const { result, tick, ib } = startRequest([stockLeg, optionLeg, neverTickingLeg], 1_000);
    await vi.advanceTimersByTimeAsync(300);
    tick(1, 60);
    await vi.advanceTimersByTimeAsync(700);
    tick(2, 0.4);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toEqual({ stock: 60, option: 0.4, leap: null });
    expect(ib.cancelMktData).toHaveBeenCalledTimes(3);
  });

  it("a late price restarts the grace, so a slow leg that is still pricing is not cut off", async () => {
    const { result, tick } = startRequest([stockLeg, optionLeg, neverTickingLeg], 1_000);
    tick(1, 60);
    await vi.advanceTimersByTimeAsync(900);
    tick(2, 0.4);
    await vi.advanceTimersByTimeAsync(900);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toEqual({ stock: 60, option: 0.4, leap: null });
  });

  it("resolves at once when every leg priced, with or without a grace", async () => {
    const { result, tick } = startRequest([stockLeg, optionLeg], 1_000);
    tick(1, 60);
    tick(2, 0.4);
    expect(await result).toEqual({ stock: 60, option: 0.4 });
  });

  it("does not hold the process up afterwards: no timer is left running", async () => {
    const { result, tick } = startRequest([stockLeg, neverTickingLeg], 1_000);
    tick(1, 60);
    await vi.advanceTimersByTimeAsync(1_000);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });
});
