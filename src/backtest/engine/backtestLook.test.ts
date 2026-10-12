import { describe, expect, it } from "vitest";
import { easternInstant } from "../../lib/easternIsoDate.js";
import { volatilityModelTables } from "../../lib/volatilityModelTables.generated.js";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import type { BacktestPolicySettings, BacktestSettings } from "../backtestTypes.js";
import { BacktestBarHistory } from "./backtestBarHistory.js";
import { computeParityStockPrice, computeSaleFillPrice } from "./backtestBook.js";
import { runBacktestLook, type BacktestLookContext, type BacktestLookSymbol } from "./backtestLook.js";
import { decisionInstantMs, type BacktestTickerProfile } from "./backtestTickerInputs.js";
import { BacktestTradingCalendar } from "./backtestTradingCalendar.js";
import { openCashSecuredPut, settleExpiry } from "./ledger/ledgerEvents.js";
import { optionPurchaseFillPrice } from "./ledger/ledgerFills.js";
import { ledgerCycles, ledgerFreeCash, ledgerFreeShares, ledgerNetLiquidationValue, ledgerOpenCycleSummary } from "./ledger/ledgerSelectors.js";
import { createSimulatedLedger, cycleSplitFactorFor, isSymbolFlat, legsOfPosition, requireLeg, requirePosition, type SimulatedLedger } from "./ledger/simulatedLedger.js";
import { fixtureBacktestSettings, syntheticDailyBars, syntheticOptionQuotes, weekdaysBetween } from "./testSupport/syntheticBacktestData.js";
import { dollarsAfter } from "./testSupport/gateTextDollars.js";

// One 10:00 look on Monday 2 March 2026 with the stock at 100: synthetic bars with 25% realized volatility behind it,
// option quotes priced at a flat implied volatility (60% unless a test says otherwise, so every out-of-the-money option
// is rich), expiries 6, 13 and 20 March, strikes every dollar. Each test starts from the ledger it describes.

const todayIso = "2026-03-02";
const riskFreeRatePercent = 4;
const startingCash = 1_000_000;
const barRows = syntheticDailyBars(weekdaysBetween("2025-01-01", "2026-02-27"), 100, 0.25, 7, 0.5);
const bars = new BacktestBarHistory(barRows);
const expiries = ["2026-03-06", "2026-03-13", "2026-03-20"];
const quotesAt = (impliedVolatility: number) => syntheticOptionQuotes(todayIso, 100, expiries, impliedVolatility, riskFreeRatePercent / 100, 1, 15);
const richQuotes = quotesAt(0.6);
const cheapQuotes = quotesAt(0.15);
const calendar = new BacktestTradingCalendar(weekdaysBetween("2026-02-02", "2026-03-31").map((tradingDate) => ({ tradingDate, status: "complete" as const })), []);
const profile: BacktestTickerProfile = { tickerId: "ticker-1", symbol: "SYN", companyName: "Synthetic Co", sector: "Technology", valuationGroup: "stock", calendarChecksApply: true, earningsCalendarResolved: true, earnings: [], exDividends: [] };
const nowMs = decisionInstantMs(todayIso);
const tenAm = (dateIso: string) => easternInstant(dateIso, 10, 0);

function marketOf(quotes: ReturnType<typeof quotesAt>) {
  const volumes = new Map(quotes.map((quote) => [`${quote.expiry}|${quote.strike}|${quote.right}`, 1_000]));
  return { todayIso, quotes, openInterestByContract: volumes, previousSessionVolumeByContract: volumes as Map<string, number> | null, stockPrice: computeParityStockPrice(quotes, todayIso, riskFreeRatePercent / 100, null)!.price, riskFreeRatePercent: riskFreeRatePercent as number | null };
}

const adjustedDailyCloses = barRows.map((bar) => ({ date: bar.tradingDate, close: bar.close! }));

/** What a test changes of the one-symbol look: the symbol's day, the shared book and the session's settings. */
type LookOverrides = Partial<Pick<BacktestLookSymbol, "profile" | "market" | "splitFactorToday" | "optionContractsRepresentable" | "intraday" | "macroEvents">> &
  Partial<Pick<BacktestLookContext, "ledger" | "previousSessionDateIso" | "priceByLegId" | "lookTimeEt" | "filledActionsEarlierToday" | "opensBlockedBecause">> & { plutoOverrides?: Partial<PlutoSettings>; policy?: Partial<BacktestPolicySettings>; tradingOverrides?: Partial<BacktestSettings["trading"]> };

function lookSymbol(overrides: Partial<BacktestLookSymbol> = {}): BacktestLookSymbol {
  return { profile, bars, market: marketOf(richQuotes), splitFactorToday: 1, optionContractsRepresentable: true, adjustedDailyClosesBeforeToday: adjustedDailyCloses, ...overrides };
}

function sessionSettings(overrides: Pick<LookOverrides, "plutoOverrides" | "policy" | "tradingOverrides"> = {}) {
  const base = fixtureBacktestSettings(overrides.plutoOverrides);
  return applyBacktestOverrides({ ...base, trading: { ...base.trading, ...overrides.tradingOverrides } }, { policy: overrides.policy });
}

function lookContext(overrides: LookOverrides = {}): BacktestLookContext {
  const { plutoOverrides, policy, tradingOverrides, ledger, previousSessionDateIso, priceByLegId, lookTimeEt, filledActionsEarlierToday, opensBlockedBecause, ...symbolOverrides } = overrides;
  const symbol = lookSymbol(symbolOverrides);
  let actionCount = 0;
  return {
    todayIso,
    lookTimeEt,
    filledActionsEarlierToday,
    opensBlockedBecause,
    symbols: [symbol],
    sectorBySymbol: new Map([[symbol.profile.symbol, symbol.profile.sector]]),
    calendar,
    settings: sessionSettings({ plutoOverrides, policy, tradingOverrides }),
    modelTables: volatilityModelTables,
    ledger: ledger ?? createSimulatedLedger(startingCash, tenAm("2026-02-02")),
    previousSessionDateIso: previousSessionDateIso === undefined ? "2026-02-27" : previousSessionDateIso,
    priceByLegId: priceByLegId ?? new Map(),
    nextActionId: () => `action-${(actionCount += 1)}`,
  };
}

const midOf = (quotes: ReturnType<typeof quotesAt>, expiry: string, strike: number, right: "C" | "P") => {
  const quote = quotes.find((entry) => entry.expiry === expiry && entry.strike === strike && entry.right === right)!;
  return { bid: quote.bid!, ask: quote.ask!, mid: (quote.bid! + quote.ask!) / 2 };
};

/** A ledger holding 100 shares put to it at 95 on 20 February (a $95 put sold at 1.50 on 16 February, close 94). */
function ledgerWithAssignedShares(splitFactorAtOpen = 1): SimulatedLedger {
  const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
  const put = openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-02-20", strike: 95 * splitFactorAtOpen, contracts: 1, fillPrice: 1.5 * splitFactorAtOpen, at: tenAm("2026-02-16"), actionId: "earlier-action", splitFactorToday: splitFactorAtOpen });
  settleExpiry(ledger, { legId: put.legId, expiryClose: 94 * splitFactorAtOpen });
  return ledger;
}

