import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrderFill } from "./orderFills.js";

// Audit (G1, 2026-10-07): the shared fill-wait rule used by the trading-events catch-all and Genosuke's follow-up.
vi.mock("../db/connection.js", () => ({ db: {} }));

const { describeOrderFillLine, fillsAreComplete, shouldWaitForFills, fillBearingOrderStatuses } = await import("./orderFills.js");

const fiveMinutesMs = 5 * 60_000;
const statusChangedAt = new Date("2026-10-07T14:00:00Z");
const at = (offsetMs: number) => statusChangedAt.getTime() + offsetMs;

const buyBack: OrderFill = { side: "buy", quantity: 1, price: 0.5, optionType: "put", strikePrice: 50, expiryDate: "2026-10-16" };
const sellNew: OrderFill = { side: "sell", quantity: 1, price: 1.2, optionType: "put", strikePrice: 48, expiryDate: "2026-10-23" };
const rollLegs = [{ quantity: 1 }, { quantity: 1 }];

describe("fillsAreComplete", () => {
  it("a roll filled with only its buy-back recorded is incomplete; with both legs it is complete", () => {
    expect(fillsAreComplete("filled", rollLegs, [buyBack])).toBe(false);
    expect(fillsAreComplete("filled", rollLegs, [buyBack, sellNew])).toBe(true);
  });

  it("a covered-call buy-write counts shares and contracts in their own units (100 shares + 1 call)", () => {
    const legs = [{ quantity: 100 }, { quantity: 1 }];
    const stockFill: OrderFill = { side: "buy", quantity: 100, price: 50, optionType: null, strikePrice: null, expiryDate: null };
    const callFill: OrderFill = { side: "sell", quantity: 1, price: 1.25, optionType: "call", strikePrice: 55, expiryDate: "2026-10-16" };
    expect(fillsAreComplete("filled", legs, [stockFill])).toBe(false);
    expect(fillsAreComplete("filled", legs, [callFill])).toBe(false);
    expect(fillsAreComplete("filled", legs, [stockFill, callFill])).toBe(true);
  });

  it("partial fills of one leg add up across executions", () => {
    expect(fillsAreComplete("filled", [{ quantity: 3 }], [{ ...sellNew, quantity: 1 }, { ...sellNew, quantity: 1 }])).toBe(false);
    expect(fillsAreComplete("filled", [{ quantity: 3 }], [{ ...sellNew, quantity: 1 }, { ...sellNew, quantity: 2 }])).toBe(true);
  });

  it("needs at least one fill for a partial or a cancelled-after-partial status", () => {
    expect(fillsAreComplete("partially_filled", rollLegs, [])).toBe(false);
    expect(fillsAreComplete("partially_filled", rollLegs, [buyBack])).toBe(true);
    expect(fillsAreComplete("cancelled_partially_filled", rollLegs, [])).toBe(false);
  });

  it("reads string quantities (jsonb/numeric) as numbers", () => {
    expect(fillsAreComplete("filled", [{ quantity: "2" as unknown as number }], [{ ...sellNew, quantity: 2 }])).toBe(true);
  });
});

describe("shouldWaitForFills", () => {
  it("waits while the fills are incomplete and the 5 minutes are not over, then stops waiting at exactly 5 minutes", () => {
    expect(shouldWaitForFills("filled", rollLegs, [buyBack], statusChangedAt, at(0))).toBe(true);
    expect(shouldWaitForFills("filled", rollLegs, [buyBack], statusChangedAt, at(fiveMinutesMs - 1))).toBe(true);
    expect(shouldWaitForFills("filled", rollLegs, [buyBack], statusChangedAt, at(fiveMinutesMs))).toBe(false);
  });

  it("never waits once every fill is recorded", () => {
    expect(shouldWaitForFills("filled", rollLegs, [buyBack, sellNew], statusChangedAt, at(0))).toBe(false);
  });

  it("a status stamped slightly in this clock's future (DB vs dyno clock skew) still waits a bounded time", () => {
    // updated_at is the database's now(); the pass compares it with the dyno's Date.now(). A dyno clock behind the DB
    // gives a negative age, which must still be bounded by the same 5 minutes rather than wait forever.
    expect(shouldWaitForFills("filled", rollLegs, [buyBack], statusChangedAt, at(-1_000))).toBe(true);
    expect(shouldWaitForFills("filled", rollLegs, [buyBack], statusChangedAt, at(fiveMinutesMs + 1))).toBe(false);
  });

  it("only the three fill-bearing statuses load fills", () => {
    expect(fillBearingOrderStatuses).toEqual(["partially_filled", "filled", "cancelled_partially_filled"]);
  });
});

describe("describeOrderFillLine", () => {
  // The contract wording counts days to expiry from today's Eastern date: pin it.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-07T15:00:00Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("describes an option fill and a stock fill", () => {
    expect(describeOrderFillLine(buyBack)).toBe("• Buy $50 Put · 16 Oct (9DTE) · 1× @ 0.50");
    expect(describeOrderFillLine({ side: "sell", quantity: 100, price: 52.1, optionType: null, strikePrice: null, expiryDate: null })).toBe("• Sell 100 shares @ 52.10");
  });

  it("a fill on an option leg with a missing expiry still reads", () => {
    expect(describeOrderFillLine({ ...buyBack, expiryDate: null })).toBe("• Buy $50 Put · 1× @ 0.50");
  });
});
