import { describe, expect, it, vi } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { blackScholesPriceOnForward, yearsBetweenIsoDates } from "../lib/impliedVolatilitySurface.js";
import type { LadderDeltaContext } from "../lib/ladderOrderGates.js";
import type { PlannedLadderSale } from "./ladderLookBook.js";
import { admitLadderSales, ladderLiveRuleFailure, ladderSaleNotional, sendLadderSales, type LadderBookRoom, type LadderOrderDependencies } from "./ladderOrders.js";
import { ladderBaselineFromPlutoSettings } from "./ladderSettings.js";
import { plutoLadderSettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";

const todayIso = "2026-10-20";
const now = new Date("2026-10-20T15:00:00Z");
const expiry = "2026-11-20";
const years = yearsBetweenIsoDates(todayIso, expiry);
const deltaContext: Omit<LadderDeltaContext, "forwardAnchor"> = { minAbsDelta: 0.05, maxAbsDelta: 0.3, riskFreeRate: 0.04, todayIso, closeMinutesEt: 960 };
const settings = { ladderMaxWorkingOrdersPerTicker: 5, ladderMaxOrdersPerTickerPerDay: 30, ladderMaxOpenPositionsPerTicker: 5, ladderMaxOpenPositions: 120, ladderMaxOrdersPerDay: 100 };
// The fixed choices: entries only above a 20% premium yield a year, the Calls on held shares and the ladder's Puts at any.
const baseline = ladderBaselineFromPlutoSettings(plutoLadderSettingsFixture as unknown as PlutoSettings);
const commissions = { option: flatCommissionEstimator, stock: flatStockCommissionEstimator };
const emptyBook: LadderBookRoom = { counts: { workingOrders: 0, ordersToday: 0, openPositions: 0 }, committedCapitalDollars: 0, budgetFraction: 0.5, netLiquidationValue: 1_000_000 };
const noTickerCounts = { workingOrders: 0, ordersToday: 0, openPositions: 0 };

const sale = (strike: number, overrides: Partial<PlannedLadderSale> = {}): PlannedLadderSale => ({
  strategyKey: "cash_secured_put",
  step: "ladder_put",
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
  it("sends up to the tightest of the ticker's caps and says which one holds the rest", () => {
    const planned = [sale(45), sale(44), sale(43), sale(42)];
    expect(admitLadderSales(planned, noTickerCounts, emptyBook, settings).send).toHaveLength(4);
    // 2 working: 3 more may work; 1 open position plus the 2 working leave room for 2 positions.
    const capped = admitLadderSales(planned, { workingOrders: 2, ordersToday: 10, openPositions: 1 }, emptyBook, settings);
    expect(capped.send.map((entry) => entry.strike)).toEqual([45, 44]);
    expect(capped.waiting.map((entry) => [entry.cap, entry.reason])).toEqual(Array(2).fill(["ticker_open_positions", "the ticker has 1 open position(s) and 2 working order(s), at most 5 positions"]));
    expect(admitLadderSales(planned, { workingOrders: 0, ordersToday: 30, openPositions: 0 }, emptyBook, settings).waiting[0]).toMatchObject({ cap: "ticker_orders_per_day", reason: "30 of the ticker's 30 orders a day are sent" });
  });

  it("holds sales at the book's open positions plus working orders (A2) and its orders a day (A3)", () => {
    const planned = [sale(45), sale(44), sale(43)];
    const positions = admitLadderSales(planned, noTickerCounts, { ...emptyBook, counts: { workingOrders: 8, ordersToday: 0, openPositions: 111 } }, settings);
    expect(positions.send.map((entry) => entry.strike)).toEqual([45]);
    expect(positions.waiting[0]).toMatchObject({ cap: "book_open_positions", reason: "the ladder's tickers have 111 open position(s) and 8 working order(s), at most 120 across the book" });
    const orders = admitLadderSales(planned, noTickerCounts, { ...emptyBook, counts: { workingOrders: 0, ordersToday: 98, openPositions: 0 } }, settings);
    expect(orders.send).toHaveLength(2);
    expect(orders.waiting[0]).toMatchObject({ cap: "book_orders_per_day", reason: "98 of the book's 100 ladder orders a day are sent" });
  });

  it("holds a sale that would take the book's committed capital over Pluto's capital budget (A1), and every one after it", () => {
    // NLV $1,000,000 × 50% = $500,000; $480,000 committed. A $45 Put ×1 at 0.80 adds (45 − 0.80) × 100 = $4,420 → $484,420: goes.
    // ×5 adds $22,100 → $502,100: waits.
    const book = { ...emptyBook, committedCapitalDollars: 480_000 };
    expect(admitLadderSales([sale(45, { contracts: 1 })], noTickerCounts, book, settings).send).toHaveLength(1);
    const over = admitLadderSales([sale(45, { contracts: 5 }), sale(44, { contracts: 1 })], noTickerCounts, book, settings);
    expect(over.send).toEqual([]);
    expect(over.waiting.map((entry) => entry.cap)).toEqual(["book_committed_capital", "book_committed_capital"]);
    expect(over.waiting[0]!.reason).toBe("the ladder's tickers would commit more than Pluto's capital budget of $500,000 together ($480,000 committed)");
    // Two that fit one by one: the second is counted on top of the first.
    const both = admitLadderSales([sale(45, { contracts: 2 }), sale(44, { contracts: 2 })], noTickerCounts, book, settings);
    expect(both.send).toHaveLength(2);
    const third = admitLadderSales([sale(45, { contracts: 2 }), sale(44, { contracts: 2 }), sale(43, { contracts: 2 })], noTickerCounts, book, settings);
    expect(third.send).toHaveLength(2);
    expect(third.waiting[0]!.cap).toBe("book_committed_capital");
  });

  it("lets a Call on shares already held go over a full book: it commits nothing", () => {
    const book = { ...emptyBook, committedCapitalDollars: 600_000 };
    expect(admitLadderSales([sale(55, { strategyKey: "covered_call", right: "C", step: "held_calls", sharesBought: 0 })], noTickerCounts, book, settings).send).toHaveLength(1);
  });
});

describe("ladderSaleNotional", () => {
  it("is a Put's strike less its premium, a Covered Call entry's shares less the premium on them", () => {
    expect(ladderSaleNotional(sale(45), 0.8)).toBeCloseTo(8_840, 9);
    expect(ladderSaleNotional(sale(55, { strategyKey: "covered_call", right: "C", sharesBought: 200, stockPrice: 50 }), 1.1)).toBeCloseTo(9_780, 9);
    expect(ladderSaleNotional(sale(55, { strategyKey: "covered_call", right: "C", sharesBought: 0 }), 1.1)).toBe(0);
  });
});

describe("ladderLiveRuleFailure", () => {
  const base = { stockPrice: 50, todayIso, now, closeMinutesEt: 960, baseline, commissions };
  it("re-runs the ladder's quote, spread and expiry rules on the live quote", () => {
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45), bid: 0.78, ask: 0.82 })).toBeNull();
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45), bid: 0.04, ask: 0.06 })).toMatch(/under the ladder's 0.05 minimum/);
    // Spread 0.40 on a 0.80 mid: 50.0% passes at 50%; 0.50 wide does not.
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45), bid: 0.6, ask: 1.0 })).toBeNull();
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45), bid: 0.55, ask: 1.05 })).toBe("the live spread is 62.5% of the mid, above the ladder's 50%");
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45, { expiry: "2027-01-15" }), bid: 0.78, ask: 0.82 })).toBe("87 DTE is outside the ladder's 1–45 days");
  });

  it("holds the entries to the minimum yield on the live mid, not the Calls on held shares or the ladder's Puts", () => {
    // A $45 Put at 0.10 for 31 days: (10 − 0.65) ÷ 4,490 × 365 ÷ 31 ≈ 2.5% a year, under 20%.
    const cheap = { bid: 0.09, ask: 0.11 };
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45, { step: "entry" }), ...cheap })).toMatch(/^the premium yield on the live mid is 2\.\d% a year, not above the 20% minimum$/);
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45, { step: "ladder_put" }), ...cheap })).toBeNull();
    expect(ladderLiveRuleFailure({ ...base, sale: sale(60, { step: "held_calls", right: "C", strategyKey: "covered_call" }), ...cheap })).toBeNull();
    expect(ladderLiveRuleFailure({ ...base, sale: sale(60, { step: "entry", right: "C", strategyKey: "covered_call" }), ...cheap })).toMatch(/not above the 20% minimum/);
    // A $45 Put at 0.80: (80 − 0.65) ÷ 4,420 × 365 ÷ 31 ≈ 21% a year, above it.
    expect(ladderLiveRuleFailure({ ...base, sale: sale(45, { step: "entry" }), bid: 0.78, ask: 0.82 })).toBeNull();
  });
});

