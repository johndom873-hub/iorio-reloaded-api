import { EventEmitter } from "node:events";
import type { IBApi } from "@stoqey/ib";
import { EventName } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { captureOptionQuoteBatch as captureOptionQuoteBatchWithOwnReservation, type CaptureOptionQuoteBatchOptions, type OptionContractRequest } from "./captureOptionQuoteBatch.js";

// The collector reserves lines against the shared DB budget by default; these tests exercise
// the IBKR side only, so they run as the capture job does — under a reservation the caller holds.
const captureOptionQuoteBatch = (ib: IBApi, symbol: string, contracts: OptionContractRequest[], options: CaptureOptionQuoteBatchOptions = {}) =>
  captureOptionQuoteBatchWithOwnReservation(ib, symbol, contracts, { lineReservation: "caller", ...options });

// A stand-in for the IBKR socket: the collector only calls on/removeListener
// (EventEmitter) and reqMktData/cancelMktData, so ticks are emitted by hand.
class FakeIb extends EventEmitter {
  reqMktData = vi.fn();
  cancelMktData = vi.fn();
  reqIdForContract(index: number): number {
    return this.reqMktData.mock.calls[index]![0] as number;
  }
}

const asIb = (fake: FakeIb) => fake as unknown as IBApi;
const put100: OptionContractRequest = { expiry: "20260925", strike: 100, right: "P" };
const call105: OptionContractRequest = { expiry: "20260925", strike: 105, right: "C" };

// Emits a full real-time set of ticks for the contract subscribed at `index`.
function emitFullRealTimeQuote(ib: FakeIb, index: number, openInterestTick = 28): void {
  const reqId = ib.reqIdForContract(index);
  ib.emit(EventName.tickPrice, reqId, 1, 1.1, {});
  ib.emit(EventName.tickPrice, reqId, 2, 1.2, {});
  ib.emit(EventName.tickPrice, reqId, 4, 1.15, {});
  ib.emit(EventName.tickSize, reqId, 0, 40);
  ib.emit(EventName.tickSize, reqId, 3, 25);
  ib.emit(EventName.tickSize, reqId, 8, 88);
  ib.emit(EventName.tickSize, reqId, openInterestTick, 1520);
  ib.emit(EventName.tickOptionComputation, reqId, 13, 0, 0.6123, -0.31, 1.14, 0, 0.041, 0.09, -0.05, 101.25);
}

