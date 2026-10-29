import { beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { plutoLadderSettingsFixture, plutoVolFarmerV2SettingsFixture } from "./plutoSettingsFixture.js";
import type { VolFarmerV2Memory } from "./volFarmerV2LiveBook.js";

// One Vol Farmer v2 round, everything outside its own work mocked: the tickers, the market, the book's counts, the memory
// store and the executor. Checked: which tickers it looks at, a flat ticker's opening order (recorded under v2, sent with
// its shares, its leg kept as pending), adoption, an order a cap holds or SPY's stress stops undone, and an order still
// working counted as planned until it settles; each ticker's last round saved for the screen, with its figures. The
// tickers sharing Pluto's budget: the day's turn, a new cycle held to the free cash, and the LEAPS after every ticker's
// other orders, on the free cash they left. An order sent works (and is in flight) until a test ends it.

const harness = vi.hoisted(() => ({
  enabled: [] as { tickerId: string; symbol: string; strategy: string | null; allocationPct: number | null }[],
  memory: new Map<string, unknown>(),
  saves: [] as { tickerId: string; adopted: boolean }[],
  lastRounds: new Map<string, { notes: string[]; figures: unknown }>(),
  outcomes: new Map<string, unknown>(),
  positions: [] as unknown[],
  positionsByTickerId: new Map<string, unknown[]>(),
  accountFreeCash: 400_000,
  chain: { expirations: [] as string[], strikesByExpiry: new Map<string, number[]>() },
  breakEven: null as number | null,
  quotes: [] as unknown[],
  bookCounts: { workingOrders: 0, ordersToday: 0, openPositions: 0 },
  committed: 0,
  actions: [] as Record<string, unknown>[],
  executed: [] as Record<string, unknown>[],
  events: [] as { type: string; detail: Record<string, unknown> }[],
}));

/** The orders sent and still working, with the notional the in-flight order requests count them at. */
const workingOrders = () => harness.executed.filter((order) => (harness.outcomes.get(order.actionId as string) as { working: boolean } | undefined)?.working === true).map((order) => ({ symbol: order.symbol as string, notional: (order.plan as { notional: number }).notional }));

vi.mock("../db/connection.js", () => ({ db: () => ({}) }));
// Every weekday from the round's day a session: what the premium yields are annualized over.
vi.mock("../lib/liveTradingSessions.js", async () => {
  const { sessionsHeldAmong } = await import("../lib/tradingSessionsHeld.js");
  return {
    loadLiveTradingSessions: async (now: Date) => {
      const saleSessionIso = now.toISOString().slice(0, 10);
      const openDays = Array.from({ length: 800 }, (_, index) => new Date(now.getTime() + index * 86_400_000).toISOString().slice(0, 10)).filter((dateIso) => ![0, 6].includes(new Date(`${dateIso}T12:00:00Z`).getUTCDay()));
      return { saleSessionIso, openDays, sessionsHeldTo: (expiryIso: string) => sessionsHeldAmong(openDays, saleSessionIso, expiryIso) };
    },
  };
});
vi.mock("../lib/commissionEstimate.js", async (original) => ({ ...(await original<object>()), loadCommissionEstimator: async () => ({ perContractDollars: () => 0.65 }), loadStockCommissionEstimator: async () => ({ perShareDollars: () => 0.005 }) }));
vi.mock("../lib/accountContext.js", () => ({ accountContextFromTotalCash: async () => ({ freeCash: harness.accountFreeCash }) }));
vi.mock("../lib/tickerFreeze.js", () => ({ frozenSymbolSet: async () => new Set() }));
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: async () => ({ stock: 100 }) }));
vi.mock("../ibkr/fetchOptionChain.js", () => ({ loadStoredOptionChain: async () => ({ ...harness.chain, fetchedAt: null }) }));
vi.mock("../lib/cycleBreakEvenQueries.js", () => ({ fetchOpenCycleSummaryRowsByTickerId: async (ids: string[]) => new Map(ids.map((id) => [id, {}])) }));
vi.mock("../lib/cycleInputRows.js", () => ({ summarizeOpenCycleFromRows: () => ({ breakEvenPerShare: harness.breakEven }) }));
vi.mock("../lib/positionExposure.js", () => ({ computeTickerExposure: async () => 30_000 }));
vi.mock("./book.js", () => ({
  loadInFlightNotionals: async (symbol: string) => {
    const working = workingOrders();
    const total = working.reduce((sum, order) => sum + order.notional, 0);
    return { totalNotional: total, tickerNotional: working.filter((order) => order.symbol === symbol).reduce((sum, order) => sum + order.notional, 0), managedNotional: total };
  },
  loadInFlightNotionalsBySymbol: async () => {
    const working = workingOrders();
    const tickerNotionalBySymbol = new Map<string, number>();
    for (const order of working) tickerNotionalBySymbol.set(order.symbol, (tickerNotionalBySymbol.get(order.symbol) ?? 0) + order.notional);
    const total = working.reduce((sum, order) => sum + order.notional, 0);
    return { totalNotional: total, managedNotional: total, tickerNotionalBySymbol };
  },
  loadLastFilledPlutoActionAtBySymbol: async () => new Map(),
}));
vi.mock("./executor.js", () => ({
  executePlutoOrder: vi.fn(async (_api: unknown, _settings: unknown, input: Record<string, unknown>) => {
    harness.executed.push(input);
    if (!harness.outcomes.has(input.actionId as string)) harness.outcomes.set(input.actionId as string, { working: true, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0 });
    return { outcome: "confirmed", orderId: `order-${harness.executed.length}`, detail: "sent" };
  }),
  watchPlutoOrder: vi.fn(async () => ({})),
}));
vi.mock("./optionQuoteBandPlanLoader.js", () => ({
  defaultOptionQuoteBandPlannerDependencies: {
    loadClock: async (todayIso: string) => ({ todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }),
    loadForwardAnchors: async () => new Map(),
    loadPreviousSessionVolume: async () => new Map((harness.quotes as SymbolFileQuote[]).map((quote) => [contractKey(quote), 1_000])),
  },
}));
vi.mock("./optionQuoteBandQuotes.js", () => ({ loadOptionQuoteBandQuotes: async () => [] }));
vi.mock("./ladderLook.js", () => ({ latestCycleQuotes: () => ({ quotes: harness.quotes, stale: false }) }));
vi.mock("./ladderLookSnapshot.js", () => ({ loadOpenPositionFigures: async (tickerId: string) => harness.positionsByTickerId.get(tickerId) ?? harness.positions }));
vi.mock("./ladderOrders.js", () => ({ loadLadderBookOrderCounts: async () => ({ ...harness.bookCounts }), ladderOrdersSentToday: async () => ({ count: 0 }) }));
vi.mock("../lib/orderLimits.js", async (original) => ({ ...(await original<object>()), loadCommittedCapitalOnSymbols: async () => harness.committed }));
vi.mock("./ledger.js", () => ({
  recordPlutoAction: vi.fn(async (input: Record<string, unknown>) => (harness.actions.push(input), `action-${harness.actions.length}`)),
  recordPlutoEvent: vi.fn(async (type: string, detail: Record<string, unknown>) => void harness.events.push({ type, detail })),
}));
vi.mock("./tickerSettingsStore.js", async (original) => ({ ...(await original<object>()), loadEnabledPlutoTickerSettings: async () => harness.enabled }));
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

