import { describe, expect, it } from "vitest";
import { EventName } from "@stoqey/ib";
import { measuredMarketDataLineCeiling, millisecondsUntilProbeWindow, probeMarketDataLineCeiling, probeTickerSymbols } from "./probeMarketDataLineCeiling.js";

/** A Gateway that grants `allocation` lines, rejects the listed symbols as unknown, and frees a line on cancel. */
function fakeGateway(allocation: number, unknownSymbols: string[] = []) {
  let errorListener: ((error: Error, code: number, requestId: number) => void) | null = null;
  const held = new Set<number>();
  const cancelled: number[] = [];
  const ib = {
    on: (event: string, listener: (error: Error, code: number, requestId: number) => void) => {
      if (event === EventName.error) errorListener = listener;
      return ib;
    },
    removeListener: () => ib,
    reqMktData: (requestId: number, contract: { symbol?: string }) => {
      if (unknownSymbols.includes(contract.symbol!)) errorListener?.(new Error("No security definition has been found for the request"), 200, requestId);
      else if (held.size >= allocation) errorListener?.(new Error("Max number of tickers has been reached"), 101, requestId);
      else held.add(requestId);
    },
    cancelMktData: (requestId: number) => {
      held.delete(requestId);
      cancelled.push(requestId);
    },
  };
  return { ib: ib as never, held, cancelled };
}

const noWait = async () => {};

describe("probeMarketDataLineCeiling", () => {
  it("holds exactly the allocation, stops at IBKR's first refusals and cancels everything", async () => {
    const gateway = fakeGateway(100);
    const result = await probeMarketDataLineCeiling(gateway.ib, { wait: noWait });
    expect(result).toEqual({ requested: 110, linesHeldByProbe: 100, hitTheLimit: true, limitRefusals: 10, otherFailures: [] });
    expect(gateway.held.size).toBe(0);
    expect(gateway.cancelled).toHaveLength(110);
  });

  it("moves past a symbol IBKR does not know, which holds no line", async () => {
    const gateway = fakeGateway(25, ["XLF"]);
    const result = await probeMarketDataLineCeiling(gateway.ib, { wait: noWait });
    expect(result.linesHeldByProbe).toBe(25);
    expect(result.otherFailures).toEqual(["XLF 200: No security definition has been found for the request"]);
  });

  it("says so when every symbol fit without reaching the limit", async () => {
    const result = await probeMarketDataLineCeiling(fakeGateway(1_000).ib, { wait: noWait });
    expect(result).toMatchObject({ requested: probeTickerSymbols.length, linesHeldByProbe: probeTickerSymbols.length, hitTheLimit: false });
  });
});

describe("millisecondsUntilProbeWindow", () => {
  const at = (iso: string) => Date.parse(iso);
  it("waits past the health check at :x0:30 and starts at once inside x1:30 to x8:00", () => {
    expect(millisecondsUntilProbeWindow(at("2026-11-23T23:30:30Z"))).toBe(60_000);
    expect(millisecondsUntilProbeWindow(at("2026-11-23T23:31:30Z"))).toBe(0);
    expect(millisecondsUntilProbeWindow(at("2026-11-23T23:38:00Z"))).toBe(0);
    expect(millisecondsUntilProbeWindow(at("2026-11-23T23:38:01Z"))).toBe(209_000);
  });
});

describe("measuredMarketDataLineCeiling", () => {
  const ledger = [
    { holder: "marketDataPool", lines: 20, priority: false },
    { holder: "snapshot:x", lines: 1, priority: false },
  ];
  it("adds the app's lines to the probe's when the ledger did not change", () => {
    expect(measuredMarketDataLineCeiling({ linesHeldByProbe: 100, hitTheLimit: true }, ledger, [...ledger].reverse())).toBe(121);
  });
  it("gives nothing when the ledger changed or IBKR never refused", () => {
    expect(measuredMarketDataLineCeiling({ linesHeldByProbe: 100, hitTheLimit: true }, ledger, ledger.slice(0, 1))).toBeNull();
    expect(measuredMarketDataLineCeiling({ linesHeldByProbe: 258, hitTheLimit: false }, [], [])).toBeNull();
  });
});