describe("an open", () => {
  it("sells Pluto's top pick, sized within the order size, at mid − λ × half-spread, and the ledger takes the position", async () => {
    const context = lookContext();
    const look = await runBacktestLook(context);
    expect(look.fitIssueBySymbol.get("SYN")).toBeNull();
    expect(look.actions).toHaveLength(1);
    const action = look.actions[0]!;
    expect(action).toMatchObject({ actionId: "action-1", tradingDate: todayIso, passNumber: 1, symbol: "SYN", outcome: "filled", automatic: false, chosenBecause: "Pluto's top pick by Edge Yield", blockReason: null });
    expect(look.summary).toMatch(/^Opened SYN Sell \$\d+(\.\d+)? (Put|Call) · \d+ Mar \(\d+DTE\) · \d+× @ \d+\.\d\d/);
    expect(action.gateResults.every((gate) => gate.ok)).toBe(true);
    expect(action.gateResults.map((gate) => gate.gate)).toEqual(expect.arrayContaining(["verdict", "confidence_floor", "candidate_fresh", "ticker_cooldown", "open_positions_cap", "same_contract", "sizing", "limit_price", "order_limits"]));

    const sale = look.optionSales[0]!;
    expect(sale).toMatchObject({ actionId: "action-1", openedOn: todayIso, contracts: action.quantity, priceToCycleScale: 1 });
    expect(sale.fillPrice).toBeCloseTo(computeSaleFillPrice(sale.bid, sale.ask, 0.5), 12);
    expect(action.fillPrice).toBe(sale.fillPrice);
    expect(sale.commissionDollars).toBeCloseTo(0.68 * sale.contracts, 12);
    expect(Math.abs(sale.delta!)).toBeLessThanOrEqual(0.4);
    // Order size: 1,000,000 × 50% budget × 10% = $50,000 of EXP $ at most.
    expect(sale.contracts).toBeGreaterThanOrEqual(1);
    expect(sale.exposureDollars).toBeLessThanOrEqual(50_000);
    if (sale.strategyKey === "cash_secured_put") expect(sale.exposureDollars).toBeCloseTo((sale.strike - (sale.fillPrice - 0.0068)) * 100 * sale.contracts, 6);
    expect(sale.contracts).toBeLessThanOrEqual(sale.kellyContracts ?? Infinity);

    // The ledger: one open position on the contract, its leg at the fill net of the commission, the cash in.
    const position = requirePosition(context.ledger, action.positionIds[0]!);
    expect(position).toMatchObject({ symbol: "SYN", strategyKey: sale.strategyKey, status: "open", openedAt: new Date(nowMs) });
    const leg = requireLeg(context.ledger, sale.legId);
    expect(leg).toMatchObject({ side: "short", quantity: sale.contracts, strikePrice: sale.strike, expiryDate: sale.expiry, multiplier: 100 });
    expect(leg.entryPrice).toBeCloseTo(sale.fillPrice - 0.0068, 10);
    if (sale.strategyKey === "cash_secured_put") expect(context.ledger.cash).toBeCloseTo(startingCash + sale.fillPrice * 100 * sale.contracts - sale.commissionDollars, 6);
    // The new leg is marked at its 10:00 mid, so the account value only moved by the spread share and the commission.
    expect(context.priceByLegId.get(sale.legId)).toBeCloseTo((sale.bid + sale.ask) / 2, 12);
    expect(ledgerNetLiquidationValue(context.ledger, context.priceByLegId)).toBeCloseTo(startingCash - ((sale.bid + sale.ask) / 2 - sale.fillPrice) * 100 * sale.contracts - sale.commissionDollars - (sale.strategyKey === "covered_call" ? sale.contracts * 100 * 0.015 : 0), 4);
  });

  it("takes one open a look: the fill starts the ticker cooldown", async () => {
    const context = lookContext();
    await runBacktestLook(context);
    const again = await runBacktestLook(context);
    expect(again.actions).toEqual([]);
    expect(again.summary).toContain("opens_blocked");
    expect(context.ledger.positions).toHaveLength(1);
  });

  it("records the attempt the open-positions cap blocks", async () => {
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    for (const strike of [40, 41]) openCashSecuredPut(ledger, { symbol: "OTH", expiryDate: "2026-03-20", strike, contracts: 1, fillPrice: 0.5, at: tenAm("2026-02-23"), actionId: null, splitFactorToday: 1 });
    const look = await runBacktestLook(lookContext({ ledger, plutoOverrides: { maxOpenPositions: 2 } }));
    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]).toMatchObject({ outcome: "blocked", fillPrice: null, quantity: null });
    expect(look.actions[0]!.blockReason).toContain("open_positions_cap: 2 of 2 managed positions");
    expect(look.summary).toMatch(/^Blocked SYN Sell /);
    expect(look.optionSales).toEqual([]);
    expect(ledger.positions).toHaveLength(2);
  });

  it("applies the order gate's max position size from the trading settings", async () => {
    const context = lookContext({ tradingOverrides: { maxPositionPctOfPortfolio: 0.1 }, policy: { afterBlockedChoice: "stop" } });
    const look = await runBacktestLook(context);
    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]).toMatchObject({ outcome: "blocked" });
    expect(look.actions[0]!.blockReason).toMatch(/^order_limits: This order is .* above the 0\.1% max position size/);
    expect(look.actions[0]!.quantity).toBeGreaterThanOrEqual(1);
    expect(context.ledger.positions).toEqual([]);
  });

  it("refuses contracts with no previous-session volume (unknown volume fails Pluto's volume rule)", async () => {
    const look = await runBacktestLook(lookContext({ market: { ...marketOf(richQuotes), previousSessionVolumeByContract: null } }));
    expect(look.actions).toEqual([]);
    expect(look.summary).toMatch(/^No action: .*volume/);
  });

  it("skips expiries spanning a known earnings date", async () => {
    const look = await runBacktestLook(lookContext({ profile: { ...profile, earnings: [{ dateIso: "2026-03-03", eventTime: null }] } }));
    expect(look.actions).toEqual([]);
    expect(look.summary).toContain("span earnings");
  });

  it("reports a day whose quotes cannot be fitted", async () => {
    const look = await runBacktestLook(lookContext({ market: { ...marketOf(richQuotes), riskFreeRatePercent: null } }));
    expect(look.actions).toEqual([]);
    expect(look.fitIssueBySymbol.get("SYN")).toBe("no_risk_free_rate");
    expect(look.summary).toContain("no_surface_fit");
  });
});

