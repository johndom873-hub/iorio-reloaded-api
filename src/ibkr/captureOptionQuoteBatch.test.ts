import { EventEmitter } from "node:events";
import type { IBApi } from "@stoqey/ib";
import { EventName } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { openCaptureQuoteWindow, type OptionContractRequest } from "./captureOptionQuoteBatch.js";

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
});
