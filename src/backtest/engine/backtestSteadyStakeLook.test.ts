import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { blackScholesDelta, blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import { defaultBacktestSteadyStakeSettings, type BacktestSteadyStakeSettings, type EffectiveBacktestSettings } from "../backtestTypes.js";
import { validateSteadyStakeSettings } from "../jobs/backtestSessionRequest.js";
import type { BacktestLookContext, BacktestLookSymbol } from "./backtestLookTypes.js";
import { runSteadyStakeLook } from "./backtestSteadyStakeLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buyShares } from "./ledger/ledgerEvents.js";
import { ledgerFreeCash, ledgerFreeShares, ledgerOpenCycleSummary } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, legsOfPosition, positionsOfSymbol, type SimulatedLedger } from "./ledger/simulatedLedger.js";

const fridayIso = "2026-03-06";
const mondayIso = "2026-03-09";
const stockPrice = 100;
const riskFreeRate = 0.04;
const volatility = 0.5;
const yearsToClose = 6 / 8760;

/** Today closes at 16:00. */
const calendarOf = (dateIso: string) => ({ sessionsBetween: () => [{ dateIso, closeMinutesEt: 16 * 60 }] });

/** A quote expiring at today's close, priced by Black-76 at 50% volatility with a 4% spread around that mid. */
function sameDayQuote(expiry: string, strike: number, right: "C" | "P"): SymbolFileQuote {
  const mid = blackScholesPriceOnForward(stockPrice * Math.exp(riskFreeRate * yearsToClose), strike, yearsToClose, riskFreeRate, volatility, right === "C");
  return { expiry, strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: 10, askSize: 10 };
}

/** Strikes $98 to $102 by 50 cents, both rights, expiring today. */
const expiryDayQuotes = (expiry: string) => Array.from({ length: 9 }, (_, index) => 98 + index * 0.5).flatMap((strike) => [sameDayQuote(expiry, strike, "C"), sameDayQuote(expiry, strike, "P")]);

function lookSymbolOf(symbol: string, todayIso: string, quotes: SymbolFileQuote[], volume = 1_000): BacktestLookSymbol {
  return {
    profile: { symbol, calendarChecksApply: false, earnings: [] },
    market: { todayIso, quotes, previousSessionVolumeByContract: new Map(quotes.map((entry) => [contractKey(entry), volume])), stockPrice, riskFreeRatePercent: riskFreeRate * 100 },
    adjustedDailyClosesBeforeToday: [],
    splitFactorToday: 1,
    optionContractsRepresentable: true,
  } as unknown as BacktestLookSymbol;
}

function look(input: { ledger: SimulatedLedger; todayIso: string; symbols: BacktestLookSymbol[]; steadyStake?: Partial<BacktestSteadyStakeSettings>; priceByLegId?: Map<string, number> }) {
  let actionNumber = 0;
  // The examples below are worked for a 70% stake, whatever the default.
  const settings = { trading: { spreadCostChargedPct: 0 }, steadyStake: { ...defaultBacktestSteadyStakeSettings, stakePct: 70, ...input.steadyStake } } as unknown as EffectiveBacktestSettings;
  return runSteadyStakeLook({
    todayIso: input.todayIso,
    calendar: calendarOf(input.todayIso),
    symbols: input.symbols,
    sectorBySymbol: new Map(input.symbols.map((symbol) => [symbol.profile.symbol, null])),
    settings,
    ledger: input.ledger,
    priceByLegId: input.priceByLegId ?? new Map(),
    nextActionId: () => `action-${++actionNumber}`,
  } as unknown as BacktestLookContext);
}

/** A ledger holding `cash` and `shares` shares bought at the stock price, their leg marked at it. */
function ledgerHolding(cash: number, shares: number): { ledger: SimulatedLedger; priceByLegId: Map<string, number> } {
  const ledger = createSimulatedLedger(cash + shares * (stockPrice + 0.005), easternInstant("2026-03-02", 9, 30));
  const priceByLegId = new Map<string, number>();
  if (shares > 0) {
    const bought = buyShares(ledger, { symbol: "STK", shares, fillPrice: stockPrice, at: easternInstant("2026-03-02", 10, 0), actionId: null, splitFactorToday: 1 });
    priceByLegId.set(bought.legId, stockPrice);
  }
  return { ledger, priceByLegId };
}

