import { beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { plutoLadderSettingsFixture, plutoVolFarmerV2SettingsFixture } from "./plutoSettingsFixture.js";
import type { VolFarmerV2Memory } from "./volFarmerV2LiveBook.js";

// One Vol Farmer v2 round, everything outside its own work mocked: the tickers, the market, the book's counts, the memory
// store and the executor. Checked: which tickers it looks at, a flat ticker's opening order (recorded under v2, sent with
// its shares, its leg kept as pending), adoption, an order a cap holds or SPY's stress stops undone, and an order still
// working counted as planned until it settles; each ticker's last round saved for the screen, with its figures.

const harness = vi.hoisted(() => ({
  memory: new Map<string, unknown>(),
  saves: [] as { tickerId: string; adopted: boolean }[],
  lastRounds: new Map<string, { notes: string[]; figures: unknown }>(),
  outcomes: new Map<string, unknown>(),
  positions: [] as unknown[],
  breakEven: null as number | null,
  quotes: [] as unknown[],
  bookCounts: { workingOrders: 0, ordersToday: 0, openPositions: 0 },
  committed: 0,
  actions: [] as Record<string, unknown>[],
  executed: [] as Record<string, unknown>[],
  events: [] as { type: string; detail: Record<string, unknown> }[],
}));

vi.mock("../db/connection.js", () => ({ db: () => ({}) }));
vi.mock("../lib/commissionEstimate.js", async (original) => ({ ...(await original<object>()), loadCommissionEstimator: async () => ({ perContractDollars: () => 0.65 }), loadStockCommissionEstimator: async () => ({ perShareDollars: () => 0.005 }) }));
vi.mock("../lib/accountContext.js", () => ({ accountContextFromTotalCash: async () => ({ freeCash: 400_000 }) }));
vi.mock("../lib/tickerFreeze.js", () => ({ frozenSymbolSet: async () => new Set() }));
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: async () => ({ stock: 100 }) }));
vi.mock("../ibkr/fetchOptionChain.js", () => ({ loadStoredOptionChain: async () => ({ expirations: [], strikesByExpiry: new Map(), fetchedAt: null }) }));
vi.mock("../lib/cycleBreakEvenQueries.js", () => ({ fetchOpenCycleSummaryRowsByTickerId: async (ids: string[]) => new Map(ids.map((id) => [id, {}])) }));
vi.mock("../lib/cycleInputRows.js", () => ({ summarizeOpenCycleFromRows: () => ({ breakEvenPerShare: harness.breakEven }) }));
vi.mock("../lib/positionExposure.js", () => ({ computeTickerExposure: async () => 30_000 }));
vi.mock("./book.js", () => ({ loadInFlightNotionals: async () => ({ totalNotional: 0, tickerNotional: 0, managedNotional: 0 }), loadLastFilledPlutoActionAtBySymbol: async () => new Map() }));
vi.mock("./executor.js", () => ({
  executePlutoOrder: vi.fn(async (_api: unknown, _settings: unknown, input: Record<string, unknown>) => (harness.executed.push(input), { outcome: "confirmed", orderId: `order-${harness.executed.length}`, detail: "sent" })),
  watchPlutoOrder: vi.fn(async () => ({})),
}));
vi.mock("./ladderBandPlanLoader.js", () => ({
  defaultLadderBandPlannerDependencies: {
    loadClock: async (todayIso: string) => ({ todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }),
    loadForwardAnchors: async () => new Map(),
    loadPreviousSessionVolume: async () => new Map((harness.quotes as SymbolFileQuote[]).map((quote) => [contractKey(quote), 1_000])),
  },
}));
vi.mock("./ladderBandQuotes.js", () => ({ loadLadderBandQuotes: async () => [] }));
vi.mock("./ladderLook.js", () => ({ latestCycleQuotes: () => ({ quotes: harness.quotes, stale: false }) }));
vi.mock("./ladderLookSnapshot.js", () => ({ loadOpenPositionFigures: async () => harness.positions }));
vi.mock("./ladderOrders.js", () => ({ loadLadderBookOrderCounts: async () => ({ ...harness.bookCounts }), ladderOrdersSentToday: async () => ({ count: 0 }) }));
vi.mock("../lib/orderLimits.js", async (original) => ({ ...(await original<object>()), loadCommittedCapitalOnSymbols: async () => harness.committed }));
vi.mock("./ledger.js", () => ({
  recordPlutoAction: vi.fn(async (input: Record<string, unknown>) => (harness.actions.push(input), `action-${harness.actions.length}`)),
  recordPlutoEvent: vi.fn(async (type: string, detail: Record<string, unknown>) => void harness.events.push({ type, detail })),
}));
vi.mock("./tickerSettingsStore.js", async (original) => ({
  ...(await original<object>()),
  loadEnabledPlutoTickerSettings: async () => [
    { tickerId: "t-VFT", symbol: "VFT", strategy: null, allocationPct: null },
    { tickerId: "t-LAD", symbol: "LAD", strategy: "cc_put_ladder", allocationPct: null },
  ],
}));
vi.mock("./volFarmerV2LookLoader.js", () => ({
  loadVolFarmerV2Memory: async (tickerId: string) => (harness.memory.has(tickerId) ? structuredClone(harness.memory.get(tickerId)) : null),
  saveVolFarmerV2Memory: async (tickerId: string, memory: unknown, adopted: boolean) => {
    harness.memory.set(tickerId, structuredClone(memory));
    harness.saves.push({ tickerId, adopted });
  },
  saveVolFarmerV2LastRound: async (tickerId: string, lastRound: { notes: string[]; figures: unknown }) => {
    harness.lastRounds.set(tickerId, structuredClone({ notes: lastRound.notes, figures: lastRound.figures }));
  },
  loadVolFarmerV2OrderOutcomes: async (actionIds: string[]) => new Map(actionIds.flatMap((id) => (harness.outcomes.has(id) ? [[id, harness.outcomes.get(id)]] : []))),
  loadVolFarmerV2LegStatuses: async () => new Map(),
  loadVolFarmerV2StepImpliedVolatility: async () => null,
}));