describe("shares put to the book", () => {
  // 100 shares at 95 with 149.32 of put premium: break-even 93.5068. At 100 the cycle is up 149.32 + 500 = 649.32,
  // over the floor of max(1% × 9,500, 50) = 95, and the shares are older than one full session.
  it("sells a call on them when one clears the break-even rule: no share changes hands", async () => {
    const context = lookContext({ ledger: ledgerWithAssignedShares() });
    const sharesPosition = context.ledger.positions.find((position) => position.status === "open")!;
    const tradeCountBefore = context.ledger.trades.length;
    const look = await runBacktestLook(context);

    expect(look.actions).toHaveLength(1);
    const action = look.actions[0]!;
    expect(action).toMatchObject({ kind: "open_covered_call", outcome: "filled", quantity: 1, chosenBecause: "shares in profit above the floor: a call on them clears the break-even rule" });
    expect(action.description).toContain("on 100 held shares");
    expect(action.gateResults.find((gate) => gate.gate === "break_even")).toMatchObject({ ok: true });
    expect(action.candidateScores).toMatchObject({ heldShares: { contracts: 1 } });
    expect(sharesPosition).toMatchObject({ status: "closed", closeReason: "stock_rolled_into_covered_call" });
    const coveredCall = requirePosition(context.ledger, action.positionIds[0]!);
    expect(coveredCall).toMatchObject({ strategyKey: "covered_call", status: "open" });
    expect(legsOfPosition(context.ledger, coveredCall.id).find((leg) => leg.legType === "stock")).toMatchObject({ quantity: 100, entryPrice: 95, exitAt: null });
    expect(context.ledger.trades.length).toBe(tradeCountBefore + 1);
    expect(ledgerFreeShares(context.ledger, "SYN")).toBe(0);
    // The call's strike leaves the cycle above its break-even plus the floor if assigned.
    const sale = look.optionSales[0]!;
    expect(sale).toMatchObject({ strategyKey: "covered_call", optionRight: "C", contracts: 1, sharePriceAtOpen: marketOf(richQuotes).stockPrice });
    expect((sale.strike - (93.5068 - (sale.fillPrice - 0.0068))) * 100).toBeGreaterThanOrEqual(95);
    // EXP $ is what Positions shows for the covered call: the shares at their cost in the book less the premium.
    expect(sale.exposureDollars).toBeCloseTo(95 * 100 - (sale.fillPrice - 0.0068) * 100, 6);
    expect(ledgerOpenCycleSummary(context.ledger, "SYN")!.breakEvenPerShare).toBeCloseTo(93.5068 - (sale.fillPrice - 0.0068), 6);
  });

  it("sells them when no call is worth selling", async () => {
    // Options priced at 15% volatility against a 25% forecast: no call has a positive edge.
    const context = lookContext({ ledger: ledgerWithAssignedShares(), market: marketOf(cheapQuotes) });
    const sharesPosition = context.ledger.positions.find((position) => position.status === "open")!;
    const stockPrice = context.symbols[0]!.market.stockPrice;
    const cashBefore = context.ledger.cash;
    const look = await runBacktestLook(context);

    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]).toMatchObject({ kind: "close_shares", outcome: "filled", automatic: false, quantity: 100, chosenBecause: "shares in profit above the floor: no call on them clears the break-even rule", positionIds: [sharesPosition.id] });
    expect(look.actions[0]!.fillPrice).toBeCloseTo(stockPrice - 0.01, 10);
    expect(look.actions[0]!.gateResults.find((gate) => gate.gate === "close_gate")).toMatchObject({ ok: true });
    expect(look.summary).toMatch(/^Closed SYN Sell 100 shares @ /);
    expect(sharesPosition).toMatchObject({ status: "closed", closeReason: "closed_via_app" });
    expect(context.ledger.cash).toBeCloseTo(cashBefore + (stockPrice - 0.01) * 100 - 0.5, 6);
    expect(isSymbolFlat(context.ledger, "SYN")).toBe(true);
    // The cycle closed with the put's premium and the shares' gain: 149.32 + (price − 0.01 − 95) × 100 − 0.50.
    const cycle = ledgerCycles(context.ledger, "SYN", { dailyCloses: adjustedDailyCloses.map((bar) => ({ ...bar })) })[0]!;
    expect(cycle).toMatchObject({ status: "closed", dataFlags: [] });
    expect(cycle.total).toBeCloseTo(149.32 + (stockPrice - 0.01 - 95) * 100 - 0.5, 6);
  });

  it("sells them at once when the rule is to always sell, and keeps them when the shares are younger than one session", async () => {
    const selling = await runBacktestLook(lookContext({ ledger: ledgerWithAssignedShares(), policy: { sharesInProfit: "always_sell" } }));
    expect(selling.actions[0]).toMatchObject({ kind: "close_shares", outcome: "filled", chosenBecause: "shares in profit above the floor: the rule is to sell them" });

    // Seen from the session of 23 February, the shares put to the book on the 20th are not yet a full session old: no
    // sale is offered, and with cheap options nothing else is either.
    const young = await runBacktestLook(lookContext({ ledger: ledgerWithAssignedShares(), market: marketOf(cheapQuotes), policy: { sharesInProfit: "always_sell" }, previousSessionDateIso: "2026-02-20" }));
    expect(young.actions).toEqual([]);
    expect(young.summary).toMatch(/^No action: /);
  });

  it("keeps a cycle that spans a split on its own scale: ten of today's contracts cover the hundred shares", async () => {
    // The cycle began before a 10-for-1 split: the ledger holds 100 shares at 950; today that is 1,000 shares at 95.
    const context = lookContext({ ledger: ledgerWithAssignedShares(10) });
    expect(cycleSplitFactorFor(context.ledger, "SYN", 1)).toBe(10);
    const look = await runBacktestLook(context);

    const action = look.actions[0]!;
    expect(action).toMatchObject({ kind: "open_covered_call", outcome: "filled", quantity: 10 });
    expect(action.description).toContain("on 1000 held shares");
    const sale = look.optionSales[0]!;
    expect(sale).toMatchObject({ contracts: 10, priceToCycleScale: 10 });
    expect(sale.strike).toBeLessThan(130);
    const callLeg = requireLeg(context.ledger, sale.legId);
    expect(callLeg).toMatchObject({ quantity: 10, multiplier: 10 });
    expect(callLeg.strikePrice).toBeCloseTo(sale.strike * 10, 8);
    // Premium in dollars is what was traded today: fill × 100 × 10 contracts, less 10 commissions.
    expect(callLeg.entryPrice * callLeg.quantity * callLeg.multiplier).toBeCloseTo(sale.fillPrice * 100 * 10 - 6.8, 6);
    const coveredCall = requirePosition(context.ledger, callLeg.positionId);
    expect(legsOfPosition(context.ledger, coveredCall.id).find((leg) => leg.legType === "stock")).toMatchObject({ quantity: 100, entryPrice: 950 });
    expect(context.priceByLegId.get(sale.legId)).toBeCloseTo(((sale.bid + sale.ask) / 2) * 10, 10);
    expect(ledgerFreeShares(context.ledger, "SYN")).toBe(0);
  });
});

