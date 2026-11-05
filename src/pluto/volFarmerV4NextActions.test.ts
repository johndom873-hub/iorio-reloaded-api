import { describe, expect, it } from "vitest";
import { newVolFarmerV4SymbolState, type VolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import { plutoSafetyLimitsSettingsFixture, plutoVolFarmerV4SettingsFixture } from "./plutoSettingsFixture.js";
import type { PlutoSettings } from "./settingsStore.js";
import { volFarmerV4RulesOf } from "./volFarmerV4LiveBook.js";
import { describeVolFarmerV4NextActions, volFarmerV4ShareTrades, type VolFarmerV4NextActionsInput } from "./volFarmerV4NextActions.js";

// The Next action column (approved mockup, 2026-11-05) on the Pluto staging tickers as they stood on Wed 4 Nov 2026: Calls expiring
// at the close, no expiry on Thu 5 Nov, INTC and NBIS listing Fridays only. The pot, committed and free cash figures are the card's.
const settings = { ...plutoSafetyLimitsSettingsFixture, ...plutoVolFarmerV4SettingsFixture, volFarmerV4FirstPositionPct: 80, volFarmerV4RebalanceBandPct: 20, volFarmerV4Rebalances: "both_positions", volFarmerV4AlwaysHoldTheStock: "on", volFarmerV4TopUpCapPct: 0, volFarmerV4FirstPositionAfterCalledAway: "wait", volFarmerV4OptionsExpiry: "today", volFarmerV4PutsStartCallYieldPct: 5, volFarmerV4CallsInTheMoneyAtLastLook: "bought_back_before_weekends" } as unknown as PlutoSettings;
const rules = volFarmerV4RulesOf(settings);
const stockCommissionDollars = (shares: number) => 0.005 * shares;

const everyDayExpiries = ["20261104", "20261106", "20261109", "20261111", "20261113"];
const fridaysOnly = ["20261106", "20261113", "20261120"];
const openDays = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09", "2026-11-10", "2026-11-11"];

function position(shares: number, costPerShare: number, calls: { strike: number; expiry: string; contracts: number }[] = []) {
  return { shares, costPerShare, breakEvenPerShare: costPerShare, calls: calls.map((call) => ({ ...call, working: false })), puts: [] as { strike: number; expiry: string; contracts: number; working: boolean }[] };
}
function stateOf(shares: number, costPerShare: number): VolFarmerV4SymbolState {
  const state = newVolFarmerV4SymbolState();
  state.first = { shares, costPerShare, premiums: [], calls: [], puts: [] };
  return state;
}
const figuresOf = (potDollars: number, committedDollars: number) => ({ potDollars, committedDollars, freeCashDollars: 354_182, leapsCapDollars: potDollars / 10, putsDollars: potDollars * 0.2 });

function dram(overrides: Partial<VolFarmerV4NextActionsInput> = {}): VolFarmerV4NextActionsInput {
  return {
    ticker: { symbol: "DRAM", waiting: false, first: position(1_000, 48.32, [{ strike: 46, expiry: "2026-11-04", contracts: 10 }]), second: null, leaps: null, workingOrders: [], lastRoundNotes: ["IBKR reports no settled cash on the paper account, so the total cash stands in"], lastRoundFigures: figuresOf(56_957.09, 45_204.9) },
    state: stateOf(1_000, 48.32),
    rules,
    todayIso: "2026-11-04",
    windowOpenToday: true,
    blockReason: null,
    expirations: everyDayExpiries,
    openDays,
    caps: { ordersTodayTicker: 2, ordersTodayBook: 8, maxPerTicker: 30, maxPerDay: 100 },
    stockPrice: 45.145,
    stockCommissionDollars,
    stepImpliedVolatility: 0.656,
    ...overrides,
  };
}
const line = (result: ReturnType<typeof describeVolFarmerV4NextActions>, key: string) => result.actions.find((action) => action.key === key)!;

describe("where v4's own rebalancing would trade shares", () => {
  it("sells 3 lots of DRAM's 10 at $56.96 (the holding passes the pot) and buys 3 at $34.17 (it falls under 60% of the pot)", () => {
    const trades = volFarmerV4ShareTrades({ symbol: "DRAM", state: stateOf(1_000, 48.32), potDollars: 56_957.09, freeCashDollars: 354_182, stockPrice: 45.145, rules, stockCommissionDollars });
    expect(trades.sellAtOrAbove).toEqual({ price: 56.96, shares: 300 });
    expect(trades.buyAtOrBelow).toEqual({ price: 34.17, shares: 300 });
  });

  it("finds nothing for a ticker holding no shares", () => {
    expect(volFarmerV4ShareTrades({ symbol: "ZZZ", state: newVolFarmerV4SymbolState(), potDollars: 50_000, freeCashDollars: 100_000, stockPrice: 50, rules, stockCommissionDollars })).toEqual({ sellAtOrAbove: null, buyAtOrBelow: null });
  });
});

describe("the Next action column", () => {
  it("DRAM on Wed 4 Nov: its Call expires at the close and Thursday has no expiry, so the next Calls are Friday's", () => {
    const result = describeVolFarmerV4NextActions(dram());
    expect(result.nextAction).toEqual({ state: "waiting", text: "Sell Calls on 10 lots", sub: "Fri 6 Nov (0DTE) · today's $46 Call expires at the close · DRAM has no expiry on Thu 5 Nov", alert: null });
    expect(result.actions.map((action) => [action.key, action.state])).toEqual([["sell_calls", "waiting"], ["sell_puts", "not_due"], ["buy_leaps", "not_due"], ["buy_shares", "not_due"], ["sell_shares", "not_due"], ["buy_back_call", "not_due"]]);
    expect(line(result, "sell_puts").detail).toBe("Waits for the first position's next Call, then starts if that Call yields under 5% a year ($11,391 of the pot is kept for Puts).");
    expect(line(result, "sell_shares").detail).toBe("Sells 300 shares if DRAM is at $56.96 or above, once the $46 Call · Wed 4 Nov has expired (the first position keeps one lot; more shares at higher prices).");
    expect(line(result, "buy_shares").detail).toContain("Buys 300 shares if DRAM is at $34.17 or below");
    expect(line(result, "buy_leaps").detail).toContain("Needs a second position holding shares");
    expect(line(result, "buy_back_call").detail).toBe("Not before the Calls expire: v4 buys a Call in the money back only in the last 2 minutes before a weekend (next: Fri 6 Nov).");
  });

  it("INTC, selling Friday expiries only: 4 of its 5 lots have no Call, and its $108 Call is bought back on Friday if in the money", () => {
    const result = describeVolFarmerV4NextActions(dram({ ticker: { symbol: "INTC", waiting: false, first: position(500, 106.67, [{ strike: 108, expiry: "2026-11-06", contracts: 1 }]), second: null, leaps: null, workingOrders: [], lastRoundNotes: [], lastRoundFigures: figuresOf(57_249.29, 29_117.5) }, state: stateOf(500, 106.67), expirations: fridaysOnly, stockPrice: 93.52 }));
    expect(result.nextAction).toEqual({ state: "waiting", text: "Sell Calls on 4 lots", sub: "Fri 6 Nov (0DTE) · INTC has no expiry until Fri 6 Nov", alert: null });
    expect(line(result, "buy_back_call")).toMatchObject({ state: "waiting", detail: "Fri 6 Nov, last 2 minutes: the $108 Call · Fri 6 Nov is bought back if it is in the money." });
    expect(line(result, "sell_shares").detail).toContain("once the $108 Call · Fri 6 Nov has expired");
  });

  it("SPCX: the pot is nearly committed, so Puts are blocked and the headline says so in its alert line", () => {
    const result = describeVolFarmerV4NextActions(dram({ ticker: { symbol: "SPCX", waiting: false, first: position(400, 139.31, [{ strike: 140, expiry: "2026-11-04", contracts: 4 }]), second: null, leaps: null, workingOrders: [], lastRoundNotes: [], lastRoundFigures: figuresOf(56_957.09, 53_754) }, state: stateOf(400, 139.31), stockPrice: 135.81 }));
    expect(line(result, "sell_puts")).toMatchObject({ state: "blocked", detail: "SPCX commits $53,754 of its $56,957 pot: a v4 Put on the rest of the pot ($11,391) would be refused by the pot check." });
    expect(result.nextAction).toMatchObject({ state: "waiting", text: "Sell Calls on 4 lots", alert: "Sell Puts blocked: $53,754 of the $56,957 pot is committed" });
  });

  it("a ticker with no Call open on an expiry day is ready, or says why it waits, or is blocked by the daily cap", () => {
    const bare = { first: position(1_000, 48.32), workingOrders: [], lastRoundFigures: figuresOf(56_957.09, 45_204.9) };
    const base = dram({ ticker: { ...dram().ticker, ...bare } });
    expect(describeVolFarmerV4NextActions(base).nextAction).toEqual({ state: "ready", text: "Sell Calls on 10 lots", sub: "sending at the next quote", alert: null });
    const noted = describeVolFarmerV4NextActions({ ...base, ticker: { ...base.ticker, lastRoundNotes: ["first position: no Call above the price 46.36 (quote 1)"] } });
    expect(noted.nextAction).toMatchObject({ state: "waiting", text: "Sell Calls on 10 lots", sub: "first position: no Call above the price 46.36 (quote 1)" });
    const capped = describeVolFarmerV4NextActions({ ...base, caps: { ordersTodayTicker: 30, ordersTodayBook: 66, maxPerTicker: 30, maxPerDay: 100 } });
    expect(capped.nextAction).toMatchObject({ state: "blocked", text: "Sell Calls on 10 lots", sub: "30 of the ticker's 30 orders a day are sent" });
  });

  it("an order still working is the headline; Pluto paused or a split guard stop the ticker", () => {
    const working = describeVolFarmerV4NextActions(dram({ ticker: { ...dram().ticker, first: position(1_000, 48.32), workingOrders: [{ kind: "covered_call", strike: 46, expiry: "2026-11-04", contracts: 10, shares: null }] } }));
    expect(working.nextAction).toEqual({ state: "working", text: "Sell 10 × $46 Call · 4 Nov (0DTE)", sub: "order working", alert: null });
    expect(describeVolFarmerV4NextActions(dram({ blockReason: "Pluto is paused (manual)." })).nextAction).toEqual({ state: "stopped", text: "Pluto is paused (manual).", sub: null, alert: null });
    const split = describeVolFarmerV4NextActions(dram({ ticker: { ...dram().ticker, lastRoundNotes: ["trades at 100.00 against a previous close of 200.40, about a 2-for-1 split with none recorded: Pluto stops on it until a person looks"] } }));
    expect(split.nextAction).toMatchObject({ state: "stopped", text: "DRAM is stopped" });
  });

  it("with a second position holding shares, a LEAPS waits for a price half a Step under its break-even", () => {
    const state = stateOf(400, 100);
    state.second = { shares: 200, costPerShare: 90, premiums: [], calls: [], puts: [] };
    const result = describeVolFarmerV4NextActions(dram({ ticker: { ...dram().ticker, second: { ...position(200, 90), breakEvenPerShare: 90 } }, state, expirations: [...everyDayExpiries, "20270319", "20270618"], stepImpliedVolatility: 0.6 }));
    // Step = 0.6 × √(21 ÷ 252) = 17.32%; half of it under B-E² $90 is $82.2058. 19 Mar 2027 is 135 days out, under the 180 a LEAPS needs; 18 Jun is 226.
    expect(line(result, "buy_leaps")).toMatchObject({ state: "waiting", detail: "Buys the Call of 18 Jun 2027 (226DTE) whose |delta| is nearest 0.6 if DRAM is at $82.21 or below (half a Step under the second position's break-even)." });
  });

  it("a ticker v4 has not adopted yet says it waits", () => {
    const result = describeVolFarmerV4NextActions(dram({ ticker: { ...dram().ticker, waiting: true, lastRoundNotes: ["holds no shares yet: its open Puts are left to expire or be assigned before v4 adopts it"] }, state: null }));
    expect(result.nextAction).toEqual({ state: "not_due", text: "Waiting to adopt its holdings", sub: "holds no shares yet: its open Puts are left to expire or be assigned before v4 adopts it", alert: null });
    expect(result.actions).toEqual([]);
  });
});
