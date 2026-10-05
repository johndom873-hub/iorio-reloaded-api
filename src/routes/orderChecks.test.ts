import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real orderChecksRouter on a small express app. Everything that reaches a database or IBKR is mocked: the limit evaluator, the
// ticker lookup, the what-if commission, the commission estimator and the settings loader.
const evaluateOrderLimitsMock = vi.fn();
vi.mock("../lib/orderLimits.js", () => ({ evaluateOrderLimits: (...args: unknown[]) => evaluateOrderLimitsMock(...args) }));

const loadTickerBySymbolMock = vi.fn();
vi.mock("../lib/signalsChainStore.js", () => ({ loadTickerBySymbol: (...args: unknown[]) => loadTickerBySymbolMock(...args) }));

const fetchWhatIfCommissionRangeMock = vi.fn();
vi.mock("../ibkr/ibkrWhatIfCommission.js", () => ({ fetchWhatIfCommissionRange: (...args: unknown[]) => fetchWhatIfCommissionRangeMock(...args) }));

const loadCommissionEstimatorMock = vi.fn();
vi.mock("../lib/commissionEstimate.js", () => ({ loadCommissionEstimator: (...args: unknown[]) => loadCommissionEstimatorMock(...args) }));

const loadTradingSettingsMock = vi.fn();
vi.mock("../lib/tradingSettingsStore.js", () => ({ loadTradingSettings: (...args: unknown[]) => loadTradingSettingsMock(...args) }));