describe("a held put", () => {
  it("is bought back when holding no longer pays, at mid + λ × half-spread", async () => {
    // A $99 put for 13 March sold at 2.50 a week ago; today options trade at 15% volatility against a 25% forecast, so
    // the put is worth less than the model's fair value and holding it no longer pays its closing cost.
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    const put = openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 99, contracts: 2, fillPrice: 2.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const context = lookContext({ ledger, market: marketOf(cheapQuotes) });
    const quote = midOf(cheapQuotes, "2026-03-13", 99, "P");
    const cashBefore = ledger.cash;
    const look = await runBacktestLook(context);

    expect(look.actions).toHaveLength(1);
    const action = look.actions[0]!;
    expect(action).toMatchObject({ kind: "close_leg", outcome: "filled", automatic: false, quantity: 2, chosenBecause: "holding the put no longer pays its closing cost", positionIds: [put.positionId], contract: { strategyKey: "cash_secured_put", expiry: "2026-03-13", strike: 99, right: "P" } });
    const fill = optionPurchaseFillPrice(quote.bid, quote.ask, 0.5);
    expect(action.fillPrice).toBeCloseTo(fill, 12);
    expect(requireLeg(ledger, put.legId)).toMatchObject({ exitAt: new Date(nowMs) });
    expect(requireLeg(ledger, put.legId).exitPrice).toBeCloseTo(fill, 12);
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closeReason: "closed_via_app" });
    expect(ledger.cash).toBeCloseTo(cashBefore - fill * 200 - 1.36, 6);
    expect(look.summary).toMatch(/^Closed SYN Buy back \$99 Put · 13 Mar/);
  });

  it("is left alone when the rule is never to buy back", async () => {
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 99, contracts: 2, fillPrice: 2.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const look = await runBacktestLook(lookContext({ ledger, market: marketOf(cheapQuotes), policy: { buyback: "never" } }));
    expect(look.actions).toEqual([]);
    expect(look.summary).toContain("the rule is never to buy back");
  });

  it("is quoted from the day's file when the capture would not have stored it, and rolled when a roll is eligible on a flagged leg", async () => {
    // A $97 put expiring on Friday sold at 1.50: four days out, so flagged near expiry. Rolling it to a later, lower-delta
    // put for a net credit beats holding it; a roll comes before any new open.
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    const put = openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-06", strike: 97, contracts: 3, fillPrice: 1.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const context = lookContext({ ledger });
    const held = midOf(richQuotes, "2026-03-06", 97, "P");
    const cashBefore = ledger.cash;
    const look = await runBacktestLook(context);

    expect(look.actions).toHaveLength(1);
    const action = look.actions[0]!;
    expect(action).toMatchObject({ kind: "roll", outcome: "filled", quantity: 3, contract: { strategyKey: "cash_secured_put", right: "P", fromStrike: 97, fromExpiry: "2026-03-06" } });
    expect(action.chosenBecause).toContain("flagged near expiry");
    expect(look.summary).toMatch(/^Rolled SYN Roll \$97 Put · 6 Mar → \$\d+(\.\d+)? Put · \d+ Mar \(\d+DTE\) · 3× @ /);
    const sale = look.optionSales[0]!;
    expect(sale.expiry > "2026-03-06").toBe(true);
    expect(Math.abs(sale.delta!)).toBeLessThanOrEqual(0.4);
    // The old leg is bought back at mid + λ × half-spread and its position closed; the new contract is a new position.
    const buyback = optionPurchaseFillPrice(held.bid, held.ask, 0.5);
    expect(requireLeg(ledger, put.legId).exitPrice).toBeCloseTo(buyback, 12);
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closeReason: "closed_via_app" });
    expect(action.positionIds[0]).toBe(put.positionId);
    expect(requirePosition(ledger, action.positionIds[1]!)).toMatchObject({ strategyKey: "cash_secured_put", status: "open" });
    expect(requireLeg(ledger, sale.legId)).toMatchObject({ quantity: 3, strikePrice: sale.strike, expiryDate: sale.expiry });
    expect(ledger.cash).toBeCloseTo(cashBefore - buyback * 300 - 2.04 + sale.fillPrice * 300 - 2.04, 6);
    // A net credit at the mids, as a roll must be.
    expect((sale.bid + sale.ask) / 2).toBeGreaterThan(held.mid);
    // One cycle through the roll.
    expect(ledgerCycles(ledger, "SYN", { dailyCloses: [] })).toHaveLength(1);
  });

  it("is not rolled when the rule is never to roll: the pass goes on to an open", async () => {
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-06", strike: 97, contracts: 3, fillPrice: 1.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const look = await runBacktestLook(lookContext({ ledger, policy: { roll: "never" } }));
    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]!.kind).toMatch(/^open_/);
    expect(look.actions[0]!.outcome).toBe("filled");
  });

  it("is bought back by code before an earnings report it would be held through", async () => {
    // An ETF's calendar is not checked when a put is sold, but a stray earnings row still triggers the close before it,
    // as live: the report is after Thursday's close, four sessions away, and the $95 put for 13 March shows a profit.
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    const put = openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 95, contracts: 1, fillPrice: 2.4, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const etfProfile: BacktestTickerProfile = { ...profile, sector: "ETF", valuationGroup: "etf", calendarChecksApply: false, earnings: [{ dateIso: "2026-03-05", eventTime: "1" }] };
    const look = await runBacktestLook(lookContext({ ledger, profile: etfProfile, policy: { roll: "never" } }));

    const automatic = look.actions[0]!;
    expect(automatic).toMatchObject({ kind: "close_leg", automatic: true, outcome: "filled", passNumber: 1, positionIds: [put.positionId] });
    expect(automatic.chosenBecause).toContain("Formula P3");
    expect(automatic.gateResults[0]).toMatchObject({ gate: "automatic_close", ok: true });
    expect(requirePosition(ledger, put.positionId)).toMatchObject({ status: "closed", closeReason: "closed_via_app" });
    expect(look.summary).toContain("(automatic)");
    // The fill starts the ticker cooldown: the second pass offers no open.
    expect(look.actions).toHaveLength(1);
  });
});

