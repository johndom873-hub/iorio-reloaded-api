import { describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { LadderOrderGateContext } from "../lib/ladderOrderGates.js";
import type { PlannedLadderSale } from "./ladderLookBook.js";
import { admitLadderSales, sendLadderSales, type LadderOrderDependencies } from "./ladderOrders.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T15:00:00Z");
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(todayIso, expiry);
const context: LadderOrderGateContext = { potFraction: 0.25, minAbsDelta: 0.05, maxAbsDelta: 0.3, forwardAnchor: null, riskFreeRate: 0.04, todayIso, closeMinutesEt: 960 };
const settings = { ladderMaxWorkingOrdersPerTicker: 5, ladderMaxOrdersPerTickerPerDay: 30, ladderMaxOpenPositionsPerTicker: 5 };

const sale = (strike: number, overrides: Partial<PlannedLadderSale> = {}): PlannedLadderSale => ({
  strategyKey: "cash_secured_put",
  expiry,
  strike,
  right: "P",
  contracts: 2,
  optionPrice: 0.8,
  sharesBought: 0,
  stockPrice: 50,
  candidate: { expiry, strike, right: "P", bid: 0.78, ask: 0.82, fillPrice: 0.8, dte: 31, delta: -0.2, impliedVolatility: 0.5, timeValue: 0.8, premiumYield: 0.2, volumeCap: 50, volatilityEdge: null, edgeYield: null },
  eligibleCount: 6,
  chosenBecause: "baseline: the ladder put with the highest premium yield",
  scores: { rank: 1 },
  ...overrides,
});

/** A live quote at 50% IV with the stock at $50 (the spot forward: no 10:00 forward in this context). */
function liveQuote(strike: number, right: "C" | "P") {
  const mid = blackScholesPriceOnForward(50 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
  return { expiry, strike, right, bid: Math.round((mid - 0.02) * 100) / 100, ask: Math.round((mid + 0.02) * 100) / 100, quotedAt: "2026-10-20T15:00:00.000Z" };
}

describe("admitLadderSales", () => {
  it("sends up to the tightest cap and says which one holds the rest", () => {
    const planned = [sale(45), sale(44), sale(43), sale(42)];
    expect(admitLadderSales(planned, { workingOrders: 0, ordersToday: 0, openPositions: 0 }, settings).send).toHaveLength(4);
    // 2 working: 3 more may work; 1 open position plus the 2 working leave room for 2 positions.
    const capped = admitLadderSales(planned, { workingOrders: 2, ordersToday: 10, openPositions: 1 }, settings);
    expect(capped.send.map((entry) => entry.strike)).toEqual([45, 44]);
    expect(capped.waiting.map((entry) => entry.reason)).toEqual(Array(2).fill("the ticker has 1 open position(s) and 2 working order(s), at most 5 positions"));
    expect(admitLadderSales(planned, { workingOrders: 0, ordersToday: 30, openPositions: 0 }, settings).waiting[0]!.reason).toBe("30 of the ticker's 30 orders a day are sent");
  });
});

describe("sendLadderSales", () => {
  function dependencies(quotes: Record<number, ReturnType<typeof liveQuote> | { bid: null; ask: null }>): LadderOrderDependencies & { executed: unknown[]; recorded: unknown[]; watched: unknown[] } {
    const executed: unknown[] = [];
    const recorded: unknown[] = [];
    const watched: unknown[] = [];
    return {
      executed,
      recorded,
      watched,
      burst: async (_symbol, contracts) => contracts.map((contract) => ({ ...contract, ...quotes[contract.strike]! })),
      recordAction: async (input) => (recorded.push(input), `action-${recorded.length}`),
      recordEvent: async () => {},
      execute: vi.fn(async (input) => (executed.push(input), { outcome: "confirmed" as const, orderId: `order-${executed.length}`, detail: "LADR Sell" })),
      watch: (input) => void watched.push(input),
      now: () => now,
    };
  }

  it("sends a sale whose live quote is inside the ladder's range at the live mid, with the ladder snapshot, and watches it", async () => {
    const quote = liveQuote(45, "P");
    const deps = dependencies({ 45: quote });
    const [outcome] = await sendLadderSales({ passId: "p1", symbol: "LADR", tickerId: "t1", sales: [sale(45)], gateContext: context, forwardAnchors: new Map(), stockPrice: 50, todayIso }, deps);
    expect(outcome).toMatchObject({ actionId: "action-1", outcome: "confirmed" });
    expect(deps.recorded[0]).toMatchObject({ kind: "open_cash_secured_put", outcome: "validated", quantity: 2, limitPrice: Math.round(((quote.bid + quote.ask) / 2) * 100) / 100 });
    expect(deps.executed[0]).toMatchObject({ kind: "ladder_open", strategyKey: "cash_secured_put", buyEveryShare: false, contract: { expiry, strike: 45, right: "P", dte: 31 }, scoresSnapshot: { kind: "ladder", contract: { bid: quote.bid, ask: quote.ask, quoteSource: "live", quotedAt: quote.quotedAt } } });
    expect(deps.watched).toHaveLength(1);
  });

  it("a Covered Call entry buying every share asks the route to buy them all", async () => {
    const deps = dependencies({ 55: liveQuote(55, "C") });
    await sendLadderSales({ passId: "p1", symbol: "LADR", tickerId: "t1", sales: [sale(55, { strategyKey: "covered_call", right: "C", sharesBought: 200 })], gateContext: context, forwardAnchors: new Map(), stockPrice: 50, todayIso }, deps);
    expect(deps.executed[0]).toMatchObject({ kind: "ladder_open", strategyKey: "covered_call", buyEveryShare: true });
  });

  it("records a blocked action and sends nothing when the live quote left the range or is missing", async () => {
    const deps = dependencies({ 50: liveQuote(50, "P"), 44: { bid: null, ask: null } });
    const outcomes = await sendLadderSales({ passId: "p1", symbol: "LADR", tickerId: "t1", sales: [sale(50), sale(44)], gateContext: context, forwardAnchors: new Map(), stockPrice: 50, todayIso }, deps);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["blocked", "blocked"]);
    expect(outcomes[0]!.detail).toMatch(/above the ladder's 0.05–0.3 delta range/);
    expect(outcomes[1]!.detail).toBe("no live two-sided quote");
    expect(deps.executed).toEqual([]);
    expect(deps.recorded.map((entry) => (entry as { outcome: string }).outcome)).toEqual(["blocked", "blocked"]);
  });
});
