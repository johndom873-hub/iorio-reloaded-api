import { beforeEach, describe, expect, it, vi } from "vitest";
import { blackScholesPriceOnForward } from "../lib/impliedVolatilitySurface.js";
import { contractKey } from "../lib/optionContractKey.js";
import type { SymbolFileQuote } from "../backtest/engine/backtestSymbolFile.js";
import { plutoSafetyLimitsSettingsFixture, plutoVolFarmerV4SettingsFixture } from "./plutoSettingsFixture.js";
import type { VolFarmerV4Memory } from "./volFarmerV4LiveBook.js";

// One Vol Farmer v4 round, everything outside its own work mocked: the tickers, the market, the book's counts, the memory
// store and the executor. Checked, on v4 with its Calls on the next expiry and half the pot in shares (the numbers these
// mechanics were first written on, under v2): which tickers it looks at, a flat ticker's opening order (recorded under v4,
// sent with its shares, its leg kept as pending), adoption, an order a cap holds or SPY's stress stops undone, and an order
// still working counted as planned until it settles; each ticker's last round saved for the screen, with its figures. The
// tickers sharing Pluto's budget: the day's turn, a new cycle held to the free cash, and the LEAPS after every ticker's
// other orders, on the free cash they left. On v4's own values (today's expiry, 80% in shares): the share orders, sent
// alone and waited for, a trim's part fill, the settled cash, a Call expiring at today's close, and the buyback in the
// window's last minutes. An order sent works (and is in flight) until a test ends it.

const harness = vi.hoisted(() => ({
  enabled: [] as { tickerId: string; symbol: string; allocationPct: number | null }[],
  memory: new Map<string, unknown>(),
  saves: [] as { tickerId: string; adopted: boolean }[],
  lastRounds: new Map<string, { notes: string[]; figures: unknown }>(),
  outcomes: new Map<string, unknown>(),
  positions: [] as unknown[],
  positionsByTickerId: new Map<string, unknown[]>(),
  accountFreeCash: 400_000,
  /** IBKR's settled cash handed to the round (null: none reported), and what it leaves once the open Puts' cash is out. */
  settledCashValue: 2_000_000 as number | null,
  settledCashIsTotalCash: false,
  settledFreeCash: 2_000_000,
  /** Pluto's own stock quote of every ticker. */
  stockQuote: { bid: 99.98 as number | null, ask: 100.02 as number | null, updatedAtMs: 0 as number | null },
  leftoverStockLeg: null as { legId: string; positionId: string; shares: number } | null,
  chain: { expirations: [] as string[], strikesByExpiry: new Map<string, number[]>() },
  breakEven: null as number | null,
  stepImpliedVolatility: null as number | null,
  quotes: [] as unknown[],
  /** No after-close capture for the previous session: its volumes are unknown. */
  previousSessionVolumeMissing: false,
  /** Strikes whose contracts the previous session's capture lists with no volume. */
  noVolumeStrikes: [] as number[],
  bookCounts: { workingOrders: 0, ordersToday: 0, openPositions: 0 },
  committed: 0,
  actions: [] as Record<string, unknown>[],
  executed: [] as Record<string, unknown>[],
  events: [] as { type: string; detail: Record<string, unknown> }[],
  /** The last stored close before today (the split guard's reference); the live price is 100. */
  previousClose: 99.5 as number | null,
  /** One option contract's commission, as the round's estimator gives it. */
  optionCommission: 0.65,
  notices: [] as { symbol: string; reason: string }[],
}));

/** The orders sent and still working, with the notional the in-flight order requests count them at. */
const workingOrders = () => harness.executed.filter((order) => (harness.outcomes.get(order.actionId as string) as { working: boolean } | undefined)?.working === true).map((order) => ({ symbol: order.symbol as string, notional: (order.plan as { notional: number }).notional }));

// The one read the round makes itself: the position of each Call it buys back.
vi.mock("../db/connection.js", () => ({ db: () => ({ whereIn: (_column: string, ids: string[]) => ({ select: async () => ids.map((id) => ({ id, position_id: `position-of-${id}` })) }) }) }));
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
vi.mock("../lib/commissionEstimate.js", async (original) => ({ ...(await original<object>()), loadCommissionEstimator: async () => ({ perContractDollars: () => harness.optionCommission }), loadStockCommissionEstimator: async () => ({ perShareDollars: () => 0.005 }) }));
// The round hands the account's cash (500,000) and the settled cash in turn.
vi.mock("../lib/accountContext.js", () => ({ accountContextFromTotalCash: async (cash: number | null) => ({ freeCash: cash === 500_000 ? harness.accountFreeCash : harness.settledFreeCash }) }));
vi.mock("../lib/tickerFreeze.js", () => ({ frozenSymbolSet: async () => new Set() }));
vi.mock("../ibkr/pricePool.js", () => ({ fetchPricesPoolFirst: async () => ({ stock: 100 }) }));
vi.mock("../lib/tickerCalendarQueries.js", () => ({ loadPreviousClose: async () => (harness.previousClose === null ? null : { close: harness.previousClose, dateIso: "2026-10-19" }) }));
vi.mock("./plutoTickerNotices.js", () => ({ noticePlutoTicker: async (symbol: string, reason: string) => (harness.notices.push({ symbol, reason }), true) }));
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
    if (!harness.outcomes.has(input.actionId as string)) harness.outcomes.set(input.actionId as string, { working: true, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0, sharesSold: 0 });
    return { outcome: "confirmed", orderId: `order-${harness.executed.length}`, detail: "sent" };
  }),
  watchPlutoOrder: vi.fn(async () => ({})),
}));
vi.mock("./optionQuoteBandPlanLoader.js", () => ({
  defaultOptionQuoteBandPlannerDependencies: {
    loadClock: async (todayIso: string) => ({ todayIso, closeMinutesEt: 960, riskFreeRate: 0.04 }),
    loadForwardAnchors: async () => new Map(),
    loadPreviousSessionVolume: async () => (harness.previousSessionVolumeMissing ? null : new Map((harness.quotes as SymbolFileQuote[]).map((quote) => [contractKey(quote), harness.noVolumeStrikes.includes(quote.strike) ? 0 : 1_000]))),
  },
}));
vi.mock("./optionQuoteBandQuotes.js", () => ({ loadOptionQuoteBandQuotes: async () => [], loadFinishedOptionQuoteBandCycle: async () => ({ cycleNumber: 1, startedAt: new Date(0), finishedAt: new Date(0) }) }));
vi.mock("./latestBandQuotes.js", () => ({ latestCycleQuotes: () => ({ quotes: harness.quotes, stale: false }) }));
vi.mock("./openPositionFigures.js", () => ({ loadOpenPositionFigures: async (tickerId: string) => harness.positionsByTickerId.get(tickerId) ?? harness.positions }));
vi.mock("./safetyLimits.js", () => ({ loadSafetyLimitBookCounts: async () => ({ ...harness.bookCounts }), plutoOrdersSentToday: async () => ({ count: 0 }) }));
vi.mock("../lib/orderLimits.js", async (original) => ({ ...(await original<object>()), loadCommittedCapitalOnSymbols: async () => harness.committed }));
vi.mock("./ledger.js", () => ({
  recordPlutoAction: vi.fn(async (input: Record<string, unknown>) => (harness.actions.push(input), `action-${harness.actions.length}`)),
  recordPlutoEvent: vi.fn(async (type: string, detail: Record<string, unknown>) => void harness.events.push({ type, detail })),
  recordCommissionCapSkip: vi.fn(async (detail: Record<string, unknown>) => void harness.events.push({ type: "call_skipped_commission", detail })),
}));
vi.mock("./tickerSettingsStore.js", async (original) => ({ ...(await original<object>()), loadEnabledPlutoTickerSettings: async () => harness.enabled }));
vi.mock("./volFarmerV4LookLoader.js", () => ({
  loadVolFarmerV4Memory: async (tickerId: string) => (harness.memory.has(tickerId) ? structuredClone(harness.memory.get(tickerId)) : null),
  saveVolFarmerV4Memory: async (tickerId: string, memory: unknown, adopted: boolean) => {
    harness.memory.set(tickerId, structuredClone(memory));
    harness.saves.push({ tickerId, adopted });
  },
  saveVolFarmerV4LastRound: async (tickerId: string, lastRound: { notes: string[]; figures: unknown }) => {
    harness.lastRounds.set(tickerId, structuredClone({ notes: lastRound.notes, figures: lastRound.figures }));
  },
  loadVolFarmerV4OrderOutcomes: async (actionIds: string[]) => new Map(actionIds.flatMap((id) => (harness.outcomes.has(id) ? [[id, harness.outcomes.get(id)]] : []))),
  loadVolFarmerV4LegStatuses: async () => new Map(),
  loadVolFarmerV4StepImpliedVolatility: async () => harness.stepImpliedVolatility,
  loadVolFarmerV4LeftoverStockLeg: async () => harness.leftoverStockLeg,
}));