describe("a choice the gates refuse", () => {
  // The book already holds a put on another ticker and its open-positions cap is 1: Pluto's gate refuses any new open.
  const cappedBook = (policy: Partial<BacktestPolicySettings> = {}) => {
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    openCashSecuredPut(ledger, { symbol: "OTH", expiryDate: "2026-03-20", strike: 40, contracts: 1, fillPrice: 0.5, at: tenAm("2026-02-23"), actionId: null, splitFactorToday: 1 });
    return lookContext({ ledger, plutoOverrides: { maxOpenPositions: 1 }, policy });
  };

  it("ends the look when the session's rule is to stop", async () => {
    const context = cappedBook({ afterBlockedChoice: "stop" });
    const look = await runBacktestLook(context);
    expect(look.actions).toHaveLength(1);
    // Pluto's top pick: a put, or a call that buys its shares (no shares are held), both new positions.
    expect(look.actions[0]).toMatchObject({ outcome: "blocked", passNumber: 1 });
    expect(look.actions[0]!.kind).toMatch(/^open_(cash_secured_put|covered_call)$/);
    expect(look.actions[0]!.blockReason).toBe("open_positions_cap: 1 of 1 managed positions");
    expect(look.summary).toMatch(/^Blocked SYN Sell \$\d+(\.\d+)? (Put|Call) · \d+ Mar \(\d+DTE\): open_positions_cap: 1 of 1 managed positions$/);
    // Stopping is not "no room": nothing is said about further opens.
    expect(look.opensStopped).toEqual([]);
    expect(context.ledger.positions.map((position) => position.symbol)).toEqual(["OTH"]);
  });

  it("by default ends the opens on every ticker when the refusal says the book has no room: no other open is tried", async () => {
    const context = cappedBook();
    expect(context.settings.policy.afterBlockedChoice).toBe("try_next");
    const look = await runBacktestLook(context);
    // The open-positions cap is the book's: the one refusal is enough, although SYN has many other eligible opens.
    expect(look.actions).toHaveLength(1);
    expect(look.actions[0]).toMatchObject({ outcome: "blocked", blockReason: "open_positions_cap: 1 of 1 managed positions" });
    expect(look.actions[0]!.kind).toMatch(/^open_/);
    expect(look.scoredBySymbol.get("SYN")!.candidates.length).toBeGreaterThan(5);
    expect(look.opensStopped).toEqual(["no further opens: the open-positions cap is reached"]);
    expect(look.summary).toMatch(/^Blocked SYN Sell .*: open_positions_cap: 1 of 1 managed positions · no further opens: the open-positions cap is reached$/);
    expect(look.summaryOfActions).toMatch(/managed positions$/);
  });

  it("does not count a call on shares already held against the open-positions cap", async () => {
    // 100 shares in profit with the cap at 1: the share position counts, but a call on it adds no new exposure.
    const context = lookContext({ ledger: ledgerWithAssignedShares(), plutoOverrides: { maxOpenPositions: 1 } });
    const look = await runBacktestLook(context);
    expect(look.actions.map((action) => [action.kind, action.outcome])).toEqual([["open_covered_call", "filled"]]);
    expect(look.actions[0]!.gateResults.find((gate) => gate.gate === "open_positions_cap")).toMatchObject({ ok: true, detail: "a call on shares already held adds no new exposure (1 of 1 managed positions)" });
    expect(ledgerFreeShares(context.ledger, "SYN")).toBe(0);
  });

  it("tries the next candidate after a refusal that is about the contract itself", async () => {
    // Pluto's top pick traded one contract the day before, so its volume cap (20% of that) sizes it to zero; the
    // account has room, and the next candidate is sold.
    const topPick = (await runBacktestLook(lookContext())).optionSales[0]!;
    const market = marketOf(richQuotes);
    const volumes = new Map(market.previousSessionVolumeByContract!);
    volumes.set(`${topPick.expiry}|${topPick.strike}|${topPick.optionRight}`, 1);
    const context = lookContext({ market: { ...market, previousSessionVolumeByContract: volumes } });
    const look = await runBacktestLook(context);
    expect(look.actions.map((action) => action.outcome)).toEqual(["blocked", "filled"]);
    expect(look.actions[0]).toMatchObject({ contract: { expiry: topPick.expiry, strike: topPick.strike, right: topPick.optionRight } });
    expect(look.actions[0]!.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
    expect(look.actions[0]!.blockReason).toContain("volume share allows 0");
    expect(look.actions[1]!.contract).not.toEqual(look.actions[0]!.contract);
    expect(look.opensStopped).toEqual([]);
  });
});

describe("an open the event-close rule would close at once", () => {
  // 100 shares put to the book at 95, the stock now at 100: the wheel cycle is in profit. CPI on Wednesday 4 March, two
  // sessions away, before every expiry offered: a covered call opened now would at once be offered the event close.
  const cpi = [{ dateIso: "2026-03-04", eventAtIso: easternInstant("2026-03-04", 8, 30).toISOString(), title: "CPI" }];
  const lookBefore = (eventClose: BacktestPolicySettings["eventClose"]) => lookContext({ ledger: ledgerWithAssignedShares(), macroEvents: cpi, policy: { sharesInProfit: "always_keep", eventClose } });

  it("is skipped by the rules, with why, and the next candidate is chosen", async () => {
    const context = lookBefore("always");
    const look = await runBacktestLook(context);
    // No call is sold on the shares: each one the rules chose was skipped; Pluto's next pick, a put, is sold instead.
    expect(look.actions.map((action) => [action.kind, action.outcome])).toEqual([["open_cash_secured_put", "filled"]]);
    expect(look.summary).toMatch(/^Opened SYN Sell \$\d+(\.\d+)? Put .* · skipped SYN Sell \$\d+(\.\d+)? Call · \d+ Mar \(\d+DTE\) · \d+× @ \d+\.\d\d: the event-close rule would close it at once before the 4 Mar CPI \(heavy, 2 sessions away\): the rule is to close/);
    // The copy of the book the skipped calls were judged on left the session's own untouched: the shares are still free.
    expect(ledgerFreeShares(context.ledger, "SYN")).toBe(100);
    expect(context.ledger.positions.filter((position) => position.strategyKey === "covered_call")).toEqual([]);
  });

  it("is kept when what is left to earn exceeds the event's stress loss (the default rule)", async () => {
    // The call Pluto picks is out of the money: a 2-normal-day fall on CPI costs less than the strike distance and the premium left.
    const look = await runBacktestLook(lookBefore("stress_vs_remaining"));
    expect(look.actions.map((action) => [action.kind, action.outcome])).toEqual([["open_covered_call", "filled"]]);
    expect(look.summary).not.toContain("skipped");
  });

  it("is opened as before when the rule is never to close for events", async () => {
    const context = lookBefore("never");
    const look = await runBacktestLook(context);
    expect(look.actions.map((action) => [action.kind, action.outcome])).toEqual([["open_covered_call", "filled"]]);
    expect(look.actions[0]!.description).toContain("on 100 held shares");
    expect(look.summary).not.toContain("skipped");
  });
});

describe("an open larger than the order size", () => {
  it("leaves out only that contract: the next ones on the same ticker are tried until one fits", async () => {
    // Order size: 1,000,000 × 50% budget × 1.86% = $9,300; a put's contract commits (strike − premium) × 100, a call
    // that buys its shares (stock − premium) × 100: the top picks are each a little larger, a lower strike fits.
    const context = lookContext({ plutoOverrides: { orderSizePctOfBudget: 1.86 } });
    const look = await runBacktestLook(context);
    const refused = look.actions.slice(0, -1);
    const filled = look.actions.at(-1)!;
    expect(refused.length).toBeGreaterThan(1);
    for (const action of refused) {
      expect(action).toMatchObject({ outcome: "blocked", symbol: "SYN" });
      expect(action.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
      expect(action.blockReason).toContain("order size $9,300");
    }
    expect(filled).toMatchObject({ outcome: "filled", symbol: "SYN", kind: "open_cash_secured_put", quantity: 1 });
    expect((filled.contract!.strike! - filled.limitPrice!) * 100).toBeLessThanOrEqual(9_300);
    expect(new Set(look.actions.map((action) => action.candidateId)).size).toBe(look.actions.length);
    // No "no further opens on SYN": the refusals were about the contracts.
    expect(look.opensStopped).toEqual([]);
    expect(look.summary).toMatch(new RegExp(`· Opened SYN Sell \\$${filled.contract!.strike} Put .* · ${refused.length - 1} more refused choice\\(s\\): SYN ${refused.length - 1} \\(sizing\\)$`));
  });
});

describe("when every offer is refused", () => {
  it("tries each once under the choose-again rule, and the day's line counts them", async () => {
    // The order gate's max position size is $1,000: no order fits.
    const context = lookContext({ tradingOverrides: { maxPositionPctOfPortfolio: 0.1 }, policy: { afterBlockedChoice: "try_next" } });
    const look = await runBacktestLook(context);
    expect(look.actions.length).toBeGreaterThan(5);
    expect(look.actions.every((action) => action.outcome === "blocked" && action.fillPrice === null)).toBe(true);
    expect(new Set(look.actions.map((action) => action.candidateId)).size).toBe(look.actions.length);
    expect(look.actions.map((action) => action.passNumber)).toEqual(look.actions.map((_, index) => index + 1));
    expect(look.optionSales).toEqual([]);
    expect(context.ledger.positions).toEqual([]);
    expect(look.summary).toMatch(new RegExp(`^Blocked SYN Sell [^·]*· [^·]*· \\d+× @ [^·]* · ${look.actions.length - 1} more refused choice\\(s\\): SYN ${look.actions.length - 1} \\((order_limits|sizing|, )+\\)$`));
  });
});

describe("a symbol sold flat and reopened in the same look", () => {
  it("stays in its wheel cycle, on the cycle's price scale, as the platform's cycle derivation counts it", async () => {
    // With no ticker cooldown a later pass may open again at once. The cycle began before a 10-for-1 split (100 shares
    // at 950 in the book, 1,000 at 95 as traded today): the shares are sold, and the put sold in the next pass is put on
    // that same scale, because the platform keeps one cycle when a close and an open are within two minutes.
    const context = lookContext({ ledger: ledgerWithAssignedShares(10), policy: { sharesInProfit: "always_sell" }, plutoOverrides: { tickerCooldownMinutes: 0 } });
    const look = await runBacktestLook(context);

    const filled = look.actions.filter((action) => action.outcome === "filled");
    expect(filled.length).toBeGreaterThanOrEqual(2);
    expect(filled[0]).toMatchObject({ kind: "close_shares", passNumber: 1, quantity: 1000 });
    expect(filled[1]!.kind).toMatch(/^open_/);
    expect(filled[1]!.passNumber).toBe(2);
    const sale = look.optionSales[0]!;
    expect(sale.priceToCycleScale).toBe(10);
    expect(cycleSplitFactorFor(context.ledger, "SYN", 1)).toBe(10);
    const leg = requireLeg(context.ledger, sale.legId);
    expect(leg.multiplier).toBe(10);
    expect(leg.quantity).toBe(sale.contracts);
    expect(leg.strikePrice).toBeCloseTo(sale.strike * 10, 8);
    // One cycle from the put of 16 February, still open.
    const cycles = ledgerCycles(context.ledger, "SYN", { dailyCloses: [] });
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ status: "open", startAt: tenAm("2026-02-16") });
  });

  it("starts a new cycle on today's scale when it is reopened at a later look", async () => {
    const ledger = ledgerWithAssignedShares(10);
    const selling = lookContext({ ledger, policy: { sharesInProfit: "always_sell" } });
    await runBacktestLook(selling);
    expect(isSymbolFlat(ledger, "SYN")).toBe(true);
    // The next session's look: the same quotes a day later.
    openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 95, contracts: 1, fillPrice: 2.4, at: tenAm("2026-03-03"), actionId: "next-day", splitFactorToday: 1 });
    expect(cycleSplitFactorFor(ledger, "SYN", 1)).toBe(1);
    expect(ledgerCycles(ledger, "SYN", { dailyCloses: [] }).map((cycle) => cycle.status)).toEqual(["closed", "open"]);
  });
});