const { orderChecksRouter } = await import("./orderChecks.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as unknown as { session: { userId?: string } }).session = request.header("x-test-user-id") ? { userId: "user-1" } : {};
    next();
  });
  app.use("/order-checks", orderChecksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const knownTicker = { tickerId: "ticker-1", symbol: "AAA", companyName: "AAA Co", sector: "Technology" };
const estimator = { perContractDollars: vi.fn((side: string, contracts: number) => (side === "sell" ? 0.65 : 0.7) + contracts * 0) };

beforeEach(() => {
  evaluateOrderLimitsMock.mockReset().mockResolvedValue({ blocked: false, reasons: [] });
  loadTickerBySymbolMock.mockReset().mockImplementation(async (symbol: string) => (symbol.trim().toUpperCase() === "AAA" ? knownTicker : null));
  fetchWhatIfCommissionRangeMock.mockReset().mockResolvedValue({ minDollars: 1, maxDollars: 2 });
  loadCommissionEstimatorMock.mockReset().mockResolvedValue(estimator);
  loadTradingSettingsMock.mockReset().mockResolvedValue({ commissionWarnSharePctOfPremium: 5 });
  estimator.perContractDollars.mockClear();
});

async function call(method: "GET" | "POST", path: string, body?: unknown, options: { authenticated?: boolean } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(options.authenticated === false ? {} : { "x-test-user-id": "user-1" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

const limitsQuery = (overrides: Record<string, string | undefined> = {}) => {
  const parameters = { symbol: "AAA", strategyKey: "cash_secured_put", quantity: "2", strike: "90", ...overrides };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) if (value !== undefined) search.set(key, value);
  return `/order-checks/limits?${search.toString()}`;
};

describe("GET /order-checks/limits: input validation", () => {
  async function expectBadRequest(path: string, message: string) {
    const response = await call("GET", path);
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: message });
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
  }

  it("requires a symbol", async () => {
    await expectBadRequest(limitsQuery({ symbol: undefined }), "symbol is required.");
    await expectBadRequest(limitsQuery({ symbol: "   " }), "symbol is required.");
    await expectBadRequest("/order-checks/limits?symbol=AAA&symbol=BBB&strategyKey=cash_secured_put&quantity=1&strike=90", "symbol is required.");
  });

  it("requires strategyKey to be covered_call or cash_secured_put", async () => {
    const message = "strategyKey must be covered_call or cash_secured_put.";
    await expectBadRequest(limitsQuery({ strategyKey: undefined }), message);
    await expectBadRequest(limitsQuery({ strategyKey: "iron_condor" }), message);
    await expectBadRequest(limitsQuery({ strategyKey: "hedge" }), message);
    await expectBadRequest(limitsQuery({ strategyKey: "COVERED_CALL" }), message);
  });

  it("requires a positive whole-number quantity", async () => {
    const message = "quantity must be a positive whole number of contracts.";
    for (const quantity of [undefined, "0", "-1", "abc", "", "Infinity", "NaN", "1.5", "0.5", "2.0000001"]) await expectBadRequest(limitsQuery({ quantity }), message);
  });

  it("requires a positive finite strike", async () => {
    const message = "strike must be a positive number.";
    for (const strike of [undefined, "0", "-5", "x", "", "Infinity"]) await expectBadRequest(limitsQuery({ strike }), message);
    await expectBadRequest("/order-checks/limits?symbol=AAA&strategyKey=cash_secured_put&quantity=1&strike=1&strike=2", message);
  });

  it("answers 400 'Unknown symbol.' for a symbol the platform does not have", async () => {
    await expectBadRequest(limitsQuery({ symbol: "ZZZ" }), "Unknown symbol.");
    expect(loadTickerBySymbolMock).toHaveBeenCalledWith("ZZZ");
  });

  it("requires a positive spotPrice when one is given", async () => {
    const message = "spotPrice must be a positive number.";
    for (const spotPrice of ["abc", "0", "-3", "", "Infinity"]) await expectBadRequest(limitsQuery({ spotPrice }), message);
  });

  it("requires a positive rollFromStrike when one is given", async () => {
    const message = "rollFromStrike must be a positive number.";
    for (const rollFromStrike of ["abc", "0", "-3", ""]) await expectBadRequest(limitsQuery({ rollFromStrike }), message);
  });

  it("is refused without a session", async () => {
    const response = await call("GET", limitsQuery(), undefined, { authenticated: false });
    expect(response.status).toBe(401);
    expect(evaluateOrderLimitsMock).not.toHaveBeenCalled();
  });
});

describe("GET /order-checks/limits: a valid call", () => {
  it("returns the shared result shape of evaluateOrderLimits untouched", async () => {
    const result = {
      blocked: true,
      reasons: ["This order is 12.0% of portfolio value, above the 10% max position size."],
      details: { orderNotional: 120_000, totalPortfolioValue: 1_000_000, positionSharePct: 0.12, concentrationAfterPct: 0.12, cashReserveAfterPct: 0.2, inFlightNotional: 0, limits: { maxPositionPctOfPortfolio: 10, maxConcentrationPerTickerPct: 20, minCashReservePct: 5 } },
    };
    evaluateOrderLimitsMock.mockResolvedValue(result);
    const response = await call("GET", limitsQuery({ quantity: "10", strike: "120" }));
    expect(response.status).toBe(200);
    expect(response.json).toEqual(result);
  });

  it("calls the evaluator with parsed numbers, the canonical symbol and ticker id, and no spot or roll strike when none is given", async () => {
    await call("GET", limitsQuery({ symbol: " aaa ", quantity: "3", strike: "92.5" }));
    expect(evaluateOrderLimitsMock).toHaveBeenCalledTimes(1);
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).toEqual({ strategyKey: "cash_secured_put", symbol: "AAA", tickerId: "ticker-1", quantity: 3, strike: 92.5, spotPrice: undefined, rollFromStrike: undefined });
  });

  it("passes spotPrice and rollFromStrike through as numbers", async () => {
    await call("GET", limitsQuery({ strategyKey: "covered_call", spotPrice: "101.5", rollFromStrike: "90" }));
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).toEqual({ strategyKey: "covered_call", symbol: "AAA", tickerId: "ticker-1", quantity: 2, strike: 90, spotPrice: 101.5, rollFromStrike: 90 });
  });

  it("does not carry an excludeOrderRequestId: a setup form's check is not an existing order", async () => {
    await call("GET", limitsQuery());
    expect(evaluateOrderLimitsMock.mock.calls[0]![0]).not.toHaveProperty("excludeOrderRequestId");
  });

  it("a failure of the evaluator is a 500, never an empty pass", async () => {
    evaluateOrderLimitsMock.mockRejectedValue(new Error("boom"));
    const response = await call("GET", limitsQuery());
    expect(response.status).toBe(500);
  });
});

const optionLeg = { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 2, strike: 90, expiry: "20261120", right: "P" };
const stockLeg = { role: "stock", action: "BUY", symbol: "AAA", quantity: 100, unitPrice: 95 };

