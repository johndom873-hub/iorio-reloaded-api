import { EventEmitter } from "node:events";
import type { IBApi } from "@stoqey/ib";
import { EventName } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { openCaptureQuoteWindow, percentileOfSorted, type OptionContractRequest } from "./captureOptionQuoteBatch.js";

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

describe("openCaptureQuoteWindow (rolling window)", () => {
  const call110: OptionContractRequest = { expiry: "20260925", strike: 110, right: "C" };

  it("keeps at most `concurrency` lines in flight and hands a freed line to the next queued contract the moment one settles", async () => {
    const ib = new FakeIb();
    const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 2, timeoutMs: 5_000 });
    const pending = window.capture("TEST", [put100, call105, call110]);
    expect(ib.reqMktData).toHaveBeenCalledTimes(2);
    expect(window.inFlightCount()).toBe(2);
    emitFullRealTimeQuote(ib, 0);
    expect(ib.cancelMktData).toHaveBeenCalledWith(ib.reqIdForContract(0));
    expect(ib.reqMktData).toHaveBeenCalledTimes(3); // the third contract took the freed line
    expect(window.inFlightCount()).toBe(2);
    emitFullRealTimeQuote(ib, 1, 27);
    emitFullRealTimeQuote(ib, 2, 27);
    const quotes = await pending;
    expect(quotes.map((quote) => quote.strike)).toEqual([100, 105, 110]);
    expect(quotes.every((quote) => quote.openInterest === 1520)).toBe(true);
    window.close();
  });

  it("resolves each ticker's capture on its own once its last contract settles, with other tickers still in flight", async () => {
    const ib = new FakeIb();
    const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 3, timeoutMs: 5_000 });
    const first = window.capture("AAA", [put100]);
    const second = window.capture("BBB", [call105, call110]);
    expect(ib.reqMktData).toHaveBeenCalledTimes(3);
    emitFullRealTimeQuote(ib, 1, 27);
    let secondDone = false;
    void second.then(() => (secondDone = true));
    emitFullRealTimeQuote(ib, 0);
    expect((await first).length).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondDone).toBe(false);
    emitFullRealTimeQuote(ib, 2, 27);
    expect((await second).map((quote) => quote.strike)).toEqual([105, 110]);
    window.close();
  });

  it("settles a silent contract after its own timeout and an errored contract immediately, freeing the line either way", async () => {
    const ib = new FakeIb();
    const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 1, timeoutMs: 30 });
    const pending = window.capture("TEST", [put100, call105]);
    ib.emit(EventName.error, new Error("no security definition"), 200, ib.reqIdForContract(0));
    expect(ib.reqMktData).toHaveBeenCalledTimes(2); // error freed the line at once
    const quotes = await pending; // the second contract times out
    expect(quotes[0]).toMatchObject({ errorCode: 200, receivedAnyTick: false });
    expect(quotes[1]).toMatchObject({ errorCode: null, receivedAnyTick: false });
    expect(ib.cancelMktData).toHaveBeenCalledTimes(2);
    window.close();
  });

  it("close() cancels in-flight lines, resolves open captures with what they have, and detaches every listener", async () => {
    const ib = new FakeIb();
    const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 1, timeoutMs: 5_000 });
    const pending = window.capture("TEST", [put100, call105]);
    window.close();
    const quotes = await pending;
    expect(quotes.length).toBe(1);
    expect(ib.cancelMktData).toHaveBeenCalledTimes(1);
    expect(ib.listenerCount(EventName.tickPrice)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
    await expect(window.capture("TEST", [put100])).rejects.toThrow("closed");
  });

  it("resolves an empty contract list without subscribing", async () => {
    const ib = new FakeIb();
    const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 1 });
    expect(await window.capture("TEST", [])).toEqual([]);
    expect(ib.reqMktData).not.toHaveBeenCalled();
    window.close();
  });

  it("measures lines in use and how long each contract held its line, per interval and for the whole run", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const ib = new FakeIb();
      const window = openCaptureQuoteWindow(asIb(ib), { concurrency: 2, timeoutMs: 8_000 });
      const pending = window.capture("TEST", [put100, call105]);
      const [first, second] = [ib.reqIdForContract(0), ib.reqIdForContract(1)];
      await vi.advanceTimersByTimeAsync(500);
      for (const reqId of [first, second]) {
        ib.emit(EventName.tickPrice, reqId, 1, 1.1, {});
        ib.emit(EventName.tickPrice, reqId, 2, 1.2, {});
      }
      await vi.advanceTimersByTimeAsync(500);
      for (const reqId of [first, second]) ib.emit(EventName.tickOptionComputation, reqId, 13, 0, 0.6, -0.3, 1.1, 0, 0.04, 0.09, -0.05, 101);
      await vi.advanceTimersByTimeAsync(3_000);
      ib.emit(EventName.tickSize, first, 28, 1520); // open interest arrives last; the second contract never gets it
      await vi.advanceTimersByTimeAsync(4_000); // the second contract's 8 s timeout
      await pending;
      const expected = {
        intervalMs: 8_000,
        minInFlight: 0,
        maxInFlight: 2,
        lineBusyMs: 12_000,
        timedOutLineMs: 8_000,
        settled: 1,
        timedOut: 1,
        errored: 0,
        holdMsP50: 4_000,
        holdMsP90: 8_000,
        holdMsMax: 8_000,
        lastField: { price: 0, delta: 0, openInterest: 1 },
        missingOnTimeout: { price: 0, delta: 0, openInterest: 1 },
        // After the first tick (500 ms): prices at once, delta 500 ms later, OI 3.5 s later (first contract only).
        afterFirstReplyMs: { price: { p50: 0, p90: 0 }, delta: { p50: 500, p90: 500 }, openInterest: { p50: 3_500, p90: 3_500 } },
        // 2 lines for 4 s then 1 for 4 s; answered from 500 ms; 2 subscribes + 2 cancels over 8 s.
        lineUsage: { periodMs: 8_000, averageSubscribed: 1.5, averageAnswered: 1.375, messagesPerSecond: 0.5, released: 2, releasedUnanswered: 0, firstReplyMsP50: 500, firstReplyMsP90: 500, holdMsP50: 4_000, holdMsP90: 8_000 },
      };
      expect(window.drainSettleStats()).toEqual(expected);
      expect(window.drainSettleStats()).toMatchObject({ settled: 0, timedOut: 0, lineBusyMs: 0, holdMsP50: null, minInFlight: 0, maxInFlight: 0 });
      expect(window.wholeRunSettleStats()).toEqual(expected);
      window.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("percentileOfSorted", () => {
  it("returns the nearest-rank percentile, or null for no values", () => {
    expect(percentileOfSorted([], 50)).toBeNull();
    expect(percentileOfSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentileOfSorted([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentileOfSorted([7], 90)).toBe(7);
  });
});