const { runVolFarmerV2Round, volFarmerV2NoCallQuotedReason } = await import("./volFarmerV2Round.js");

const settings = { ...plutoLadderSettingsFixture, ...plutoVolFarmerV2SettingsFixture, capitalBudgetPct: 50, excessAllowancePct: 0, maxQuoteAgeMinutes: 10, burstLines: 10, telegramVerbosity: "actions" };

/** Black-Scholes quotes at IV 50%, 2% either side of the mid, the stock at 100, `days` out (10: the 6 Nov 2026 expiry). */
function quotesAt(right: "C" | "P", expiry = "2026-11-06", days = 10): SymbolFileQuote[] {
  const years = days / 365;
  return Array.from({ length: 101 }, (_, index) => 40 + index).map((strike) => {
    const mid = blackScholesPriceOnForward(100 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
    return { expiry, strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: null, askSize: null };
  });
}

const marketWatch = { burst: async (_symbol: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[]) => contracts.map((contract) => (harness.quotes as SymbolFileQuote[]).find((quote) => contractKey(quote) === contractKey(contract))!) };

function round(stressed = false, todayIso = "2026-10-27") {
  return runVolFarmerV2Round({ passId: "p1", settings: settings as never, api: {} as never, marketWatch: marketWatch as never, trackWatch: () => {}, now: new Date(`${todayIso}T15:00:00Z`), todayIso, totalCashValue: 500_000, netLiquidationValue: 1_000_000, cancelByMs: null, symbols: [], stressed });
}

const v2Ticker = (symbol: string) => ({ tickerId: `t-${symbol}`, symbol, strategy: null, allocationPct: null });

/**
 * A ticker whose LEAPS is due: both positions hold 200 shares, the first's break-even 100 (a Call to sell), the second's
 * 130 (no Call at or above it, and the price of 100 more than half a Step below it); its 17 Dec 2027 LEAPS expiry listed
 * and quoted.
 */
function withLeapsDue(tickerId: string): void {
  const position = (shares: number, costPerShare: number) => ({ shares, costPerShare, premiums: [], calls: [], puts: [] });
  harness.memory.set(tickerId, { state: { potDollars: 250_000, first: position(200, 100), second: position(200, 130), leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 1, firstHalfLeft: [], secondHalfLeft: [], leapsTriggers: [] } }, pending: [] });
  const stockLeg = (id: string) => ({ id, legType: "stock", side: "long", quantity: 200, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 100, entryAt: new Date(), exitPrice: null, exitAt: null });
  harness.positionsByTickerId.set(tickerId, [{ strategyKey: "covered_call", status: "open", legs: [stockLeg(`${tickerId}-s1`), stockLeg(`${tickerId}-s2`)] }]);
  harness.chain = { expirations: ["20271217"], strikesByExpiry: new Map([["20271217", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
  harness.quotes = [...(harness.quotes as SymbolFileQuote[]), ...quotesAt("C", "2027-12-17", 416)];
}

/** What a LEAPS contract costs at the mid of the quote the steps chose it at, its commission included. */
const leapsContractCost = (action: Record<string, unknown>) => {
  const scores = action.candidateScores as { bid: number; ask: number };
  return ((scores.bid + scores.ask) / 2) * 100 + 0.65;
};

beforeEach(() => {
  harness.enabled = [
    { tickerId: "t-VFT", symbol: "VFT", strategy: null, allocationPct: null },
    { tickerId: "t-LAD", symbol: "LAD", strategy: "cc_put_ladder", allocationPct: null },
  ];
  harness.memory.clear();
  harness.saves.length = 0;
  harness.lastRounds.clear();
  harness.outcomes.clear();
  harness.positions = [];
  harness.positionsByTickerId.clear();
  harness.accountFreeCash = 400_000;
  harness.chain = { expirations: [], strikesByExpiry: new Map() };
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
    expect(harness.events.filter((event) => event.type === "holdings_adopted").map((event) => event.detail)).toEqual([{ passId: expect.any(String), symbol: "VFT", strategy: "vol_farmer_v2", shares: 200, breakEvenPerShare: 104.5, callContracts: 2, putContracts: 0 }]);
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

  it("sizes a ticker's pot from its allocation raised by the excess allowance", async () => {
    settings.excessAllowancePct = 20;
    try {
      await round();
      // 50% × (1 + 20%) × 50% × $1,000,000 = $300,000: floor(150,000 ÷ 10,000.50) = 14 lots; the LEAPS cap 10% of the pot.
      expect(harness.executed).toEqual([expect.objectContaining({ kind: "ladder_open", plan: expect.objectContaining({ quantity: 14 }) })]);
      expect(harness.lastRounds.get("t-VFT")!.figures).toMatchObject({ potDollars: 300_000, leapsCapDollars: 30_000 });
    } finally {
      settings.excessAllowancePct = 0;
    }
  });

  it("opens a new cycle with no more lots than the free cash pays for, and says so", async () => {
    harness.accountFreeCash = 50_000;
    await round();
    // Half the pot wants 12 lots of $10,000.50; the free cash pays for floor(50,000 ÷ 10,000.50) = 4.
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "ladder_open", buyEveryShare: true, plan: expect.objectContaining({ quantity: 4 }) })]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringContaining("the free cash ($50,000) pays for 4 of the 12 lots half the pot wants")]);
  });

  it("gives the tickers their turn in the day's order: alphabetical, starting one ticker further each day", async () => {
    harness.enabled = [v2Ticker("AAA"), v2Ticker("BBB")];
    await round(false, "2026-10-27");
    expect(harness.executed.map((order) => order.symbol)).toEqual(["BBB", "AAA"]);
    harness.memory.clear();
    harness.outcomes.clear();
    harness.executed.length = 0;
    await round(false, "2026-10-28");
    expect(harness.executed.map((order) => order.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("buys a LEAPS after every ticker's new cycle, Calls and Puts, though its ticker's turn came first", async () => {
    harness.enabled = [v2Ticker("AAA"), v2Ticker("VFT")];
    withLeapsDue("t-VFT");
    const summary = await round();
    // 27 Oct: VFT's turn first, its first position's Call; then AAA's new cycle; then VFT's LEAPS.
    expect(harness.executed.map((order) => [order.symbol, order.kind, order.buyEveryShare ?? null])).toEqual([["VFT", "ladder_open", false], ["AAA", "ladder_open", true], ["VFT", "leaps_buy", null]]);
    // The free cash left is more than the LEAPS cap, 10% of VFT's $250,000 pot: the cap decides the contracts.
    const leaps = harness.actions.find((action) => action.kind === "buy_leaps")!;
    expect(leaps.quantity).toBe(Math.floor(25_000 / leapsContractCost(leaps)));
    expect(summary).toMatchObject({ looked: ["VFT", "AAA"], planned: 3, sent: 3 });
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringContaining("VFT Sell $105 Call"), expect.stringContaining("VFT Buy $")]);
  });

  it("buys the LEAPS on the free cash the round's other orders left, and says what the free cash cut", async () => {
    harness.enabled = [v2Ticker("AAA"), v2Ticker("VFT")];
    harness.accountFreeCash = 130_000;
    withLeapsDue("t-VFT");
    await round();
    // AAA's new cycle ties up 12 lots × 100 shares × $100 = $120,000 of the account's $130,000: $10,000 is left.
    const leaps = harness.actions.find((action) => action.kind === "buy_leaps");
    expect(leaps).toBeDefined();
    expect((leaps!.candidateScores as { freeCash: number }).freeCash).toBe(10_000);
    const contracts = Math.floor(10_000 / leapsContractCost(leaps!));
    expect(leaps!.quantity).toBe(contracts);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContain(`the free cash ($10,000) held the LEAPS to ${contracts} of the ${Math.floor(25_000 / leapsContractCost(leaps!))} contracts its cap allows`);
  });
});

describe("volFarmerV2NoCallQuotedReason", () => {
  // Wed 28 Oct 2026: the next listed expiry is Fri 30 Oct (2DTE).
  const base = { todayIso: "2026-10-28", expirations: ["20261106", "20261030", "20261028"], strikesByExpiry: new Map([["20261030", [95, 105]], ["20261106", [105]], ["20261028", [105]]]) };
  const bandQuote = (expiry: string, strike: number, right: "C" | "P") => ({ expiry, strike, right, bid: 1, ask: 1.1, stockPrice: 100, errorCode: null, quotedAt: new Date(), cycleNumber: 1 });

  it("names the missing previous-session volume when the ticker was enabled after the capture", () => {
    expect(volFarmerV2NoCallQuotedReason({ ...base, previousSessionVolumeByContract: null, bandQuotes: [] })).toBe(
      "no 30 Oct (2DTE) option is quoted today: no option volume was captured after the previous session's close (the capture covers the tickers enabled then), so none can be sold before the next session",
    );
  });

  it("tells the 20% volume rule, quotes not in yet, and the |delta| band apart", () => {
    const volume = new Map([["2026-10-30|105|C", 4], ["2026-10-30|95|P", 50]]);
    expect(volFarmerV2NoCallQuotedReason({ ...base, previousSessionVolumeByContract: volume, bandQuotes: [] })).toBe("no 30 Oct (2DTE) Call traded enough in the previous session to sell one (the 20% volume rule needs a volume of 5 or more)");
    const traded = new Map([["2026-10-30|105|C", 40]]);
    expect(volFarmerV2NoCallQuotedReason({ ...base, previousSessionVolumeByContract: traded, bandQuotes: [] })).toBe("no 30 Oct (2DTE) option is quoted yet today");
    expect(volFarmerV2NoCallQuotedReason({ ...base, previousSessionVolumeByContract: traded, bandQuotes: [bandQuote("2026-10-30", 105, "C")] })).toBe("the latest quotes have no 30 Oct (2DTE) Call yet");
    expect(volFarmerV2NoCallQuotedReason({ ...base, previousSessionVolumeByContract: traded, bandQuotes: [bandQuote("2026-10-30", 95, "P")] })).toBe("no 30 Oct (2DTE) Call is near v2's Call |delta| range at this price, so none is quoted");
  });

  it("keeps the plain note when the chain lists no expiry after today", () => {
    expect(volFarmerV2NoCallQuotedReason({ ...base, expirations: ["20261028"], previousSessionVolumeByContract: null, bandQuotes: [] })).toBe("no Call expiry listed after today");
  });
});