const { isVolFarmerV4BuyBackRound, runVolFarmerV4Round, volFarmerV4CallsToBuyBack, volFarmerV4NoCallQuotedReason } = await import("./volFarmerV4Round.js");

/** v4 at its defaults: Calls expiring at today's close, 80% of the pot in shares, rebalanced. */
const v4Settings = { ...plutoSafetyLimitsSettingsFixture, ...plutoVolFarmerV4SettingsFixture, capitalBudgetPct: 50, excessAllowancePct: 0, maxQuoteAgeMinutes: 10, burstLines: 10, telegramVerbosity: "actions" };
/** v4 with its Calls on the next expiry, at or above the break-even, |delta| at most 0.3, and half the pot in shares (v2's values). */
const settings = { ...v4Settings, volFarmerV4OptionsExpiry: "next", volFarmerV4FirstPositionPct: 50, volFarmerV4CallMaxAbsDelta: 0.3, volFarmerV4CallStrikeFloor: "break_even" };
let roundSettings: Record<string, unknown> = settings;

/** Black-Scholes quotes at IV 50%, 2% either side of the mid, the stock at 100, `days` out (10: the 6 Nov 2026 expiry). */
function quotesAt(right: "C" | "P", expiry = "2026-11-06", days = 10): SymbolFileQuote[] {
  const years = days / 365;
  return Array.from({ length: 101 }, (_, index) => 40 + index).map((strike) => {
    const mid = blackScholesPriceOnForward(100 * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
    return { expiry, strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: null, askSize: null };
  });
}

const marketWatch = {
  burst: async (_symbol: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[]) => contracts.map((contract) => (harness.quotes as SymbolFileQuote[]).find((quote) => contractKey(quote) === contractKey(contract))!),
  snapshot: (symbol: string) => ({ symbol, last: 100, previousClose: 100, ...harness.stockQuote }),
};

function round(stressed = false, todayIso = "2026-10-27", clock: { now?: Date; windowEndAtMs?: number } = {}) {
  return runVolFarmerV4Round({ passId: "p1", settings: roundSettings as never, api: {} as never, marketWatch: marketWatch as never, trackWatch: () => {}, now: clock.now ?? new Date(`${todayIso}T15:00:00Z`), todayIso, totalCashValue: 500_000, settledCashValue: harness.settledCashValue, settledCashIsTotalCash: harness.settledCashIsTotalCash, netLiquidationValue: 1_000_000, cancelByMs: null, windowEndAtMs: clock.windowEndAtMs ?? null, symbols: [], stressed });
}

const v4Ticker = (symbol: string) => ({ tickerId: `t-${symbol}`, symbol, allocationPct: null, alwaysHoldTheStock: null as "on" | "off" | null });

const position = (shares: number, costPerShare: number) => ({ shares, costPerShare, premiums: [], calls: [], puts: [] });
const stockLeg = (id: string, quantity: number) => ({ id, legType: "stock", side: "long", quantity, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 100, entryAt: new Date(), exitPrice: null, exitAt: null });
/** VFT holding a first position of `shares` at $100 with no Call open, and nothing else: its shares the leftover-stock position's. */
function holdingFirstPosition(shares: number): void {
  harness.memory.set("t-VFT", { state: { potDollars: 250_000, first: position(shares, 100), second: null, leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 1, firstPositionCashLeft: [], putsCashLeft: [], leapsTriggers: [] } }, pending: [] });
  harness.positionsByTickerId.set("t-VFT", [{ strategyKey: "unstructured", status: "open", legs: [stockLeg("s1", shares)] }]);
  harness.leftoverStockLeg = { legId: "s1", positionId: "p1", shares };
}

/**
 * A ticker whose LEAPS is due: both positions hold 600 shares (inside the rebalancing band: $120,000 against half the
 * $250,000 pot ± $50,000), the first's break-even 100 (a Call to sell), the second's 130 (no Call at or above it, and the
 * price of 100 more than half a Step below it); its 17 Dec 2027 LEAPS expiry listed and quoted.
 */
