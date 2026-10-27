import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LadderLookResult } from "./ladderLook.js";
import type { PlannedLadderSale } from "./ladderLookBook.js";
import type { LadderSaleOutcome } from "./ladderOrders.js";

// One CC + Put Ladder round, everything outside its own logic mocked: the looks' inputs and results per ticker, the book's
// counts and committed capital, the sending. The round's own work is checked: which tickers are looked at, the caps (the
// ticker's and the book's, moved on as the round sends), and the once-a-day notices.

const harness = vi.hoisted(() => ({
  lookInputs: new Map<string, unknown>(),
  looks: new Map<string, unknown>(),
  sent: [] as { symbol: string; strikes: number[] }[],
  outcomeFor: (_sale: { strike: number }): Partial<{ outcome: string; orderId: string | null; blockedOnLiveCheck: boolean }> => ({ outcome: "confirmed", orderId: "order", blockedOnLiveCheck: false }),
  bookCounts: { workingOrders: 0, ordersToday: 0, openPositions: 0 },
  tickerCounts: { workingOrders: 0, ordersToday: 0, openPositions: 0 },
  committed: 0,
  tickerNotices: [] as string[],
  bookNotices: [] as string[],
}));

vi.mock("../db/connection.js", () => ({ db: () => ({}) }));
vi.mock("../lib/commissionEstimate.js", async (original) => ({ ...(await original<object>()), loadCommissionEstimator: async () => ({ perContractDollars: () => 0.65 }), loadStockCommissionEstimator: async () => ({ perShareDollars: () => 0.005 }) }));
vi.mock("../lib/accountContext.js", () => ({ accountContextFromTotalCash: async () => ({ freeCash: 400_000 }) }));
vi.mock("../lib/tickerFreeze.js", () => ({ frozenSymbolSet: async () => new Set(["FRZN"]) }));
vi.mock("./book.js", () => ({ loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }), loadLastFilledPlutoActionAtBySymbol: async () => new Map() }));
vi.mock("./executor.js", () => ({ executePlutoOrder: vi.fn(), watchPlutoOrder: vi.fn() }));
vi.mock("./ladderBandPlanLoader.js", () => ({ defaultLadderBandPlannerDependencies: { loadClock: async (todayIso: string) => ({ todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }) } }));
vi.mock("./ladderCycleMemory.js", () => ({ saveLadderCycleMemory: vi.fn(async () => {}) }));
vi.mock("./ladderLookLoader.js", () => ({ loadLadderLookInput: async (ticker: { symbol: string }) => harness.lookInputs.get(ticker.symbol) }));
vi.mock("./ladderLook.js", () => ({ runLadderLook: (input: { symbol: string }) => harness.looks.get(input.symbol) }));
vi.mock("./ledger.js", () => ({ recordPlutoAction: vi.fn(), recordPlutoEvent: vi.fn(async () => {}) }));
vi.mock("./tickerSettingsStore.js", async (original) => ({
  ...(await original<object>()),
  loadEnabledPlutoTickerSettings: async () => ["AAA", "BBB", "FRZN"].map((symbol) => ({ tickerId: `t-${symbol}`, symbol, allocationPct: null })),
}));
vi.mock("../lib/orderLimits.js", async (original) => ({ ...(await original<object>()), loadCommittedCapitalOnSymbols: async () => harness.committed }));
vi.mock("./ladderNotices.js", () => ({
  noticeLadderTicker: async (symbol: string, reason: string) => (harness.tickerNotices.push(`${reason}:${symbol}`), true),
  noticeLadderBook: async (reason: string) => (harness.bookNotices.push(reason), true),
}));
vi.mock("./ladderOrders.js", async (original) => ({
  ...(await original<object>()),
  loadLadderBookOrderCounts: async () => ({ ...harness.bookCounts }),
  loadLadderTickerOrderCounts: async () => ({ ...harness.tickerCounts }),
  sendLadderSales: async (input: { symbol: string; sales: PlannedLadderSale[] }): Promise<LadderSaleOutcome[]> => {
    harness.sent.push({ symbol: input.symbol, strikes: input.sales.map((sale) => sale.strike) });
    return input.sales.map((sale) => ({ sale, actionId: "a", outcome: "confirmed", detail: "", orderId: "order", limitPrice: sale.optionPrice, blockedOnLiveCheck: false, ...harness.outcomeFor(sale) }) as LadderSaleOutcome);
  },
}));