describe("several symbols on one book", () => {
  // SYN's options are priced at 60% volatility and ALT's at 90%, against the same 25% history: ALT's best contract has
  // the higher Edge Yield, so Pluto's top pick across the two is on ALT.
  const altProfile: BacktestTickerProfile = { ...profile, tickerId: "ticker-2", symbol: "ALT", companyName: "Alternative Co" };
  const veryRichQuotes = quotesAt(0.9);
  function twoSymbolLook(overrides: Pick<LookOverrides, "plutoOverrides" | "policy" | "tradingOverrides"> & { altSector?: string | null } = {}): BacktestLookContext {
    const alt = lookSymbol({ profile: { ...altProfile, sector: overrides.altSector === undefined ? profile.sector : overrides.altSector }, market: marketOf(veryRichQuotes) });
    const syn = lookSymbol();
    let actionCount = 0;
    return {
      todayIso,
      symbols: [syn, alt],
      sectorBySymbol: new Map([
        ["SYN", syn.profile.sector],
        ["ALT", alt.profile.sector],
      ]),
      calendar,
      settings: sessionSettings(overrides),
      modelTables: volatilityModelTables,
      ledger: createSimulatedLedger(startingCash, tenAm("2026-02-02")),
      previousSessionDateIso: "2026-02-27",
      priceByLegId: new Map(),
      nextActionId: () => `action-${(actionCount += 1)}`,
    };
  }
  const edgeYieldOf = (action: { candidateScores: Record<string, unknown> | null }) => (action.candidateScores as { model: { expectedAnnualizedReturn: number } }).model.expectedAnnualizedReturn;

  it("opens Pluto's top pick across the symbols, then the other symbol's: the cooldown after a fill is per ticker", async () => {
    const context = twoSymbolLook();
    const look = await runBacktestLook(context);

    expect(look.actions.map((action) => [action.passNumber, action.symbol, action.outcome])).toEqual([
      [1, "ALT", "filled"],
      [2, "SYN", "filled"],
    ]);
    expect(look.actions.every((action) => action.chosenBecause === "Pluto's top pick by Edge Yield")).toBe(true);
    // ALT's pick ranked above everything on SYN; once ALT cools down, SYN's own best is next.
    expect(edgeYieldOf(look.actions[0]!)).toBeGreaterThan(edgeYieldOf(look.actions[1]!));
    expect(look.optionSales.map((sale) => sale.symbol)).toEqual(["ALT", "SYN"]);
    expect(context.ledger.positions.map((position) => position.symbol)).toEqual(["ALT", "SYN"]);
    // One cash balance: both premiums land in it.
    expect(context.ledger.cash).toBeCloseTo(startingCash + look.optionSales.reduce((sum, sale) => sum + (sale.strategyKey === "cash_secured_put" ? sale.fillPrice * 100 * sale.contracts - sale.commissionDollars : 0), 0) - look.optionSales.reduce((sum, sale) => sum + (sale.strategyKey === "covered_call" ? sale.contracts * 100 * (sale.spotAtOpen + 0.015) - (sale.fillPrice * 100 * sale.contracts - sale.commissionDollars) : 0), 0), 4);
    expect(look.summary).toMatch(/^Opened ALT Sell .* · Opened SYN Sell /);
    // A third pass found both cooling down and nothing else to do.
    expect(look.scoredBySymbol.get("ALT")!.symbol).toBe("ALT");
    expect([...look.fitIssueBySymbol.entries()]).toEqual([
      ["SYN", null],
      ["ALT", null],
    ]);
  });

  it("names each symbol when nothing is done", async () => {
    const context = twoSymbolLook();
    context.symbols = context.symbols.map((symbol) => ({ ...symbol, market: { ...symbol.market, previousSessionVolumeByContract: null } }));
    const look = await runBacktestLook(context);
    expect(look.actions).toEqual([]);
    expect(look.summary).toMatch(/^No action: SYN: \d+ candidates, none eligible \(rejected by volume \d+.*\) \| ALT: \d+ candidates, none eligible \(rejected by volume \d+/);
  });

  it("shares the capital budget: the first order uses it up and the other symbol's is refused for lack of budget", async () => {
    // Budget 5% of $1,000,000 = $50,000, order size all of it: ALT's order takes about $47,000 of EXP $.
    const context = twoSymbolLook({ plutoOverrides: { capitalBudgetPct: 5, orderSizePctOfBudget: 100 } });
    const look = await runBacktestLook(context);

    expect(look.actions.map((action) => [action.symbol, action.outcome])).toEqual([
      ["ALT", "filled"],
      ["SYN", "blocked"],
    ]);
    const refused = look.actions[1]!;
    expect(refused.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
    const budgetLeft = dollarsAfter("budget left", refused.blockReason!);
    const contractCost = Number((/contract\(s\) at \$([\d,]+) each|buying 100 shares each at ([\d.]+)/.exec(refused.blockReason!)![1] ?? "0").replaceAll(",", ""));
    expect(budgetLeft).toBeLessThan(10_000);
    expect(budgetLeft).toBeCloseTo(50_000 - look.optionSales[0]!.exposureDollars, -3);
    if (contractCost > 0) expect(budgetLeft).toBeLessThan(contractCost);
    expect(context.ledger.positions.map((position) => position.symbol)).toEqual(["ALT"]);
    expect(look.summary).toMatch(/^Opened ALT Sell .* · Blocked SYN Sell .*: sizing: /);
  });

  it("shares the open-positions cap: with room for one position, the second symbol's order is refused", async () => {
    const look = await runBacktestLook(twoSymbolLook({ plutoOverrides: { maxOpenPositions: 1 } }));
    expect(look.actions.map((action) => [action.symbol, action.outcome, action.blockReason])).toEqual([
      ["ALT", "filled", null],
      ["SYN", "blocked", "open_positions_cap: 1 of 1 managed positions"],
    ]);
    expect(look.opensStopped).toEqual(["no further opens: the open-positions cap is reached"]);
  });

  it("ends the opens on a ticker with no room and goes on to the other ticker", async () => {
    // ALT already carries a $95,000 put position, above its 5% ticker limit ($50,000): its best contract is refused for
    // lack of ticker room, no other ALT contract is tried, and SYN's is sold.
    const context = twoSymbolLook({ plutoOverrides: { maxTickerExposurePct: 5 } });
    openCashSecuredPut(context.ledger, { symbol: "ALT", expiryDate: "2026-03-20", strike: 95, contracts: 10, fillPrice: 2, at: tenAm("2026-02-23"), actionId: null, splitFactorToday: 1 });
    const look = await runBacktestLook(context);
    expect(look.actions.map((action) => [action.symbol, action.outcome])).toEqual([
      ["ALT", "blocked"],
      ["SYN", "filled"],
    ]);
    expect(look.actions[0]!.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
    expect(look.opensStopped).toEqual(["no further opens on ALT: no ticker room"]);
    expect(look.summary).toMatch(/^Blocked ALT Sell .* · Opened SYN Sell .* · no further opens on ALT: no ticker room$/);
  });

  it("caps a sector across its symbols: the second order in the same sector is refused, one in another sector is not", async () => {
    // Sector cap 5% of the account = $50,000; ALT's order takes about $47,000 of it.
    const sameSector = await runBacktestLook(twoSymbolLook({ plutoOverrides: { maxSectorExposurePct: 5 } }));
    expect(sameSector.actions.map((action) => [action.symbol, action.outcome])).toEqual([
      ["ALT", "filled"],
      ["SYN", "blocked"],
    ]);
    const refused = sameSector.actions[1]!;
    expect(refused.gateResults.filter((gate) => !gate.ok).map((gate) => gate.gate)).toEqual(["sizing"]);
    const sectorRoom = dollarsAfter("sector room", refused.blockReason!);
    expect(sectorRoom).toBeCloseTo(50_000 - sameSector.optionSales[0]!.exposureDollars, -3);
    expect(sectorRoom).toBeLessThan(10_000);
    // The ticker's own room and the budget were not what stopped it.
    expect(dollarsAfter("ticker room", refused.blockReason!)).toBeGreaterThan(40_000);
    expect(dollarsAfter("budget left", refused.blockReason!)).toBeGreaterThan(400_000);

    const otherSector = await runBacktestLook(twoSymbolLook({ plutoOverrides: { maxSectorExposurePct: 5 }, altSector: "Healthcare" }));
    expect(otherSector.actions.map((action) => [action.symbol, action.outcome])).toEqual([
      ["ALT", "filled"],
      ["SYN", "filled"],
    ]);
  });

  it("counts the session's actions cap across the symbols", async () => {
    const look = await runBacktestLook(twoSymbolLook({ plutoOverrides: { maxActionsPerSession: 1 } }));
    expect(look.actions.map((action) => [action.symbol, action.outcome])).toEqual([["ALT", "filled"]]);
  });

  it("keeps every symbol's scoring true to the shared cash: a put the cash can no longer secure is flagged after a fill on the other symbol", async () => {
    // $30,000 of cash, no per-order or per-ticker limit below it: the fills use it up. A symbol's scoring is kept across
    // a fill on the other one unless the smaller free cash changes a put's flag, so at the end every put of both symbols
    // must be flagged exactly when the free cash is below its risk.
    const context = twoSymbolLook({ plutoOverrides: { capitalBudgetPct: 100, orderSizePctOfBudget: 100, maxTickerExposurePct: 100, minCashReservePct: 0 }, tradingOverrides: { maxPositionPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 } });
    context.ledger = createSimulatedLedger(30_000, tenAm("2026-02-02"));
    const look = await runBacktestLook(context);

    expect(look.actions.filter((action) => action.outcome === "filled").length).toBeGreaterThanOrEqual(1);
    const freeCash = ledgerFreeCash(context.ledger);
    expect(freeCash).toBeLessThan(15_000);
    let flaggedPuts = 0;
    for (const symbol of ["SYN", "ALT"]) {
      const puts = look.scoredBySymbol.get(symbol)!.candidates.filter((candidate) => candidate.strategyKey === "cash_secured_put");
      expect(puts.length).toBeGreaterThan(0);
      for (const put of puts) {
        expect(put.flags.includes("insufficient_cash"), `${symbol} $${put.strike} ${put.expiry}`).toBe(freeCash < put.dollarRisk);
        if (put.flags.includes("insufficient_cash")) flaggedPuts += 1;
      }
    }
    expect(flaggedPuts).toBeGreaterThan(0);
  });
});

describe("a look after 10:00", () => {
  // The 10:00 capture is the rich chain at 100. A later look brings its own quotes and the stock price they imply.
  const quotesOfLook = (stockPrice: number, impliedVolatilityByExpiry: Record<string, number> = {}) => expiries.flatMap((expiry) => syntheticOptionQuotes(todayIso, stockPrice, [expiry], impliedVolatilityByExpiry[expiry] ?? 0.6, riskFreeRatePercent / 100, 1, 15));
  const intradayOf = (quotes: ReturnType<typeof quotesAt>) => ({ quotes, stockPrice: computeParityStockPrice(quotes, todayIso, riskFreeRatePercent / 100, null)!.price });
  const elevenAm = easternInstant(todayIso, 11, 0);

  it("scores the look's own quotes at the look's stock price and instant, and fills on them", async () => {
    // At 11:00 the stock is at 98: the 10:00 surface follows it, and the order is priced from the 11:00 quotes.
    const lookQuotes = quotesOfLook(98);
    const context = lookContext({ lookTimeEt: "11:00", intraday: intradayOf(lookQuotes) });
    const look = await runBacktestLook(context);
    expect(look.actions).toHaveLength(1);
    const action = look.actions[0]!;
    expect(action).toMatchObject({ outcome: "filled", lookTimeEt: "11:00", at: elevenAm.toISOString(), tradingDate: todayIso });
    const sale = look.optionSales[0]!;
    const quote = midOf(lookQuotes, sale.expiry, sale.strike, sale.optionRight);
    expect(sale).toMatchObject({ bid: quote.bid, ask: quote.ask });
    expect(sale.fillPrice).toBeCloseTo(computeSaleFillPrice(quote.bid, quote.ask, 0.5), 12);
    expect(sale.spotAtOpen).toBeCloseTo(98, 1);
    expect(requirePosition(context.ledger, action.positionIds[0]!).openedAt).toEqual(elevenAm);
    // Scored as live scores between captures: the price is the look's, the day change is measured from the previous
    // close, every contract the look quotes is scored on that quote ("day", stamped 11:00; the few strikes it no longer
    // lists keep their 10:00 quote), and no expiry's volatility moved.
    const scored = look.scoredBySymbol.get("SYN")!;
    expect(scored.spotPrice).toBeCloseTo(98, 1);
    expect(scored.dayChangePercent).toBeCloseTo((scored.spotPrice! / bars.previousClose(todayIso)!.close - 1) * 100, 10);
    const quotedAtTheLook = new Set(lookQuotes.map((entry) => `${entry.expiry}|${entry.strike}|${entry.right}`));
    const requoted = scored.candidates.filter((candidate) => quotedAtTheLook.has(`${candidate.expiry}|${candidate.strike}|${candidate.strategyKey === "covered_call" ? "C" : "P"}`));
    expect(requoted.length).toBeGreaterThan(20);
    expect(requoted.every((candidate) => candidate.quoteSource === "day" && candidate.quotedAt === elevenAm.toISOString())).toBe(true);
    expect(scored.candidates.filter((candidate) => !requoted.includes(candidate)).every((candidate) => candidate.quoteSource === "snapshot")).toBe(true);
    for (const shift of Object.values(scored.ivShiftByExpiry)) expect(Math.abs(shift.shiftVolatilityPoints)).toBeLessThan(1);
  });

  it("refuses an expiry whose quotes moved away from the 10:00 surface by more than the IV-shift limit", async () => {
    // The 13 March options are quoted 15 volatility points higher at 11:00; the limit is 8.
    const movedExpiry = "2026-03-13";
    const lookQuotes = quotesOfLook(100, { [movedExpiry]: 0.75 });
    // (Only the 13 and 20 March expiries are traded here: 8 days to expiry at least.)
    const look = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: intradayOf(lookQuotes), plutoOverrides: { minDte: 8 } }));
    const scored = look.scoredBySymbol.get("SYN")!;
    expect(scored.ivShiftByExpiry[movedExpiry]!.shiftVolatilityPoints).toBeGreaterThan(13);
    expect(scored.ivShiftByExpiry[movedExpiry]!.shiftVolatilityPoints).toBeLessThan(17);
    expect(look.optionSales).toHaveLength(1);
    expect(look.optionSales[0]!.expiry).toBe("2026-03-20");

    // With the limit at 20 points the richer expiry is eligible, and Pluto's top pick is on it.
    const allowed = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: intradayOf(lookQuotes), plutoOverrides: { minDte: 8, maxIvShiftVp: 20 } }));
    expect(allowed.optionSales[0]!.expiry).toBe(movedExpiry);

    // When every expiry moved, nothing is eligible and the look says why.
    const allMoved = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: intradayOf(quotesAt(0.75)) }));
    expect(allMoved.actions).toEqual([]);
    expect(allMoved.summary).toMatch(/none eligible \(rejected by iv_shift \d+/);
  });

  it("does not trade on a 10:00 quote the look has no quote for: Pluto's quote-age rule refuses it", async () => {
    // The 11:00 look holds only the 20 March expiry: the other expiries keep their 10:00 quotes, an hour old.
    const lookQuotes = richQuotes.filter((quote) => quote.expiry === "2026-03-20");
    const look = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: { quotes: lookQuotes, stockPrice: 100 } }));
    expect(look.optionSales).toHaveLength(1);
    expect(look.optionSales[0]!.expiry).toBe("2026-03-20");
    const scored = look.scoredBySymbol.get("SYN")!;
    expect(scored.candidates.some((candidate) => candidate.expiry !== "2026-03-20" && candidate.quoteSource === "snapshot")).toBe(true);
  });

  it("opens nothing under market stress, and still buys back a put that no longer pays", async () => {
    const stressed = await runBacktestLook(lookContext({ opensBlockedBecause: "market stress: new opens blocked while SPY is down" }));
    expect(stressed.actions).toEqual([]);
    expect(stressed.summary).toMatch(/none eligible \(rejected by .*opens_blocked \d+/);

    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 99, contracts: 2, fillPrice: 2.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const look = await runBacktestLook(lookContext({ ledger, market: marketOf(cheapQuotes), opensBlockedBecause: "market stress: new opens blocked while SPY is down" }));
    expect(look.actions.map((action) => [action.kind, action.outcome])).toEqual([["close_leg", "filled"]]);
  });

  it("counts the actions cap over the day's earlier looks", async () => {
    const atTheCap = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: intradayOf(quotesOfLook(100)), filledActionsEarlierToday: 10 }));
    expect(atTheCap.actions).toEqual([]);
    expect(atTheCap.summary).toBe("No action: actions cap: 10 of 10 actions a session");
    const oneLeft = await runBacktestLook(lookContext({ lookTimeEt: "11:00", intraday: intradayOf(quotesOfLook(100)), filledActionsEarlierToday: 9, plutoOverrides: { tickerCooldownMinutes: 0 } }));
    expect(oneLeft.actions.filter((action) => action.outcome === "filled")).toHaveLength(1);
  });

  it("does not buy back a held put the look has no quote for", async () => {
    // The put's 10:00 quote says holding no longer pays; the 11:00 look does not quote its expiry at all.
    const ledger = createSimulatedLedger(startingCash, tenAm("2026-02-02"));
    openCashSecuredPut(ledger, { symbol: "SYN", expiryDate: "2026-03-13", strike: 99, contracts: 2, fillPrice: 2.5, at: tenAm("2026-02-23"), actionId: "earlier-action", splitFactorToday: 1 });
    const lookQuotes = cheapQuotes.filter((quote) => quote.expiry !== "2026-03-13");
    const look = await runBacktestLook(lookContext({ ledger, market: marketOf(cheapQuotes), lookTimeEt: "11:00", intraday: { quotes: lookQuotes, stockPrice: 100 } }));
    expect(look.actions.filter((action) => action.outcome === "filled")).toEqual([]);
    for (const action of look.actions) expect(action.blockReason).toContain("order_build: the option has no two-sided quote at this look to price its buyback");
    expect(ledger.positions[0]).toMatchObject({ status: "open" });
  });
});