const { runVolFarmerV2Round } = await import("./volFarmerV2Round.js");

const settings = { ...plutoLadderSettingsFixture, ...plutoVolFarmerV2SettingsFixture, capitalBudgetPct: 50, maxQuoteAgeMinutes: 10, burstLines: 10, telegramVerbosity: "actions" };

/** Black-Scholes quotes at IV 50%, 2% either side of the mid, the stock at 100, 10 days out. */
function quotesAt(right: "C" | "P"): SymbolFileQuote[] {
  const years = 10 / 365;
  return Array.from({ length: 101 }, (_, index) => 40 + index).map((strike) => {
    const mid = blackScholesPriceOnForward(100 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
    return { expiry: "2026-11-06", strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: null, askSize: null };
  });
}

const marketWatch = { burst: async (_symbol: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[]) => contracts.map((contract) => (harness.quotes as SymbolFileQuote[]).find((quote) => contractKey(quote) === contractKey(contract))!) };

function round(stressed = false) {
  return runVolFarmerV2Round({ passId: "p1", settings: settings as never, api: {} as never, marketWatch: marketWatch as never, trackWatch: () => {}, now: new Date("2026-10-27T15:00:00Z"), todayIso: "2026-10-27", totalCashValue: 500_000, netLiquidationValue: 1_000_000, cancelByMs: null, symbols: [], stressed });
}

beforeEach(() => {
  harness.memory.clear();
  harness.saves.length = 0;
  harness.lastRounds.clear();
  harness.outcomes.clear();
  harness.positions = [];
  harness.breakEven = null;
  harness.quotes = [...quotesAt("C"), ...quotesAt("P")];
  harness.bookCounts = { workingOrders: 0, ordersToday: 0, openPositions: 0 };
  harness.committed = 0;
  harness.actions.length = 0;
  harness.executed.length = 0;
  harness.events.length = 0;
});

describe("runVolFarmerV2Round", () => {
  it("opens a cycle on a flat v2 ticker: one Covered Call with its shares, recorded under v2 and kept as pending; the ladder's ticker is not its", async () => {
    const summary = await round();
    expect(summary.looked).toEqual(["VFT"]);
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "open_covered_call", symbol: "VFT", executionStrategy: "vol_farmer_v2", outcome: "validated" })]);
    // Half the ticker's allocation (50% × 50% × $1,000,000 = $250,000): floor(125,000 ÷ 10,000.50) = 12 lots.
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "ladder_open", strategyKey: "covered_call", buyEveryShare: true, plan: expect.objectContaining({ quantity: 12 }) })]);
    const memory = harness.memory.get("t-VFT") as VolFarmerV2Memory;
    expect(memory.pending).toEqual([expect.objectContaining({ ref: "action:action-1", kind: "covered_call", contracts: 12, startsCycle: true })]);
    expect(memory.state.first).toMatchObject({ shares: 1_200, calls: [{ legId: "action:action-1", shares: 1_200 }] });
    expect(summary.sent).toBe(1);
    // Pot $250,000; committed: the exposure, 30,000; free cash: the budget's $500,000 at most the account's $400,000; LEAPS cap 10% of the pot.
    expect(harness.lastRounds.get("t-VFT")).toEqual({ notes: [expect.stringContaining("VFT Sell $105 Call")], figures: { potDollars: 250_000, committedDollars: 30_000, freeCashDollars: 400_000, leapsCapDollars: 25_000 } });
    expect(harness.lastRounds.has("t-LAD")).toBe(false);
  });

  it("counts an order still working as planned, and opens afresh once it ended unfilled", async () => {
    await round();
    harness.outcomes.set("action-1", { working: true, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0 });
    await round();
    expect(harness.executed).toHaveLength(1);
    harness.outcomes.set("action-1", { working: false, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0 });
    const summary = await round();
    expect(summary.notes).toContain("VFT: the cycle's opening order did not fill: no cycle");
    expect(harness.executed).toHaveLength(2);
    expect((harness.memory.get("t-VFT") as VolFarmerV2Memory).pending.map((order) => order.actionId)).toEqual(["action-2"]);
  });

  it("undoes an order a cap holds, as if never placed", async () => {
    harness.bookCounts = { workingOrders: 0, ordersToday: 100, openPositions: 0 };
    const summary = await round();
    expect(harness.actions).toEqual([]);
    expect(summary.notes.some((text) => text.includes("waits for a later round") && text.includes("of Pluto's 100 orders a day are sent"))).toBe(true);
    const memory = harness.memory.get("t-VFT") as VolFarmerV2Memory;
    expect(memory).toMatchObject({ pending: [], state: { first: null, potDollars: 0 } });
  });

  it("opens nothing while SPY's stress level holds", async () => {
    const summary = await round(true);
    expect(harness.executed).toEqual([]);
    expect(summary.notes.some((text) => text.startsWith("VFT: market stress:"))).toBe(true);
    expect((harness.memory.get("t-VFT") as VolFarmerV2Memory).state.first).toBeNull();
  });

  it("adopts a ticker's holdings at its first look: every share at the cycle's break-even, its Call the first position's", async () => {
    harness.breakEven = 104.5;
    harness.positions = [{ strategyKey: "covered_call", status: "open", legs: [
      { id: "s1", legType: "stock", side: "long", quantity: 200, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 106, entryAt: new Date(), exitPrice: null, exitAt: null },
      { id: "c1", legType: "option", side: "short", quantity: 2, optionType: "call", strikePrice: 110, expiryDate: "2026-11-06", multiplier: 100, entryPrice: 1.5, entryAt: new Date(), exitPrice: null, exitAt: null },
    ] }];
    await round();
    expect(harness.saves).toEqual([{ tickerId: "t-VFT", adopted: true }]);
    const memory = harness.memory.get("t-VFT") as VolFarmerV2Memory;
    expect(memory.state.first).toMatchObject({ shares: 200, costPerShare: 104.5, calls: [{ legId: "c1", shares: 200 }] });
    expect(harness.events.some((event) => String(event.detail.message).startsWith("Vol Farmer v2 adopted VFT's holdings: 200 shares at the cycle's break-even 104.50"))).toBe(true);
    // Its Call is open: nothing to sell, and the Puts wait until the first position needs a new Call.
    expect(harness.executed).toEqual([]);
  });

  it("waits on a ticker that holds only Puts", async () => {
    harness.positions = [{ strategyKey: "cash_secured_put", status: "open", legs: [{ id: "p1", legType: "option", side: "short", quantity: 2, optionType: "put", strikePrice: 90, expiryDate: "2026-10-30", multiplier: 100, entryPrice: 1, entryAt: new Date(), exitPrice: null, exitAt: null }] }];
    const summary = await round();
    expect(summary.notes).toEqual([expect.stringContaining("VFT: holds no shares yet")]);
    expect(harness.memory.has("t-VFT")).toBe(false);
    expect(harness.lastRounds.get("t-VFT")).toEqual({ notes: [expect.stringContaining("holds no shares yet")], figures: null });
  });
});