describe("buyShares", () => {
  it("adds the shares to the symbol's uncovered position at the fill plus the commission, records the trade and the cash, and opens the cycle", () => {
    const ledger = createSimulatedLedger(100_000, easternInstant("2026-03-02", 9, 30));
    const first = buyShares(ledger, { symbol: "STK", shares: 300, fillPrice: 100, at: easternInstant("2026-03-02", 10, 0), actionId: "a1", splitFactorToday: 1 });
    const second = buyShares(ledger, { symbol: "STK", shares: 100, fillPrice: 104, at: easternInstant("2026-03-03", 10, 0), actionId: "a2", splitFactorToday: 1 });
    // One unstructured position: 400 shares at the weighted average of (100 + 0.005) and (104 + 0.005).
    expect(second.positionId).toBe(first.positionId);
    const [position] = positionsOfSymbol(ledger, "STK");
    expect(position).toMatchObject({ strategyKey: "unstructured", status: "open", unstructuredReason: "shares_bought" });
    const [leg] = legsOfPosition(ledger, position!.id);
    expect(leg!.quantity).toBe(400);
    expect(leg!.entryPrice).toBeCloseTo((300 * 100.005 + 100 * 104.005) / 400, 10);
    expect(ledger.trades.map((trade) => [trade.side, trade.quantity, trade.price, trade.commission])).toEqual([
      ["buy", 300, 100, 1.5],
      ["buy", 100, 104, 0.5],
    ]);
    expect(ledger.cash).toBeCloseTo(100_000 - 30_000 - 1.5 - 10_400 - 0.5, 8);
    expect(ledgerFreeShares(ledger, "STK")).toBe(400);
    expect(ledgerOpenCycleSummary(ledger, "STK")).not.toBeNull();
  });
});