describe("POST /order-checks/commission-preview: input validation", () => {
  async function expectBadRequest(body: unknown, message: string) {
    const response = await call("POST", "/order-checks/commission-preview", body);
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: message });
    expect(fetchWhatIfCommissionRangeMock).not.toHaveBeenCalled();
  }

  it("needs between one and four legs", async () => {
    const message = "legs must be a list of 1 to 4 legs.";
    await expectBadRequest({}, message);
    await expectBadRequest({ legs: [] }, message);
    await expectBadRequest({ legs: "x" }, message);
    await expectBadRequest({ legs: [optionLeg, optionLeg, optionLeg, optionLeg, optionLeg] }, message);
  });

  it("accepts exactly four legs", async () => {
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg, optionLeg, optionLeg, optionLeg] });
    expect(response.status).toBe(200);
  });

  it("needs a role of stock or option on every leg", async () => {
    await expectBadRequest({ legs: [{ ...optionLeg, role: "future" }] }, "Each leg needs role stock or option.");
    await expectBadRequest({ legs: [null] }, "Each leg needs role stock or option.");
  });

  it("needs an action of BUY or SELL", async () => {
    await expectBadRequest({ legs: [{ ...optionLeg, action: "HOLD" }] }, "Each leg needs action BUY or SELL.");
    await expectBadRequest({ legs: [{ ...optionLeg, action: "sell" }] }, "Each leg needs action BUY or SELL.");
  });

  it("needs a non-blank symbol", async () => {
    await expectBadRequest({ legs: [{ ...optionLeg, symbol: "  " }] }, "Each leg needs a symbol.");
    await expectBadRequest({ legs: [{ ...optionLeg, symbol: 5 }] }, "Each leg needs a symbol.");
  });

  it("needs a positive whole quantity", async () => {
    for (const quantity of [0, -1, 1.5, "2", null]) await expectBadRequest({ legs: [{ ...optionLeg, quantity }] }, "Each leg needs a positive whole quantity.");
  });

  it("needs a positive numeric unitPrice", async () => {
    for (const unitPrice of [0, -1, "1", null]) await expectBadRequest({ legs: [{ ...optionLeg, unitPrice }] }, "Each leg needs a positive unitPrice.");
  });

  it("needs a positive strike and a right of C or P on an option leg", async () => {
    for (const strike of [undefined, 0, -5, "90"]) await expectBadRequest({ legs: [{ ...optionLeg, strike }] }, "Each option leg needs a positive strike.");
    for (const right of [undefined, "X", "p", "Put"]) await expectBadRequest({ legs: [{ ...optionLeg, right }] }, "Each option leg needs right C or P.");
  });

  it("refuses an expiry that is not YYYYMMDD, or missing", async () => {
    await expectBadRequest({ legs: [{ ...optionLeg, expiry: "2026-11-20" }] }, 'AAA option leg has expiry "2026-11-20", expected YYYYMMDD');
    await expectBadRequest({ legs: [{ ...optionLeg, expiry: undefined }] }, 'AAA option leg has expiry "undefined", expected YYYYMMDD');
    await expectBadRequest({ legs: [{ ...optionLeg, expiry: "202611" }] }, 'AAA option leg has expiry "202611", expected YYYYMMDD');
  });

  it("refuses legs on different symbols, comparing them case-insensitively", async () => {
    await expectBadRequest({ legs: [optionLeg, { ...stockLeg, symbol: "BBB" }] }, "All legs must be on the same symbol.");
    const sameSymbolDifferentCase = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg, { ...stockLeg, symbol: " aaa " }] });
    expect(sameSymbolDifferentCase.status).toBe(200);
  });

  it("answers 400 'Unknown symbol.' for a symbol the platform does not have", async () => {
    await expectBadRequest({ legs: [{ ...optionLeg, symbol: "ZZZ" }] }, "Unknown symbol.");
  });

  it("does not need a strike, expiry or right on a stock leg", async () => {
    const response = await call("POST", "/order-checks/commission-preview", { legs: [stockLeg] });
    expect(response.status).toBe(200);
  });

  it("is refused without a session", async () => {
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] }, { authenticated: false });
    expect(response.status).toBe(401);
    expect(fetchWhatIfCommissionRangeMock).not.toHaveBeenCalled();
  });
});