function withLeapsDue(tickerId: string): void {
  harness.memory.set(tickerId, { state: { potDollars: 250_000, first: position(600, 100), second: position(600, 130), leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 1, firstPositionCashLeft: [], putsCashLeft: [], leapsTriggers: [] } }, pending: [] });
  const stockLeg = (id: string) => ({ id, legType: "stock", side: "long", quantity: 600, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 100, entryAt: new Date(), exitPrice: null, exitAt: null });
  harness.positionsByTickerId.set(tickerId, [{ strategyKey: "covered_call", status: "open", legs: [stockLeg(`${tickerId}-s1`), stockLeg(`${tickerId}-s2`)] }]);
  harness.chain = { expirations: ["20271217"], strikesByExpiry: new Map([["20271217", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
  harness.quotes = [...(harness.quotes as SymbolFileQuote[]), ...quotesAt("C", "2027-12-17", 416)];
  // The previous session's IV, 0.15 × √12 = 52%: a Step of exactly 15%.
  harness.stepImpliedVolatility = 0.15 * Math.sqrt(12);
}

/** What a LEAPS contract costs at the mid of the quote the steps chose it at, its commission included. */
const leapsContractCost = (action: Record<string, unknown>) => {
  const scores = action.candidateScores as { bid: number; ask: number };
  return ((scores.bid + scores.ask) / 2) * 100 + 0.65;
};

beforeEach(() => {
  // VFT's allocation is half of Pluto's budget: the $250,000 pot the figures below are sized for.
  harness.enabled = [{ tickerId: "t-VFT", symbol: "VFT", allocationPct: 50 }];
  harness.memory.clear();
  harness.saves.length = 0;
  harness.lastRounds.clear();
  harness.outcomes.clear();
  harness.positions = [];
  harness.positionsByTickerId.clear();
  harness.accountFreeCash = 400_000;
  harness.settledCashValue = 2_000_000;
  harness.settledCashIsTotalCash = false;
  harness.settledFreeCash = 2_000_000;
  harness.stockQuote = { bid: 99.98, ask: 100.02, updatedAtMs: Date.now() };
  harness.leftoverStockLeg = null;
  roundSettings = settings;
  harness.chain = { expirations: [], strikesByExpiry: new Map() };
  harness.breakEven = null;
  harness.stepImpliedVolatility = null;
  harness.quotes = [...quotesAt("C"), ...quotesAt("P")];
  harness.previousSessionVolumeMissing = false;
  harness.noVolumeStrikes = [];
  harness.bookCounts = { workingOrders: 0, ordersToday: 0, openPositions: 0 };
  harness.committed = 0;
  harness.actions.length = 0;
  harness.executed.length = 0;
  harness.events.length = 0;
  harness.previousClose = 99.5;
  harness.notices.length = 0;
  harness.optionCommission = 0.65;
});

describe("runVolFarmerV4Round", () => {
  it("sells no Call whose commission is more than 20% of its premium, and records the one it would have sold for the activity", async () => {
    // The best Call, the $105 at 1.4849, brings $148.49 a contract; a $40 commission is 27% of it, and every other Call brings
    // less: the flat ticker opens no cycle, and the activity hears of the $105.
    harness.optionCommission = 40;
    const summary = await round();
    expect(harness.executed).toEqual([]);
    expect(summary.sent).toBe(0);
    expect(harness.events.filter((event) => event.type === "call_skipped_commission")).toEqual([
      { type: "call_skipped_commission", detail: expect.objectContaining({ symbol: "VFT", position: "first", strike: 105, premiumDollars: 148.49, commissionDollars: 40, maxShareOfPremium: 0.2, tradingDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) }) },
    ]);
    expect(harness.lastRounds.get("t-VFT")!.notes.join(" ")).toMatch(/first position: the \$\d+ Call .* not sold: its commission \$40\.00 is 27% of its \$148\.49 premium, over 20%/);
  });

  it("opens a cycle on a flat ticker: one Covered Call with its shares, recorded under v4 and kept as pending", async () => {
    const summary = await round();
    expect(summary.looked).toEqual(["VFT"]);
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "open_covered_call", symbol: "VFT", executionStrategy: "vol_farmer_v4", outcome: "validated" })]);
    // Half the ticker's allocation (50% × 50% × $1,000,000 = $250,000): floor(125,000 ÷ 10,000.50) = 12 lots.
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", strategyKey: "covered_call", buyEveryShare: true, plan: expect.objectContaining({ quantity: 12 }) })]);
    const memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.pending).toEqual([expect.objectContaining({ ref: "action:action-1", kind: "covered_call", contracts: 12, startsCycle: true })]);
    expect(memory.state.first).toMatchObject({ shares: 1_200, calls: [{ legId: "action:action-1", shares: 1_200 }] });
    expect(summary.sent).toBe(1);
    // Pot $250,000; committed: the exposure, 30,000; free cash: the budget's $500,000 at most the account's $400,000; LEAPS cap 10% of the pot; the Puts' half, 125,000.
    expect(harness.lastRounds.get("t-VFT")).toEqual({ notes: [expect.stringContaining("VFT Sell $105 Call")], figures: { potDollars: 250_000, committedDollars: 30_000, freeCashDollars: 400_000, leapsCapDollars: 25_000, putsDollars: 125_000 } });
  });

  it("without the previous session's volume, sells the expiry it sells with the 20% rule lifted for the day, and says so", async () => {
    harness.chain = { expirations: ["20261106"], strikesByExpiry: new Map([["20261106", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
    harness.previousSessionVolumeMissing = true;
    await round();
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", strategyKey: "covered_call", plan: expect.objectContaining({ quantity: 12 }) })]);
    expect(harness.lastRounds.get("t-VFT")!.notes[0]).toBe("no previous-session volume for 6 Nov (10DTE): the 20% volume rule is off for it today");
  });

  it("with the previous session's volume, keeps the 20% rule and says nothing of it", async () => {
    harness.chain = { expirations: ["20261106"], strikesByExpiry: new Map([["20261106", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
    await round();
    expect(harness.executed).toHaveLength(1);
    expect(harness.lastRounds.get("t-VFT")!.notes.some((note) => note.includes("20% volume rule is off"))).toBe(false);
  });

  it("counts an order still working as planned, and opens afresh once it ended unfilled", async () => {
    await round();
    harness.outcomes.set("action-1", { working: true, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0, sharesSold: 0 });
    await round();
    expect(harness.executed).toHaveLength(1);
    harness.outcomes.set("action-1", { working: false, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0, sharesSold: 0 });
    const summary = await round();
    expect(summary.notes).toContain("VFT: the cycle's opening order did not fill: no cycle");
    expect(harness.executed).toHaveLength(2);
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).pending.map((order) => order.actionId)).toEqual(["action-2"]);
  });

  it("undoes an order a cap holds, as if never placed", async () => {
    harness.bookCounts = { workingOrders: 0, ordersToday: 100, openPositions: 0 };
    const summary = await round();
    expect(harness.actions).toEqual([]);
    expect(summary.notes.some((text) => text.includes("waits for a later round") && text.includes("of Pluto's 100 orders a day are sent"))).toBe(true);
    const memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory).toMatchObject({ pending: [], state: { first: null, potDollars: 0 } });
  });

  it("opens nothing while SPY's stress level holds", async () => {
    const summary = await round(true);
    expect(harness.executed).toEqual([]);
    expect(summary.notes.some((text) => text.startsWith("VFT: market stress:"))).toBe(true);
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).state.first).toBeNull();
  });

  it("adopts a ticker's holdings at its first look: every share at the cycle's break-even, its Call the first position's", async () => {
    harness.breakEven = 104.5;
    harness.positions = [{ strategyKey: "covered_call", status: "open", legs: [
      { id: "s1", legType: "stock", side: "long", quantity: 200, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: 106, entryAt: new Date(), exitPrice: null, exitAt: null },
      { id: "c1", legType: "option", side: "short", quantity: 2, optionType: "call", strikePrice: 110, expiryDate: "2026-11-06", multiplier: 100, entryPrice: 1.5, entryAt: new Date(), exitPrice: null, exitAt: null },
    ] }];
    await round();
    expect(harness.saves).toEqual([{ tickerId: "t-VFT", adopted: true }]);
    const memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.state.first).toMatchObject({ shares: 200, costPerShare: 104.5, calls: [{ legId: "c1", shares: 200 }] });
    expect(harness.events.filter((event) => event.type === "holdings_adopted").map((event) => event.detail)).toEqual([{ passId: expect.any(String), symbol: "VFT", strategy: "vol_farmer_v4", shares: 200, breakEvenPerShare: 104.5, callContracts: 2, putContracts: 0 }]);
    // Its Call is open: nothing to sell, and the Puts wait until the first position needs a new Call.
    expect(harness.executed).toEqual([]);
  });

  it("takes in a Call sold by hand on shares the memory holds uncovered, and sells no second Call on those lots", async () => {
    holdingFirstPosition(400);
    const soldByHand = { id: "c-hand", legType: "option", side: "short", quantity: 4, optionType: "call", strikePrice: 110, expiryDate: "2026-11-06", multiplier: 100, entryPrice: 0.6, entryAt: new Date(), exitPrice: null, exitAt: null };
    harness.positionsByTickerId.set("t-VFT", [{ strategyKey: "covered_call", status: "open", legs: [stockLeg("s1", 400), soldByHand] }]);
    const summary = await round();
    expect(harness.executed).toEqual([]);
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).state.first).toMatchObject({ shares: 400, calls: [{ legId: "c-hand", shares: 400 }] });
    expect(summary.notes).toContainEqual(expect.stringContaining("VFT: 4 open Calls Pluto did not sell now cover its shares"));
    expect(harness.events.filter((event) => event.type === "holdings_adopted").map((event) => event.detail)).toEqual([expect.objectContaining({ symbol: "VFT", shares: 400, callContracts: 4, putContracts: 0 })]);
    // The next round knows the Call: nothing to take in again.
    await round();
    expect(harness.events.filter((event) => event.type === "holdings_adopted")).toHaveLength(1);
    expect(harness.executed).toEqual([]);
  });

  it("sells a Call quoted without the volume for one contract: the volume rule is off for the sold expiry's Calls that day, and the round says so", async () => {
    holdingFirstPosition(1_000);
    // The previous session's capture lists every Call with no volume (the price gapped away from where the volume was); the quote loop quoted them anyway.
    harness.noVolumeStrikes = Array.from({ length: 101 }, (_, index) => 40 + index);
    harness.chain = { expirations: ["20261106"], strikesByExpiry: new Map([["20261106", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
    const summary = await round();
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", strategyKey: "covered_call", plan: expect.objectContaining({ quantity: 10 }) })]);
    expect(summary.notes).toContainEqual(expect.stringContaining("no Call in the delta range had the volume yesterday: the 20% volume rule is off for the Calls of"));
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
      expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", plan: expect.objectContaining({ quantity: 14 }) })]);
      expect(harness.lastRounds.get("t-VFT")!.figures).toMatchObject({ potDollars: 300_000, leapsCapDollars: 30_000 });
    } finally {
      settings.excessAllowancePct = 0;
    }
  });

  it("opens a new cycle with no more lots than the free cash pays for, and says so", async () => {
    harness.accountFreeCash = 50_000;
    await round();
    // Half the pot wants 12 lots of $10,000.50; the free cash pays for floor(50,000 ÷ 10,000.50) = 4.
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", buyEveryShare: true, plan: expect.objectContaining({ quantity: 4 }) })]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringContaining("the free cash ($50,000) pays for 4 of the 12 lots half the pot wants")]);
  });

  it("gives the tickers their turn in the day's order: alphabetical, starting one ticker further each day", async () => {
    harness.enabled = [v4Ticker("AAA"), v4Ticker("BBB")];
    await round(false, "2026-10-27");
    expect(harness.executed.map((order) => order.symbol)).toEqual(["BBB", "AAA"]);
    harness.memory.clear();
    harness.outcomes.clear();
    harness.executed.length = 0;
    await round(false, "2026-10-28");
    expect(harness.executed.map((order) => order.symbol)).toEqual(["AAA", "BBB"]);
  });

  it("buys a LEAPS after every ticker's new cycle, Calls and Puts, though its ticker's turn came first", async () => {
    harness.enabled = [v4Ticker("AAA"), v4Ticker("VFT")];
    withLeapsDue("t-VFT");
    const summary = await round();
    // 27 Oct: VFT's turn first, its first position's Call; then AAA's new cycle; then VFT's LEAPS.
    expect(harness.executed.map((order) => [order.symbol, order.kind, order.buyEveryShare ?? null])).toEqual([["VFT", "strategy_open", false], ["AAA", "strategy_open", true], ["VFT", "leaps_buy", null]]);
    // The free cash left is more than the LEAPS cap, 10% of VFT's $250,000 pot: the cap decides the contracts.
    const leaps = harness.actions.find((action) => action.kind === "buy_leaps")!;
    expect(leaps.quantity).toBe(Math.floor(25_000 / leapsContractCost(leaps)));
    expect(summary).toMatchObject({ looked: ["VFT", "AAA"], planned: 3, sent: 3 });
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringContaining("VFT Sell $105 Call"), expect.stringContaining("VFT Buy $")]);
  });

  it("buys the LEAPS on the free cash the round's other orders left, and says what the free cash cut", async () => {
    harness.enabled = [v4Ticker("AAA"), v4Ticker("VFT")];
    harness.accountFreeCash = 130_000;
    withLeapsDue("t-VFT");
    await round();
    // AAA's new cycle ties up 12 lots × 100 shares × $100 = $120,000 of the account's $130,000: $10,000 is left (VFT's Call on held shares ties up nothing).
    const leaps = harness.actions.find((action) => action.kind === "buy_leaps");
    expect(leaps).toBeDefined();
    expect((leaps!.candidateScores as { freeCash: number }).freeCash).toBe(10_000);
    const contracts = Math.floor(10_000 / leapsContractCost(leaps!));
    expect(leaps!.quantity).toBe(contracts);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContain(`the free cash ($10,000) held the LEAPS to ${contracts} of the ${Math.floor(25_000 / leapsContractCost(leaps!))} contracts its cap allows`);
  });

  it("buys no LEAPS without the previous session's IV, and says why", async () => {
    // VFT's half of the budget: the $250,000 pot withLeapsDue is sized for.
    withLeapsDue("t-VFT");
    harness.stepImpliedVolatility = null;
    await round();
    expect(harness.executed.some((order) => order.kind === "leaps_buy")).toBe(false);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContain("no LEAPS: the previous session has no IV for the Step");
  });
});