const { runLadderRound } = await import("./ladderRound.js");

const settings = { capitalBudgetPct: 50, ladderTickerCooldownMinutes: 0, maxQuoteAgeMinutes: 10, telegramVerbosity: "actions", ladderMaxWorkingOrdersPerTicker: 10, ladderMaxOrdersPerTickerPerDay: 30, ladderMaxOpenPositionsPerTicker: 30, ladderMaxOpenPositions: 120, ladderMaxOrdersPerDay: 100 };
const now = new Date("2026-10-21T15:00:00Z");

const put = (strike: number, contracts = 1): PlannedLadderSale => ({ strategyKey: "cash_secured_put", step: "ladder_put", expiry: "2026-11-20", strike, right: "P", contracts, optionPrice: 0.8, sharesBought: 0, stockPrice: 50, candidate: {} as never, eligibleCount: 1, chosenBecause: "test", scores: {} });
const lookInput = (symbol: string) => ({ symbol, baseline: { minAbsDelta: 0.05, maxAbsDelta: 0.3 }, forwardAnchors: new Map(), stockPrice: 50 });
const look = (planned: PlannedLadderSale[], overrides: Partial<LadderLookResult> = {}): LadderLookResult => ({ stoppedBecause: null, memory: { startedOn: null, accountValueAtStart: 1_000_000, shock: null }, planned, notes: [], cannotTradeBecause: null, ...overrides });

function round() {
  return runLadderRound({ passId: "p1", settings: settings as never, api: {} as never, marketWatch: { burst: async () => [] } as never, trackWatch: () => {}, now, todayIso: "2026-10-21", totalCashValue: 500_000, netLiquidationValue: 1_000_000, cancelByMs: null, symbols: [] });
}

beforeEach(() => {
  harness.lookInputs.clear();
  harness.looks.clear();
  harness.sent.length = 0;
  harness.tickerNotices.length = 0;
  harness.bookNotices.length = 0;
  harness.bookCounts = { workingOrders: 0, ordersToday: 0, openPositions: 0 };
  harness.tickerCounts = { workingOrders: 0, ordersToday: 0, openPositions: 0 };
  harness.committed = 0;
  harness.outcomeFor = () => ({});
  for (const symbol of ["AAA", "BBB"]) harness.lookInputs.set(symbol, lookInput(symbol));
});

