import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  borrow: vi.fn(),
  allocateReqId: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("./sharedReadConnection.js", () => ({ sharedReadConnection: { borrow: mocks.borrow, allocateReqId: mocks.allocateReqId } }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connect }));

import { fetchAccountSummary } from "./fetchAccountSummary.js";

class FakeIbApi extends EventEmitter {
  reqAccountSummary = vi.fn();
  cancelAccountSummary = vi.fn();
}

let ib: FakeIbApi;
const summaryValue = (reqId: number, tag: string, value: string) => ib.emit(EventName.accountSummary, reqId, "U21518308", tag, value, "USD");

beforeEach(() => {
  vi.useFakeTimers();
  ib = new FakeIbApi();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.borrow.mockResolvedValue({ ib, release: mocks.release });
  mocks.allocateReqId.mockReturnValue(555);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchAccountSummary on the shared read connection", () => {
  it("requests the five tags for all accounts under an allocated request id and maps them to numbers", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqAccountSummary).toHaveBeenCalledWith(555, "All", "NetLiquidation,BuyingPower,TotalCashValue,GrossPositionValue,ExcessLiquidity");
    summaryValue(555, "NetLiquidation", "100000.5");
    summaryValue(555, "BuyingPower", "400000");
    summaryValue(555, "TotalCashValue", "-2500.25");
    summaryValue(555, "GrossPositionValue", "75000");
    summaryValue(555, "ExcessLiquidity", "30000.75");
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await result).toEqual({ netLiquidationValue: 100000.5, buyingPower: 400000, totalCashValue: -2500.25, grossPositionValue: 75000, excessLiquidity: 30000.75 });
  });

  it("leaves a field null when IBKR never sent it, and ignores non-numeric values and unknown tags", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    summaryValue(555, "NetLiquidation", "100");
    summaryValue(555, "BuyingPower", "n/a");
    summaryValue(555, "AccountType", "7");
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await result).toEqual({ netLiquidationValue: 100, buyingPower: null, totalCashValue: null, grossPositionValue: null, excessLiquidity: null });
  });

  it("treats an empty or blank value string as no value, never as a zero net liquidation", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    summaryValue(555, "NetLiquidation", "");
    summaryValue(555, "BuyingPower", "   ");
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await result).toMatchObject({ netLiquidationValue: null, buyingPower: null });
  });

  it("reads a zero value as zero, not as missing", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    summaryValue(555, "TotalCashValue", "0");
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await result).toMatchObject({ totalCashValue: 0 });
  });

  it("ignores values and ends of other requests (concurrent callers share the connection)", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    summaryValue(556, "NetLiquidation", "999");
    ib.emit(EventName.accountSummaryEnd, 556);
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    summaryValue(555, "NetLiquidation", "100");
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await result).toMatchObject({ netLiquidationValue: 100 });
  });

  it("cancels the summary, releases the connection and removes its listeners afterwards", async () => {
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.accountSummaryEnd, 555);
    await result;
    expect(ib.cancelAccountSummary).toHaveBeenCalledWith(555);
    expect(mocks.release).toHaveBeenCalledTimes(1);
    expect(ib.listenerCount(EventName.accountSummary)).toBe(0);
    expect(ib.listenerCount(EventName.accountSummaryEnd)).toBe(0);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("fails after 15 s, without falling back to a one-shot connection, and still cancels and releases", async () => {
    const captured = fetchAccountSummary().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(((await captured) as Error).message).toBe("Account summary timeout.");
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(ib.cancelAccountSummary).toHaveBeenCalledWith(555);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it("shares one request between concurrent callers", async () => {
    const first = fetchAccountSummary();
    const second = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqAccountSummary).toHaveBeenCalledTimes(1);
    ib.emit(EventName.accountSummaryEnd, 555);
    expect(await first).toBe(await second);
  });
});

describe("fetchAccountSummary falling back to a one-shot connection", () => {
  it("connects, uses request id 9001, disconnects, and logs why", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    const result = fetchAccountSummary();
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqAccountSummary).toHaveBeenCalledWith(9001, "All", expect.any(String));
    summaryValue(9001, "NetLiquidation", "100");
    ib.emit(EventName.accountSummaryEnd, 9001);
    expect(await result).toMatchObject({ netLiquidationValue: 100 });
    expect(ib.cancelAccountSummary).toHaveBeenCalledWith(9001);
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    expect(console.log).toHaveBeenCalledWith("fetchAccountSummary: shared read connection unavailable (not connected), falling back to a one-shot connection.");
  });

  it("disconnects when the one-shot request times out", async () => {
    mocks.borrow.mockRejectedValue(new Error("not connected"));
    mocks.connect.mockResolvedValue({ ib, disconnect: mocks.disconnect });
    const captured = fetchAccountSummary().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(((await captured) as Error).message).toBe("Account summary timeout.");
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
  });
});
