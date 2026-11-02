import { describe, expect, it, vi } from "vitest";

vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: vi.fn() }));
vi.mock("./positionExposure.js", () => ({ computeCashLockedInCsps: vi.fn() }));

const { settledCashForTrading } = await import("./accountContext.js");

describe("settledCashForTrading", () => {
  it("reads IBKR's settled cash when it is reported, on either account", () => {
    expect(settledCashForTrading({ settledCash: 40_000, totalCashValue: 60_000 }, "live")).toEqual({ settledCash: 40_000, totalCashStandsIn: false });
    expect(settledCashForTrading({ settledCash: 40_000, totalCashValue: 60_000 }, "paper")).toEqual({ settledCash: 40_000, totalCashStandsIn: false });
  });

  it("on the paper account, a margin account that reports none, uses the total cash", () => {
    expect(settledCashForTrading({ settledCash: null, totalCashValue: 445_878 }, "paper")).toEqual({ settledCash: 445_878, totalCashStandsIn: true });
  });

  it("on the live account, none reported stays unknown", () => {
    expect(settledCashForTrading({ settledCash: null, totalCashValue: 60_000 }, "live")).toEqual({ settledCash: null, totalCashStandsIn: false });
  });

  it("with no total cash either, stays unknown on the paper account", () => {
    expect(settledCashForTrading({ settledCash: null, totalCashValue: null }, "paper")).toEqual({ settledCash: null, totalCashStandsIn: false });
  });
});