describe("POST /order-checks/commission-preview: the preview", () => {
  it("uses IBKR's what-if range when it answers, with the maximum driving the figure", async () => {
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      commissionDollars: 2,
      commissionMinDollars: 1,
      source: "ibkr_what_if",
      estimateReason: null,
      estimateExcludesStockLeg: false,
      netPremiumDollars: 400,
      commissionSharePctOfPremium: 0.5,
      warnThresholdPct: 5,
      warn: false,
      netCreditAfterCommissionDollars: 398,
    });
    expect(estimator.perContractDollars).not.toHaveBeenCalled();
  });

  it("sends the what-if the normalised legs: trimmed, upper-cased symbols and only the option fields that belong to an option", async () => {
    await call("POST", "/order-checks/commission-preview", { legs: [{ ...stockLeg, symbol: " aaa ", strike: 5, right: "C" }, { ...optionLeg, symbol: "aaa", extra: "ignored" }] });
    expect(fetchWhatIfCommissionRangeMock).toHaveBeenCalledTimes(1);
    expect(fetchWhatIfCommissionRangeMock.mock.calls[0]![0]).toEqual([
      { role: "stock", action: "BUY", symbol: "AAA", quantity: 100, unitPrice: 95 },
      { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 2, strike: 90, expiry: "20261120", right: "P" },
    ]);
  });

  it("falls back to the estimate, with IBKR's reason, when the what-if throws", async () => {
    fetchWhatIfCommissionRangeMock.mockRejectedValue(new Error("IBKR what-if timed out"));
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] });
    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      commissionDollars: 1.3,
      commissionMinDollars: null,
      source: "estimate",
      estimateReason: "IBKR what-if timed out",
      estimateExcludesStockLeg: false,
      netPremiumDollars: 400,
      commissionSharePctOfPremium: 0.325,
      warnThresholdPct: 5,
      warn: false,
      netCreditAfterCommissionDollars: 398.7,
    });
    expect(estimator.perContractDollars).toHaveBeenCalledWith("sell", 2);
  });

  it("falls back the same way when the what-if rejects with something that is not an Error", async () => {
    fetchWhatIfCommissionRangeMock.mockRejectedValue("gateway offline");
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] });
    expect(response.json).toMatchObject({ source: "estimate", estimateReason: "gateway offline" });
  });

  it("an estimate for a buy-write says it leaves out the stock leg's commission", async () => {
    fetchWhatIfCommissionRangeMock.mockRejectedValue(new Error("offline"));
    const callLeg = { ...optionLeg, right: "C", strike: 100, quantity: 1 };
    const response = await call("POST", "/order-checks/commission-preview", { legs: [stockLeg, callLeg] });
    expect(response.json).toMatchObject({ source: "estimate", estimateExcludesStockLeg: true, commissionDollars: 0.65, netPremiumDollars: 200 });
  });

  it("warns when the commission is above the configured share of the premium, using the threshold from trading settings", async () => {
    loadTradingSettingsMock.mockResolvedValue({ commissionWarnSharePctOfPremium: 0.4 });
    const response = await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] }); // 2 / 400 = 0.5%
    expect(response.json).toMatchObject({ warn: true, warnThresholdPct: 0.4, commissionSharePctOfPremium: 0.5 });
    loadTradingSettingsMock.mockResolvedValue({ commissionWarnSharePctOfPremium: 0.5 });
    expect((await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] })).json.warn).toBe(false); // exactly at the threshold does not warn
  });

  it("always warns for a net debit, whatever the threshold", async () => {
    loadTradingSettingsMock.mockResolvedValue({ commissionWarnSharePctOfPremium: 100 });
    const response = await call("POST", "/order-checks/commission-preview", { legs: [{ ...optionLeg, action: "BUY" }] });
    expect(response.json).toMatchObject({ warn: true, netPremiumDollars: -400 });
  });

  it("answers 500 rather than a made-up preview when the trading settings cannot be read", async () => {
    loadTradingSettingsMock.mockRejectedValue(new Error("No trading_settings row found."));
    expect((await call("POST", "/order-checks/commission-preview", { legs: [optionLeg] })).status).toBe(500);
  });
});