describe("runSteadyStakeLook", () => {
  it("buys shares up to the stake on a day without an expiry, and sells no option", async () => {
    const { ledger } = ledgerHolding(100_000, 0);
    const result = await look({ ledger, todayIso: mondayIso, symbols: [lookSymbolOf("STK", mondayIso, [])] });
    // 70% of $100,000 at $100 = 700 shares; the cash pays for them and their $3.50 commission.
    expect(result.actions.map((action) => [action.kind, action.quantity])).toEqual([["buy_shares", 700]]);
    expect(result.actions[0]!.description).toBe("STK Buy 700 shares @ 100.00 (stake 0.0% → 70.0% of the $100,000 pot, target 70% ± 5)");
    expect(result.optionSales).toEqual([]);
    expect(ledgerFreeShares(ledger, "STK")).toBe(700);
  });

  it("leaves the shares alone inside the band and sells back to the stake above it", async () => {
    // 740 shares of $100,000: 74%, inside 70% ± 5.
    const inside = ledgerHolding(26_000, 740);
    expect((await look({ ledger: inside.ledger, todayIso: mondayIso, symbols: [lookSymbolOf("STK", mondayIso, [])], priceByLegId: inside.priceByLegId })).actions).toEqual([]);
    // 800 shares of $100,000: 80%, above the band: 100 sold back to 70%.
    const above = ledgerHolding(20_000, 800);
    const result = await look({ ledger: above.ledger, todayIso: mondayIso, symbols: [lookSymbolOf("STK", mondayIso, [])], priceByLegId: above.priceByLegId });
    expect(result.actions.map((action) => [action.kind, action.quantity])).toEqual([["close_shares", 100]]);
    expect(ledgerFreeShares(above.ledger, "STK")).toBe(700);
  });

  it("on an expiry day sells today's Call nearest the Calls' |delta| on the free lots and today's Put nearest the Puts' on the pot's free cash", async () => {
    const { ledger, priceByLegId } = ledgerHolding(30_000, 700);
    const quotes = expiryDayQuotes(fridayIso);
    const result = await look({ ledger, todayIso: fridayIso, symbols: [lookSymbolOf("STK", fridayIso, quotes)], priceByLegId });
    const deltaOf = (strike: number, right: "C" | "P") => Math.abs(blackScholesDelta(stockPrice * Math.exp(riskFreeRate * yearsToClose), strike, yearsToClose, riskFreeRate, volatility, right === "C"));
    const nearest = (right: "C" | "P") => quotes.filter((quote) => quote.right === right).reduce((best, quote) => (Math.abs(deltaOf(quote.strike, right) - 0.2) < Math.abs(deltaOf(best.strike, right) - 0.2) ? quote : best));
    expect(result.actions.map((action) => [action.kind, action.contract?.strike, action.contract?.expiry, action.quantity])).toEqual([
      // 7 free lots get Calls; the pot's free cash (100,000 − 70,000 shares) secures floor(30,000 ÷ (strike × 100 − premium)) Puts.
      ["open_covered_call", nearest("C").strike, fridayIso, 7],
      ["open_cash_secured_put", nearest("P").strike, fridayIso, Math.floor(30_000 / ((nearest("P").strike - (nearest("P").bid! + nearest("P").ask!) / 2) * 100 + 0.68))],
    ]);
    for (const sale of result.optionSales) expect(Math.abs(Math.abs(sale.delta!) - 0.2)).toBeLessThanOrEqual(0.05);
    expect(ledgerFreeShares(ledger, "STK")).toBe(0);
    expect(ledgerFreeCash(ledger)).toBeLessThan(nearest("P").strike * 100);
  });

  it("fills the Calls down to the next nearest contract when the volume limit leaves lots uncovered, and sells none outside the tolerance", async () => {
    const { ledger, priceByLegId } = ledgerHolding(30_000, 700);
    // A previous-session volume of 15 allows 3 contracts per series: 3 + 3 + 1 across the three nearest Calls.
    const result = await look({ ledger, todayIso: fridayIso, symbols: [lookSymbolOf("STK", fridayIso, expiryDayQuotes(fridayIso), 15)], priceByLegId, steadyStake: { putCashPct: 0 } });
    const calls = result.actions.filter((action) => action.kind === "open_covered_call");
    expect(calls.reduce((sum, action) => sum + action.quantity!, 0)).toBeLessThanOrEqual(7);
    expect(calls.every((action) => action.quantity! <= 3)).toBe(true);
    for (const sale of result.optionSales) expect(Math.abs(Math.abs(sale.delta!) - 0.2)).toBeLessThanOrEqual(0.05);
    // A target far from every quoted |delta| sells nothing.
    const far = ledgerHolding(30_000, 700);
    const none = await look({ ledger: far.ledger, todayIso: fridayIso, symbols: [lookSymbolOf("STK", fridayIso, expiryDayQuotes(fridayIso))], priceByLegId: far.priceByLegId, steadyStake: { callAbsDelta: 0.97, putAbsDelta: 0.97, deltaTolerance: 0.01 } });
    expect(none.actions).toEqual([]);
  });

  it("gives each ticker of a shared account its equal share of the account as its pot", async () => {
    const { ledger } = ledgerHolding(100_000, 0);
    const result = await look({ ledger, todayIso: mondayIso, symbols: [lookSymbolOf("AAA", mondayIso, []), lookSymbolOf("BBB", mondayIso, [])], steadyStake: { stakePct: 60 } });
    // Each pot is $50,000: 60% = 300 shares each.
    expect(result.actions.map((action) => [action.symbol, action.kind, action.quantity])).toEqual([
      ["AAA", "buy_shares", 300],
      ["BBB", "buy_shares", 300],
    ]);
  });
});

describe("validateSteadyStakeSettings", () => {
  it("accepts the defaults and refuses values out of range", () => {
    expect(validateSteadyStakeSettings({ ...defaultBacktestSteadyStakeSettings })).toBeNull();
    expect(validateSteadyStakeSettings({ ...defaultBacktestSteadyStakeSettings, stakePct: 0 })).toBe("steadyStake.stakePct must be a number from 1 to 100.");
    expect(validateSteadyStakeSettings({ ...defaultBacktestSteadyStakeSettings, callCoveragePct: 120 })).toBe("steadyStake.callCoveragePct must be a number from 0 (no Calls) to 100.");
    expect(validateSteadyStakeSettings({ ...defaultBacktestSteadyStakeSettings, putAbsDelta: 1 })).toBe("steadyStake.putAbsDelta must be a number from 0.01 to 0.99.");
    expect(validateSteadyStakeSettings({ ...defaultBacktestSteadyStakeSettings, deltaTolerance: "0.05" })).toBe("steadyStake.deltaTolerance must be a number from 0.005 to 0.5.");
  });
});