describe("runLadderRound", () => {
  it("looks at every enabled ticker but a frozen one, and sends what each look plans", async () => {
    harness.looks.set("AAA", look([put(45), put(44)]));
    harness.looks.set("BBB", look([put(30)]));
    const summary = await round();
    expect(summary.looked).toEqual(["AAA", "BBB"]);
    expect(summary.notes).toContain("FRZN: frozen (a split is pending), not traded");
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [45, 44] }, { symbol: "BBB", strikes: [30] }]);
    expect(summary.planned).toBe(3);
  });

  it("moves the book's counts on as it sends: an order sent on one ticker counts against the next ticker's room (A3)", async () => {
    harness.bookCounts = { workingOrders: 0, ordersToday: 99, openPositions: 0 };
    harness.looks.set("AAA", look([put(45), put(44)]));
    harness.looks.set("BBB", look([put(30)]));
    const summary = await round();
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [45] }, { symbol: "BBB", strikes: [] }]);
    expect(summary.notes).toEqual(expect.arrayContaining(["AAA: 1 sale(s) wait for a later look (99 of the book's 100 ladder orders a day are sent)", "BBB: 1 sale(s) wait for a later look (100 of the book's 100 ladder orders a day are sent)"]));
    // Once a day per book-wide limit, however many tickers it holds.
    expect(harness.bookNotices).toEqual(["book_orders_per_day"]);
  });

  it("counts open positions plus working orders across the book (A2): a confirmed order is one more working", async () => {
    harness.bookCounts = { workingOrders: 10, ordersToday: 0, openPositions: 109 };
    harness.looks.set("AAA", look([put(45)]));
    harness.looks.set("BBB", look([put(30)]));
    await round();
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [45] }, { symbol: "BBB", strikes: [] }]);
    expect(harness.bookNotices).toEqual(["book_open_positions"]);
  });

  it("holds sales that would take the book's committed capital past Pluto's budget (A1), counting what the round confirmed", async () => {
    // Cap 50% × $1,000,000 = $500,000; $480,000 committed. AAA's $45 Put ×4 adds (45 − 0.80) × 400 = $17,680 → $497,680;
    // BBB's $30 Put ×1 would add $2,920 → $500,600: it waits.
    harness.committed = 480_000;
    harness.looks.set("AAA", look([put(45, 4)]));
    harness.looks.set("BBB", look([put(30, 1)]));
    const summary = await round();
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [45] }, { symbol: "BBB", strikes: [] }]);
    expect(summary.notes).toContain("BBB: 1 sale(s) wait for a later look (the ladder's tickers would commit more than Pluto's capital budget of $500,000 together ($497,680 committed))");
    expect(harness.bookNotices).toEqual(["book_committed_capital"]);
  });

  it("an order refused before it was built does not count against the book: the next ticker still sends", async () => {
    harness.bookCounts = { workingOrders: 0, ordersToday: 99, openPositions: 0 };
    harness.outcomeFor = (sale) => (sale.strike === 45 ? { outcome: "blocked", orderId: null, blockedOnLiveCheck: true } : {});
    harness.looks.set("AAA", look([put(45)]));
    harness.looks.set("BBB", look([put(30)]));
    await round();
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [45] }, { symbol: "BBB", strikes: [30] }]);
    expect(harness.tickerNotices).toEqual(["blocked_on_live_check:AAA"]);
  });

  it("notices a ticker held by its own caps, a ticker that can't trade, a missing shock and the split guard, once each", async () => {
    harness.tickerCounts = { workingOrders: 10, ordersToday: 0, openPositions: 0 };
    harness.looks.set("AAA", look([put(45)], { cannotTradeBecause: null }));
    harness.looks.set("BBB", look([], { cannotTradeBecause: "stale_band_quotes" }));
    await round();
    expect(harness.sent).toEqual([{ symbol: "AAA", strikes: [] }]);
    expect(harness.tickerNotices).toEqual(["held_by_ticker_cap:AAA", "stale_band_quotes:BBB"]);
    expect(harness.bookNotices).toEqual([]);

    harness.tickerNotices.length = 0;
    harness.lookInputs.set("AAA", { unavailable: "AAA: no shock (no override, and no recommended one without daily closes)", noShock: true });
    harness.lookInputs.set("BBB", { unavailable: "BBB: no live stock price", noShock: false });
    expect((await round()).notes).toEqual(expect.arrayContaining(["AAA: no shock (no override, and no recommended one without daily closes)", "BBB: no live stock price"]));
    expect(harness.tickerNotices).toEqual(["no_shock:AAA"]);

    harness.tickerNotices.length = 0;
    harness.lookInputs.set("AAA", lookInput("AAA"));
    harness.looks.set("AAA", look([], { stoppedBecause: "AAA trades at 25.10 against a previous close of 50.00", memory: null }));
    await round();
    expect(harness.tickerNotices).toEqual(["split_guard:AAA"]);
  });
});
