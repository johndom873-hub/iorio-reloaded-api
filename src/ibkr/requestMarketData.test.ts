import { afterEach, describe, expect, it, vi } from "vitest";
import { isDelayedDataFallbackNotice, logMarketDataEntitlementNotice } from "./requestMarketData.js";

describe("logMarketDataEntitlementNotice", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs a not-entitled notice once per source, contract and code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(logMarketDataEntitlementNotice("marketDataPool", "ENTL 20261106 50C", 10167, "Displaying delayed market data")).toBe(true);
    expect(logMarketDataEntitlementNotice("marketDataPool", "ENTL 20261106 50C", 10167, "Displaying delayed market data")).toBe(false);
    expect(logMarketDataEntitlementNotice("marketDataPool", "ENTL 20261106 50C", 10089, "Requested market data requires additional subscription")).toBe(true);
    expect(logMarketDataEntitlementNotice("marketDataPool", "ENTL 20261106 55C", 10167, "Displaying delayed market data")).toBe(true);
    expect(logMarketDataEntitlementNotice("fetchLivePrices", "ENTL 20261106 50C", 10167, "Displaying delayed market data")).toBe(true);

    expect(warn).toHaveBeenCalledTimes(4);
    expect(warn).toHaveBeenNthCalledWith(1, "marketDataPool: not entitled to live data for ENTL 20261106 50C (code 10167): Displaying delayed market data");
  });

  it("covers exactly the three delayed-data codes", () => {
    expect([10089, 10091, 10167, 10090, 354, 10197].map(isDelayedDataFallbackNotice)).toEqual([true, true, true, false, false, false]);
  });
});