describe("captureOptionQuoteBatch", () => {
  it("captures prices, sizes, open interest, volume, IV, greeks, model price and the spot used — and resolves early once settled", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 5_000 });
    const startedAt = Date.now();
    emitFullRealTimeQuote(ib, 0);
    const [quote] = await pending;

    expect(Date.now() - startedAt).toBeLessThan(1_000); // did not wait for the ceiling
    expect(quote).toMatchObject({
      expiry: "20260925",
      strike: 100,
      right: "P",
      bid: 1.1,
      ask: 1.2,
      last: 1.15,
      bidSize: 40,
      askSize: 25,
      volume: 88,
      openInterest: 1520,
      impliedVolatility: 0.6123,
      delta: -0.31,
      gamma: 0.041,
      vega: 0.09,
      theta: -0.05,
      modelOptionPrice: 1.14,
      underlyingPrice: 101.25,
      receivedAnyTick: true,
      sawRealTimeTicks: true,
      sawDelayedTicks: false,
      errorCode: null,
    });
  });

  it("requests generic tick 101 for open interest and subscribes each contract as an option with the right side", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100, call105], { ceilingMs: 20 });
    await pending;
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    const [, putContract, putTicks, putSnapshot] = ib.reqMktData.mock.calls[0]!;
    const [, callContract] = ib.reqMktData.mock.calls[1]!;
    expect(putTicks).toBe("101");
    expect(putSnapshot).toBe(false);
    expect(putContract).toMatchObject({ symbol: "TEST", lastTradeDateOrContractMonth: "20260925", strike: 100, right: "P" });
    expect(callContract).toMatchObject({ strike: 105, right: "C" });
  });

  it("reads open interest from tick 27 for a call and tick 28 for a put, ignoring the other right's always-zero tick in either arrival order", async () => {
    // Confirmed live: IBKR sends BOTH ticks for every contract; the one for the other right is 0.
    for (const arrivalOrder of [[27, 28], [28, 27]] as const) {
      const ib = new FakeIb();
      const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [call105, put100], { ceilingMs: 60 });
      const [callReqId, putReqId] = [ib.reqIdForContract(0), ib.reqIdForContract(1)];
      for (const tickType of arrivalOrder) {
        ib.emit(EventName.tickSize, callReqId, tickType, tickType === 27 ? 152 : 0); // call: 27 real, 28 zero
        ib.emit(EventName.tickSize, putReqId, tickType, tickType === 28 ? 64 : 0); // put: 28 real, 27 zero
      }
      const [call, put] = await pending;
      expect(call!.openInterest).toBe(152);
      expect(put!.openInterest).toBe(64);
    }
  });

  it("accepts the delayed tick types and flags the data as delayed, not real-time", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 1_000 });
    const reqId = ib.reqIdForContract(0);
    ib.emit(EventName.tickPrice, reqId, 66, 1.1, {});
    ib.emit(EventName.tickPrice, reqId, 67, 1.2, {});
    ib.emit(EventName.tickSize, reqId, 69, 40);
    ib.emit(EventName.tickSize, reqId, 70, 25);
    ib.emit(EventName.tickSize, reqId, 74, 88);
    ib.emit(EventName.tickSize, reqId, 28, 1520);
    ib.emit(EventName.tickOptionComputation, reqId, 83, 0, 0.6, -0.3, 1.1, 0, 0.04, 0.09, -0.05, 101);
    const [quote] = await pending;
    expect(quote).toMatchObject({ bid: 1.1, ask: 1.2, bidSize: 40, askSize: 25, volume: 88, openInterest: 1520, delta: -0.3, sawDelayedTicks: true });
    // Open interest (28) arrives the same under either feed, so it must not make delayed data look real-time.
    expect(quote!.sawRealTimeTicks).toBe(false);
  });

  it("does not let open interest alone mark a feed as real-time", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 30 });
    ib.emit(EventName.tickSize, ib.reqIdForContract(0), 28, 1520);
    const [quote] = await pending;
    expect(quote).toMatchObject({ openInterest: 1520, receivedAnyTick: true, sawRealTimeTicks: false, sawDelayedTicks: false });
  });

  it("never reuses a request id across concurrent batches on the same socket", async () => {
    const ib = new FakeIb();
    await Promise.all([
      captureOptionQuoteBatch(asIb(ib), "AAA", [put100, call105], { ceilingMs: 30 }),
      captureOptionQuoteBatch(asIb(ib), "BBB", [put100, call105], { ceilingMs: 30 }),
    ]);
    const reqIds = ib.reqMktData.mock.calls.map((call) => call[0] as number);
    expect(reqIds).toHaveLength(4);
    expect(new Set(reqIds).size).toBe(4);
  });

  it("normalizes IBKR's 'no data' sentinels to null instead of storing them as numbers", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 50 });
    const reqId = ib.reqIdForContract(0);
    ib.emit(EventName.tickPrice, reqId, 1, -1, {}); // no bid
    ib.emit(EventName.tickPrice, reqId, 2, 1.2, {});
    ib.emit(EventName.tickSize, reqId, 0, -1);
    // args after the tick type: attrib, IV, delta, optPrice, pvDividend, gamma, vega, theta, undPrice
    ib.emit(EventName.tickOptionComputation, reqId, 13, 0, -1, -2, -1, 0, -2, -2, Number.MAX_VALUE, -1);
    const [quote] = await pending;
    expect(quote).toMatchObject({
      bid: null,
      ask: 1.2,
      bidSize: null,
      impliedVolatility: null,
      delta: null,
      gamma: null,
      vega: null,
      theta: null,
      modelOptionPrice: null,
      underlyingPrice: null,
      receivedAnyTick: true,
    });
  });

  it("keeps a legitimately negative theta and a zero gamma (only impossible values are rejected)", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 40 });
    ib.emit(EventName.tickOptionComputation, ib.reqIdForContract(0), 13, 0, 0.5, -0.4, 2.5, 0, 0, 0.02, -1.75, 100);
    const [quote] = await pending;
    expect(quote).toMatchObject({ gamma: 0, vega: 0.02, theta: -1.75, modelOptionPrice: 2.5, delta: -0.4 });
  });

  it("returns a contract that never receives a tick with receivedAnyTick false, after the ceiling", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100, call105], { ceilingMs: 60 });
    emitFullRealTimeQuote(ib, 0); // only the first contract gets data
    const [answered, silent] = await pending;
    expect(answered!.receivedAnyTick).toBe(true);
    expect(silent).toMatchObject({ receivedAnyTick: false, bid: null, delta: null, openInterest: null, errorCode: null });
  });

  it("treats an IBKR error for a contract as settled, records the code, and ignores delayed-data notices", async () => {
    const ib = new FakeIb();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 5_000 });
    const reqId = ib.reqIdForContract(0);
    ib.emit(EventName.error, new Error("using delayed data"), 10167, reqId); // informational — must not settle or mark an error
    const startedAt = Date.now();
    ib.emit(EventName.error, new Error("No security definition has been found"), 200, reqId);
    const [quote] = await pending;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(quote).toMatchObject({ errorCode: 200, receivedAnyTick: false });
    warn.mockRestore();
  });

  it("cancels every subscription and removes every listener it added, even when resolving at the ceiling", async () => {
    const ib = new FakeIb();
    await captureOptionQuoteBatch(asIb(ib), "TEST", [put100, call105], { ceilingMs: 30 });
    expect(ib.cancelMktData).toHaveBeenCalledTimes(2);
    for (const eventName of [EventName.tickPrice, EventName.tickSize, EventName.tickOptionComputation, EventName.error]) {
      expect(ib.listenerCount(eventName)).toBe(0);
    }
  });

  it("ignores ticks for request ids it does not own", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 40 });
    ib.emit(EventName.tickPrice, 999_999, 1, 5, {});
    const [quote] = await pending;
    expect(quote!.receivedAnyTick).toBe(false);
  });

  it("returns an empty list without subscribing for an empty batch", async () => {
    const ib = new FakeIb();
    expect(await captureOptionQuoteBatch(asIb(ib), "TEST", [])).toEqual([]);
    expect(ib.reqMktData).not.toHaveBeenCalled();
  });

  it("lets the caller override when a contract counts as settled", async () => {
    const ib = new FakeIb();
    const pending = captureOptionQuoteBatch(asIb(ib), "TEST", [put100], { ceilingMs: 5_000, isSettled: (quote) => quote.bid !== null });
    const startedAt = Date.now();
    ib.emit(EventName.tickPrice, ib.reqIdForContract(0), 1, 0.5, {});
    const [quote] = await pending;
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(quote!.bid).toBe(0.5);
  });
});