describe("sendLadderSales", () => {
  type Quote = { bid: number | null; ask: number | null; quotedAt?: string };
  function dependencies(quotes: Record<number, Quote>): LadderOrderDependencies & { executed: unknown[]; recorded: unknown[]; watched: unknown[] } {
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
  const send = (sales: PlannedLadderSale[], deps: LadderOrderDependencies) => sendLadderSales({ passId: "p1", symbol: "LADR", tickerId: "t1", sales, deltaContext, forwardAnchors: new Map(), stockPrice: 50, todayIso, baseline, commissions }, deps);
  const gateOf = (recorded: unknown, gate: string) => (recorded as { gateResults: { gate: string; ok: boolean; detail: string }[] }).gateResults.find((entry) => entry.gate === gate);

  it("sends a sale whose live quote passes the ladder's rules at the live mid, with the ladder snapshot and its step, and watches it", async () => {
    const quote = liveQuote(45, "P");
    const deps = dependencies({ 45: quote });
    const [outcome] = await send([sale(45)], deps);
    expect(outcome).toMatchObject({ actionId: "action-1", outcome: "confirmed", orderId: "order-1", blockedOnLiveCheck: false });
    expect(deps.recorded[0]).toMatchObject({ kind: "open_cash_secured_put", outcome: "validated", quantity: 2, limitPrice: Math.round(((quote.bid + quote.ask) / 2) * 100) / 100, contract: { strategyKey: "cash_secured_put", strike: 45, saleStep: "ladder_put" } });
    expect(deps.executed[0]).toMatchObject({ kind: "ladder_open", strategyKey: "cash_secured_put", buyEveryShare: false, contract: { expiry, strike: 45, right: "P", dte: 31 }, scoresSnapshot: { kind: "ladder", contract: { bid: quote.bid, ask: quote.ask, quoteSource: "live", quotedAt: quote.quotedAt } } });
    expect(deps.watched).toHaveLength(1);
  });

  it("a Covered Call entry buying every share asks the route to buy them all", async () => {
    const deps = dependencies({ 55: liveQuote(55, "C") });
    await send([sale(55, { strategyKey: "covered_call", right: "C", step: "entry", sharesBought: 200 })], deps);
    expect(deps.executed[0]).toMatchObject({ kind: "ladder_open", strategyKey: "covered_call", buyEveryShare: true });
  });

  it("sends a ladder Put whatever its |delta|: the range is the Calls' and the entry Puts'", async () => {
    // The $50 Put at the money has a |delta| near 0.5, far above the 0.30 top.
    const deps = dependencies({ 50: liveQuote(50, "P") });
    const [outcome] = await send([sale(50)], deps);
    expect(outcome).toMatchObject({ outcome: "confirmed" });
    expect(gateOf(deps.recorded[0], "ladder_delta")).toMatchObject({ ok: true, detail: expect.stringMatching(/the ladder's Puts have no \|delta\| range/) });
  });

  it("holds a Cash-Secured Put entry to the |delta| range: at the money it is blocked, a $45 one goes", async () => {
    const deps = dependencies({ 50: liveQuote(50, "P"), 45: liveQuote(45, "P") });
    const outcomes = await send([sale(50, { step: "entry" }), sale(45, { step: "entry" })], deps);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["blocked", "confirmed"]);
    expect(outcomes[0]!.detail).toMatch(/above the ladder's 0.05–0.3 delta range/);
    expect(gateOf(deps.recorded[1], "ladder_delta")).toMatchObject({ ok: true, detail: expect.stringMatching(/^own \|delta\| 0\.\d+ inside 0.05–0.3$/) });
    expect(deps.recorded[1]).toMatchObject({ contract: { saleStep: "entry" } });
  });

  it("records a blocked action and sends nothing when a Call's live quote left the range or a quote is missing", async () => {
    const deps = dependencies({ 50: liveQuote(50, "C"), 44: { bid: null, ask: null } });
    const outcomes = await send([sale(50, { strategyKey: "covered_call", right: "C", step: "held_calls", sharesBought: 0 }), sale(44)], deps);
    expect(outcomes.map((entry) => entry.outcome)).toEqual(["blocked", "blocked"]);
    expect(outcomes[0]!.detail).toMatch(/above the ladder's 0.05–0.3 delta range/);
    expect(outcomes[1]!.detail).toBe("no live two-sided quote");
    expect(outcomes.every((entry) => entry.blockedOnLiveCheck && entry.orderId === null)).toBe(true);
    expect(deps.executed).toEqual([]);
    expect(deps.recorded.map((entry) => (entry as { outcome: string }).outcome)).toEqual(["blocked", "blocked"]);
  });

  it("blocks a sale whose live quote carries no time (B2) or fails the ladder's rules on it (B1), without re-ranking", async () => {
    const quote = liveQuote(45, "P");
    const { quotedAt: _quotedAt, ...untimed } = quote;
    const deps = dependencies({ 45: untimed, 44: { bid: 0.5, ask: 1.2, quotedAt: quote.quotedAt } });
    const outcomes = await send([sale(45), sale(44)], deps);
    expect(outcomes.map((entry) => [entry.outcome, entry.blockedOnLiveCheck])).toEqual([["blocked", true], ["blocked", true]]);
    expect(gateOf(deps.recorded[0], "quote_time")).toEqual({ gate: "quote_time", ok: false, detail: "the live quote carries no time" });
    expect(gateOf(deps.recorded[1], "ladder_rules")).toMatchObject({ ok: false, detail: "the live spread is 82.4% of the mid, above the ladder's 50%" });
    expect(deps.executed).toEqual([]);
  });

  it("prices the limit at the mid rounded up to the cent, never above the ask", async () => {
    // Any cent at $3.00 and above too: a 3.00–3.04 market's mid stays 3.02, 3.01–3.05's 3.03; 0.41–0.44's 0.425 rounds up to 0.43.
    const deps = dependencies({ 45: { bid: 3.0, ask: 3.04, quotedAt: "2026-10-20T15:00:00.000Z" }, 44: { bid: 3.01, ask: 3.05, quotedAt: "2026-10-20T15:00:00.000Z" }, 43: { bid: 0.41, ask: 0.44, quotedAt: "2026-10-20T15:00:00.000Z" } });
    await send([sale(45), sale(44), sale(43)], deps);
    expect(deps.recorded.map((entry) => (entry as { limitPrice: number }).limitPrice)).toEqual([3.02, 3.03, 0.43]);
  });
});