describe("runVolFarmerV4Round: v4's share orders and settled cash", () => {
  const filledPurchase = (shares: number, price: number) => ({ working: false, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: shares, sharesCostDollars: shares * price + shares * 0.005, sharesSold: 0 });
  /** A day a Call is sold (the next expiry): 1,000 shares ($100,000) against 80% of the $250,000 pot ± $50,000, a top-up of 900. */
  const topUpDue = () => {
    roundSettings = { ...v4Settings, volFarmerV4OptionsExpiry: "next" };
    holdingFirstPosition(1_000);
  };

  it("stops a ticker whose price is about a split's factor from the previous close, with none recorded, and tells a person once", async () => {
    // $100 against a previous close of $200.40: 0.499, within 5% of ½, a 2-for-1 split's factor.
    harness.previousClose = 200.4;
    const summary = await round();
    expect(harness.actions).toEqual([]);
    expect(harness.executed).toEqual([]);
    expect(summary.sent).toBe(0);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringMatching(/^trades at 100\.00 against a previous close of 200\.40, about a .* with none recorded: Pluto stops on it until a person looks$/)]);
    expect(harness.notices).toEqual([{ symbol: "VFT", reason: "split_guard" }]);
    // A 10% move is not a split's factor: the ticker trades.
    harness.previousClose = 111;
    await round();
    expect(harness.executed.length).toBeGreaterThan(0);
  });

  it("buys no shares on a stock quote older than the order route's 15 seconds, and says so", async () => {
    topUpDue();
    harness.stockQuote = { ...harness.stockQuote, updatedAtMs: Date.now() - 60_000 };
    const summary = await round();
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "buy_shares", outcome: "blocked", blockReason: expect.stringContaining("live_quote: no two-sided stock quote of the last 15 seconds") })]);
    expect(harness.executed).toEqual([]);
    expect(summary.sent).toBe(0);
  });

  it("always holding the stock, on a day no option ends, buys a flat ticker's first position alone at the mid of Pluto's quote, waits while it works, then holds the shares at their fill", async () => {
    roundSettings = v4Settings;
    const summary = await round();
    // 80% of the $250,000 pot: floor(200,000 ÷ 10,000.50) = 19 lots, bought at the mid of 99.98 / 100.02.
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "buy_shares", symbol: "VFT", quantity: 1_900, limitPrice: 100, executionStrategy: "vol_farmer_v4", outcome: "validated" })]);
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "shares_buy", symbol: "VFT", plan: expect.objectContaining({ quantity: 1_900, limitPrice: 100, notional: 190_000 }) })]);
    expect(summary).toMatchObject({ planned: 1, sent: 1 });
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringContaining("VFT Buy 1900 shares @ 100.00 (a new cycle's first position: 80% of the $250,000 pot, with no Call until an expiry day)")]);
    let memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.pending).toEqual([expect.objectContaining({ ref: "action:action-1", kind: "buy_shares", shares: 1_900, startsCycle: true, plannedSpentDollars: 190_009.5 })]);
    expect(memory.state.first).toMatchObject({ shares: 1_900 });

    // Still working: the ticker waits, nothing else is planned.
    await round();
    expect(harness.executed).toHaveLength(1);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual(["waits for its purchase of 1900 shares to end"]);

    // Filled at 99.99: the shares cost what they filled at, commission included; within the band, nothing more to do.
    harness.outcomes.set("action-1", filledPurchase(1_900, 99.99));
    harness.positionsByTickerId.set("t-VFT", [{ strategyKey: "unstructured", status: "open", legs: [stockLeg("s1", 1_900)] }]);
    await round();
    memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.pending).toEqual([]);
    expect(memory.state.first!.shares).toBe(1_900);
    expect(memory.state.first!.costPerShare).toBeCloseTo(99.995, 10);
    expect(harness.executed).toHaveLength(1);
  });

  it("with the ticker's own Always hold the stock off, on a day no option ends, buys no shares, a flat ticker's first position nor a top-up, and says why", async () => {
    roundSettings = v4Settings;
    harness.enabled = harness.enabled.map((ticker) => (ticker.symbol === "VFT" ? { ...ticker, alwaysHoldTheStock: "off" } : ticker));
    const summary = await round();
    expect([harness.actions, harness.executed]).toEqual([[], []]);
    expect(summary).toMatchObject({ planned: 0, sent: 0 });
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual(["no cycle opened: no Call is sold today, and with Always hold the stock off shares are bought only with one (until an expiry day)"]);

    holdingFirstPosition(1_000);
    await round();
    expect(harness.executed).toEqual([]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringMatching(/^no top-up: first position \$100,000 against a target of \$200,000 .*, but no Call is sold today, and with Always hold the stock off shares are bought only with one \(until an expiry day\)$/)]);
  });

  it("sends a share order alone: a top-up's Call is undone, and sold once the shares are bought", async () => {
    roundSettings = { ...v4Settings, volFarmerV4OptionsExpiry: "next" };
    holdingFirstPosition(1_000);
    await round();
    // $100,000 of shares against 80% of the pot, $200,000 ± $50,000: 9 lots bought to floor(200,000 ÷ 10,000.50) = 19.
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "shares_buy", plan: expect.objectContaining({ quantity: 900 }) })]);
    let memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.state.first).toMatchObject({ shares: 1_900, calls: [], premiums: [] });
    expect(memory.pending.map((order) => order.kind)).toEqual(["buy_shares"]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContain("its option orders are planned again once the share order ends");

    harness.outcomes.set("action-1", filledPurchase(900, 100));
    harness.positionsByTickerId.set("t-VFT", [{ strategyKey: "unstructured", status: "open", legs: [stockLeg("s1", 1_900)] }]);
    await round();
    expect(harness.executed.map((order) => [order.kind, (order.plan as { quantity: number }).quantity, order.buyEveryShare ?? null])).toEqual([["shares_buy", 900, null], ["strategy_open", 19, false]]);
    memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(memory.state.first).toMatchObject({ shares: 1_900, calls: [{ legId: "action:action-2", shares: 1_900 }] });
  });

  it("holds a share order back while another order of the ticker works, and sends nothing of the look", async () => {
    topUpDue();
    const memory = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    memory.state.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "action:put-1", dollars: 100, shares: 200 }], calls: [], puts: [{ legId: "action:put-1", shares: 200 }] };
    memory.pending = [{ ref: "action:put-1", actionId: "put-1", kind: "cash_secured_put", expiry: "2026-11-06", strike: 90, contracts: 2, startsCycle: false, contractsByPosition: { first: 0, second: 2 }, plannedPremiumByPosition: { first: 0, second: 100 }, leapsBeforeSale: null }];
    harness.outcomes.set("put-1", { working: true, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0, sharesSold: 0 });
    await round();
    expect(harness.executed).toEqual([]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContainEqual(expect.stringMatching(/^VFT Buy 900 shares @ 100\.00 .* waits for the ticker's 1 working order\(s\) to end$/));
    const saved = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(saved.state.first).toMatchObject({ shares: 1_000, costPerShare: 100 });
    expect(saved.pending.map((order) => order.actionId)).toEqual(["put-1"]);
  });

  it("trims from the leftover-stock position at the mid; a part fill leaves the shares it did not sell in the position", async () => {
    // A 5% band: $250,000 of shares against $200,000 ± $12,500, 6 lots sold, to 19 (at 20%, ± $50,000, $250,000 is inside).
    roundSettings = { ...v4Settings, volFarmerV4RebalanceBandPct: 5 };
    holdingFirstPosition(2_500);
    await round();
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "close_shares", quantity: 600, limitPrice: 100 })]);
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "shares_sell", positionId: "p1", legId: "s1", plan: expect.objectContaining({ quantity: 600, limitPrice: 100 }) })]);
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).pending).toEqual([expect.objectContaining({ kind: "sell_shares", shares: 600, saleParts: [{ position: "first", shares: 600 }] })]);

    harness.outcomes.set("action-1", { working: false, filledContracts: 0, optionLegIds: [], optionNetDollars: 0, sharesBought: 0, sharesCostDollars: 0, sharesSold: 400 });
    harness.leftoverStockLeg = { legId: "s1", positionId: "p1", shares: 2_100 };
    await round();
    expect(harness.lastRounds.get("t-VFT")!.notes[0]).toBe("the sale of 600 shares, 400 filled");
    // 2,100 shares, $210,000: inside the band, so nothing more is sold.
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).state.first).toMatchObject({ shares: 2_100, costPerShare: 100 });
    expect(harness.executed).toHaveLength(1);
  });

  it("buys no more than the settled cash left pays for, and nothing when IBKR reports no settled cash", async () => {
    topUpDue();
    harness.settledFreeCash = 50_000;
    await round();
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "shares_buy", plan: expect.objectContaining({ quantity: 400 }) })]);
    expect(harness.lastRounds.get("t-VFT")!.figures).toMatchObject({ freeCashDollars: 50_000 });

    holdingFirstPosition(1_000);
    harness.executed.length = 0;
    harness.settledCashValue = null;
    await round();
    // A Call on the shares held needs no cash: only the purchase is left out.
    expect(harness.executed.map((order) => order.kind)).toEqual(["strategy_open"]);
    expect(harness.lastRounds.get("t-VFT")!.notes.slice(0, 2)).toEqual(["IBKR reports no settled cash, so the free cash is 0: nothing is bought and no Put sold", expect.stringContaining("no top-up")]);
  });

  it("on the paper account, with the total cash standing in for the settled cash, buys and says so", async () => {
    topUpDue();
    harness.settledCashValue = 500_000;
    harness.settledCashIsTotalCash = true;
    await round();
    expect(harness.executed).toEqual([expect.objectContaining({ kind: "shares_buy" })]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toContain("IBKR reports no settled cash on the paper account, so the total cash stands in");
  });

  it("on an expiry day, buys a flat ticker's first position with its first Call, expiring at today's close", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-27T15:00:00Z") });
    try {
      roundSettings = v4Settings;
      harness.chain = { expirations: ["20261027", "20261030"], strikesByExpiry: new Map([["20261027", Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
      // 11:00 Eastern: five hours to the close.
      harness.quotes = [...quotesAt("C", "2026-10-27", 5 / 24), ...quotesAt("P", "2026-10-27", 5 / 24)];
      await round();
      expect(harness.executed).toEqual([expect.objectContaining({ kind: "strategy_open", strategyKey: "covered_call", buyEveryShare: true, contract: expect.objectContaining({ expiry: "2026-10-27", dte: 0 }), plan: expect.objectContaining({ quantity: 19 }) })]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("runVolFarmerV4Round: the buyback in the window's last minutes", () => {
  // Friday 30 Oct 2026 and the Thursday before it, the window ending at 15:30 Eastern (19:30 UTC, daylight time).
  const at = (todayIso: string, timeUtc: string) => ({ now: new Date(`${todayIso}T${timeUtc}Z`), windowEndAtMs: Date.parse(`${todayIso}T19:30:00Z`) });
  const callLeg = (id: string, strike: number, expiry: string, quantity = 19) => ({ id, legType: "option", side: "short", quantity, optionType: "call", strikePrice: strike, expiryDate: expiry, multiplier: 100, entryPrice: 0.8, entryAt: new Date(), exitPrice: null, exitAt: null });
  /** VFT's first position of 1,900 shares at $100 covered by 19 Calls at `strike` expiring `todayIso` (leg c1); the stock is at 100, the Call quoted 1.05 / 1.15. */
  function holdingTodaysCall(todayIso: string, strike: number, setting: string): void {
    roundSettings = { ...v4Settings, volFarmerV4CallsInTheMoneyAtLastLook: setting };
    harness.memory.set("t-VFT", { state: { potDollars: 250_000, first: { ...position(1_900, 100), calls: [{ legId: "c1", shares: 1_900 }] }, second: null, leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 1, firstPositionCashLeft: [], putsCashLeft: [], leapsTriggers: [] } }, pending: [] });
    harness.positionsByTickerId.set("t-VFT", [{ strategyKey: "covered_call", status: "open", legs: [stockLeg("s1", 1_900), callLeg("c1", strike, todayIso)] }]);
    harness.chain = { expirations: [todayIso.replaceAll("-", "")], strikesByExpiry: new Map([[todayIso.replaceAll("-", ""), Array.from({ length: 101 }, (_, index) => 40 + index)]]) };
    harness.quotes = [{ expiry: todayIso, strike, right: "C", bid: 1.05, ask: 1.15, bidSize: null, askSize: null }];
  }
  const buyBacks = () => harness.executed.filter((order) => order.kind === "call_buy_back");

  it("on the last session before a weekend, in the last 2 minutes, buys back a Call expiring today in the money at the mid, and sends nothing else", async () => {
    holdingTodaysCall("2026-10-30", 99, "bought_back_before_weekends");
    await round(false, "2026-10-30", at("2026-10-30", "19:28:30"));
    expect(harness.executed).toEqual([
      expect.objectContaining({ kind: "call_buy_back", legId: "c1", positionId: "position-of-c1", contract: { expiry: "2026-10-30", strike: 99, right: "C", dte: 0 }, plan: expect.objectContaining({ quantity: 19, limitPrice: 1.1 }) }),
    ]);
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "close_leg", outcome: "validated", quantity: 19, limitPrice: 1.1, contract: { strategyKey: "covered_call", expiry: "2026-10-30", strike: 99, right: "C" } })]);
    expect((harness.memory.get("t-VFT") as VolFarmerV4Memory).pending).toEqual([expect.objectContaining({ kind: "buy_back_call", boughtBackLegId: "c1", contracts: 19, contractsByPosition: { first: 19, second: 0 } })]);
    // The screen keeps the ticker's figures through the weekend.
    expect(harness.lastRounds.get("t-VFT")!.figures).toMatchObject({ potDollars: 250_000, freeCashDollars: expect.any(Number) });
  });

  it("does not send a buyback twice while it works; filled, its cost goes against the position's premiums and the Call is gone", async () => {
    holdingTodaysCall("2026-10-30", 99, "bought_back_before_weekends");
    await round(false, "2026-10-30", at("2026-10-30", "19:28:30"));
    await round(false, "2026-10-30", at("2026-10-30", "19:29:10"));
    expect(buyBacks()).toHaveLength(1);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual(["the window's last 2 minutes: 1 buyback(s) working, nothing else is sent"]);

    // 19 × 1.10 × 100 + 19 × $0.65.
    harness.outcomes.set(harness.executed[0]!.actionId as string, { working: false, filledContracts: 19, optionLegIds: ["c1"], optionNetDollars: 2_102.35, sharesBought: 0, sharesCostDollars: 0, sharesSold: 0 });
    await round(false, "2026-10-30", at("2026-10-30", "19:29:50"));
    expect(buyBacks()).toHaveLength(1);
    const { state, pending } = harness.memory.get("t-VFT") as VolFarmerV4Memory;
    expect(pending).toEqual([]);
    expect(state.first).toMatchObject({ shares: 1_900, calls: [], premiums: [{ legId: "c1", dollars: -2_102.35, shares: 1_900 }] });
  });

  it("buys back on every day under \"bought back\", and only before a weekend under \"before weekends only\"", async () => {
    holdingTodaysCall("2026-10-29", 99, "bought_back");
    await round(false, "2026-10-29", at("2026-10-29", "19:28:30"));
    expect(buyBacks()).toHaveLength(1);

    harness.executed.length = 0;
    holdingTodaysCall("2026-10-29", 99, "bought_back_before_weekends");
    await round(false, "2026-10-29", at("2026-10-29", "19:28:30"));
    expect(buyBacks()).toEqual([]);
  });

  it("buys nothing back before the last 2 minutes, nor with the setting at \"assigned\"", async () => {
    holdingTodaysCall("2026-10-30", 99, "bought_back_before_weekends");
    await round(false, "2026-10-30", at("2026-10-30", "19:27:59"));
    expect(buyBacks()).toEqual([]);

    holdingTodaysCall("2026-10-30", 99, "assigned");
    await round(false, "2026-10-30", at("2026-10-30", "19:28:30"));
    expect(buyBacks()).toEqual([]);
  });

  it("leaves a Call out of the money alone in those minutes, and says nothing else is sent", async () => {
    holdingTodaysCall("2026-10-30", 101, "bought_back_before_weekends");
    await round(false, "2026-10-30", at("2026-10-30", "19:28:30"));
    expect(harness.executed).toEqual([]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual(["the window's last 2 minutes: no Call expiring today is in the money at 100.00, so nothing is bought back and nothing else is sent"]);
  });

  it("does not send a buyback the settled cash left can't pay for: the Call is left to be assigned", async () => {
    holdingTodaysCall("2026-10-30", 99, "bought_back_before_weekends");
    harness.settledFreeCash = 2_000;
    await round(false, "2026-10-30", at("2026-10-30", "19:28:30"));
    expect(harness.executed).toEqual([]);
    expect(harness.actions).toEqual([expect.objectContaining({ kind: "close_leg", outcome: "blocked", blockReason: "settled_cash: the buyback costs $2,102, the settled cash left is $2,000" })]);
    expect(harness.lastRounds.get("t-VFT")!.notes).toEqual([expect.stringMatching(/^the buyback of 19× \$99 Call · 30 Oct \(0DTE\) is not sent \(the buyback costs \$2,102, the settled cash left is \$2,000\): the Call is left to be assigned/)]);
  });

  it("goes under SPY's stress: a buyback opens nothing", async () => {
    holdingTodaysCall("2026-10-30", 99, "bought_back_before_weekends");
    await round(true, "2026-10-30", at("2026-10-30", "19:28:30"));
    expect(buyBacks()).toHaveLength(1);
  });
});

describe("isVolFarmerV4BuyBackRound", () => {
  const windowEndAtMs = Date.parse("2026-10-30T19:30:00Z");
  const check = (callsInTheMoneyAtLastLook: "assigned" | "bought_back" | "bought_back_before_weekends", nowIso: string, todayIso = "2026-10-30", nextSessionIso: string | undefined = "2026-11-02") =>
    isVolFarmerV4BuyBackRound({ callsInTheMoneyAtLastLook, nowMs: Date.parse(nowIso), windowEndAtMs, todayIso, nextSessionIso });

  it("is one from 2 minutes before the window's end, on the days the setting buys back", () => {
    expect(check("bought_back_before_weekends", "2026-10-30T19:28:00Z")).toBe(true);
    expect(check("bought_back_before_weekends", "2026-10-30T19:27:59Z")).toBe(false);
    expect(check("assigned", "2026-10-30T19:29:00Z")).toBe(false);
    // A Wednesday, the next session Thursday: every day only.
    expect(check("bought_back", "2026-10-30T19:29:00Z", "2026-10-28", "2026-10-29")).toBe(true);
    expect(check("bought_back_before_weekends", "2026-10-30T19:29:00Z", "2026-10-28", "2026-10-29")).toBe(false);
    // The Thursday before Good Friday 2026.
    expect(check("bought_back_before_weekends", "2026-10-30T19:29:00Z", "2026-04-02", "2026-04-06")).toBe(true);
    expect(isVolFarmerV4BuyBackRound({ callsInTheMoneyAtLastLook: "bought_back", nowMs: windowEndAtMs, windowEndAtMs: null, todayIso: "2026-10-30", nextSessionIso: "2026-11-02" })).toBe(false);
  });
});

describe("volFarmerV4CallsToBuyBack", () => {
  const leg = (id: string, strike: number, quantity: number, overrides: Record<string, unknown> = {}) => ({ id, legType: "option" as const, side: "short" as const, quantity, optionType: "call" as const, strikePrice: strike, expiryDate: "2026-10-30", multiplier: 100, entryPrice: 0.8, entryAt: new Date(), exitPrice: null, exitAt: null, ...overrides });
  const state = (firstCalls: { legId: string; shares: number }[], secondCalls: { legId: string; shares: number }[] = []) =>
    ({ potDollars: 250_000, first: { shares: 1_900, costPerShare: 100, premiums: [], calls: firstCalls, puts: [] }, second: secondCalls.length > 0 ? { shares: 600, costPerShare: 90, premiums: [], calls: secondCalls, puts: [] } : null, leaps: null, leapsBought: false, leapsToSell: false, leapsTrigger: null, cash: { cycles: 1, firstPositionCashLeft: [], putsCashLeft: [], leapsTriggers: [] } }) as never;

  it("takes v4's Calls expiring today at or below the price, with each position's contracts, and leaves the rest", () => {
    const calls = volFarmerV4CallsToBuyBack({
      state: state([{ legId: "c1", shares: 1_900 }, { legId: "c2", shares: 500 }], [{ legId: "c1", shares: 600 }]),
      openLegs: [leg("c1", 100, 25), leg("c2", 101, 5), leg("c3", 99, 2), leg("c4", 99, 3, { expiryDate: "2026-11-02" }), leg("c5", 98, 4, { side: "long" })],
      pending: [],
      stockPrice: 100,
      todayIso: "2026-10-30",
    });
    // c2 is out of the money, c3 is not v4's, c4 expires Monday, c5 is bought.
    expect(calls).toEqual([{ legId: "c1", expiry: "2026-10-30", strike: 100, contracts: 25, contractsByPosition: { first: 19, second: 6 } }]);
  });

  it("skips a Call being bought back, and never buys back more contracts than the leg holds", () => {
    const pending = [{ ref: "action:a1", actionId: "a1", kind: "buy_back_call", expiry: "2026-10-30", strike: 100, contracts: 19, startsCycle: false, contractsByPosition: { first: 19, second: 0 }, plannedPremiumByPosition: { first: 0, second: 0 }, leapsBeforeSale: null, boughtBackLegId: "c1" }] as never;
    expect(volFarmerV4CallsToBuyBack({ state: state([{ legId: "c1", shares: 1_900 }]), openLegs: [leg("c1", 100, 19)], pending, stockPrice: 100, todayIso: "2026-10-30" })).toEqual([]);
    expect(volFarmerV4CallsToBuyBack({ state: state([{ legId: "c1", shares: 1_900 }]), openLegs: [leg("c1", 100, 12)], pending: [], stockPrice: 100, todayIso: "2026-10-30" })).toEqual([expect.objectContaining({ contracts: 12 })]);
  });
});

describe("volFarmerV4NoCallQuotedReason", () => {
  // Wed 28 Oct 2026: the next listed expiry is Fri 30 Oct (2DTE).
  const base = { todayIso: "2026-10-28", expirations: ["20261106", "20261030", "20261028"], strikesByExpiry: new Map([["20261030", [95, 105]], ["20261106", [105]], ["20261028", [105]]]), optionsExpiry: "next" as const };

  it("without the previous session's volume (a ticker enabled after the capture), the expiry is quoted whole: no volume reason", () => {
    expect(volFarmerV4NoCallQuotedReason({ ...base, previousSessionVolumeByContract: null, bandCycleFinished: false })).toBe("no 30 Oct (2DTE) option is quoted yet today");
    expect(volFarmerV4NoCallQuotedReason({ ...base, previousSessionVolumeByContract: null, bandCycleFinished: true })).toBe("no 30 Oct (2DTE) Call is near v4's Call |delta| range at this price, so none is quoted");
  });

  it("tells the 20% volume rule, quotes not in yet, and the |delta| band apart", () => {
    const volume = new Map([["2026-10-30|105|C", 4], ["2026-10-30|95|P", 50]]);
    expect(volFarmerV4NoCallQuotedReason({ ...base, previousSessionVolumeByContract: volume, bandCycleFinished: false })).toBe("no 30 Oct (2DTE) Call traded enough in the previous session to sell one (the 20% volume rule needs a volume of 5 or more)");
    const traded = new Map([["2026-10-30|105|C", 40]]);
    expect(volFarmerV4NoCallQuotedReason({ ...base, previousSessionVolumeByContract: traded, bandCycleFinished: false })).toBe("no 30 Oct (2DTE) option is quoted yet today");
    // A finished cycle without a Call after today: none was near the range at this price (a Call quoted at an earlier cycle has left the band).
    expect(volFarmerV4NoCallQuotedReason({ ...base, previousSessionVolumeByContract: traded, bandCycleFinished: true })).toBe("no 30 Oct (2DTE) Call is near v4's Call |delta| range at this price, so none is quoted");
  });

  it("keeps the plain note when the chain lists no expiry after today", () => {
    expect(volFarmerV4NoCallQuotedReason({ ...base, expirations: ["20261028"], previousSessionVolumeByContract: null, bandCycleFinished: false })).toBe("no Call expiry listed after today");
  });

  it("selling today's expiry: words it, or that none ends today", () => {
    expect(volFarmerV4NoCallQuotedReason({ ...base, optionsExpiry: "today", previousSessionVolumeByContract: null, bandCycleFinished: false })).toBe("no 28 Oct (0DTE) option is quoted yet today");
    expect(volFarmerV4NoCallQuotedReason({ ...base, optionsExpiry: "today", todayIso: "2026-10-29", previousSessionVolumeByContract: null, bandCycleFinished: false })).toBe("no Call expiry ends today");
  });
});
