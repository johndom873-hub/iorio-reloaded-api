import { describe, expect, it } from "vitest";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../../lib/commissionEstimate.js";
import { blackScholesPriceOnForward } from "../../lib/impliedVolatilitySurface.js";
import { contractKey } from "../../lib/optionContractKey.js";
import { defaultBacktestVolFarmerSettings, defaultBacktestVolFarmerV2Settings, defaultBacktestVolFarmerV3Settings, type BacktestVolFarmerV3Settings } from "../backtestTypes.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { newVolFarmerV4SymbolState, runVolFarmerV4Steps, volFarmerV4BreakEven, type VolFarmerV4Book, type VolFarmerV4CallSale, type VolFarmerV4Market, type VolFarmerV4PositionCashFlow, type VolFarmerV4PutSale, type VolFarmerV4SymbolState, type VolFarmerV4SharesOrder } from "./volFarmerV4Steps.js";

// Vol Farmer v3's holding rules on the shared steps, with a book that records the orders: the second position's shares
// rebalanced with the first's, and a first position the second outlived rebuilt.

const stockCommissionDollars = (shares: number) => 0.005 * shares;

/** Black-Scholes quotes at IV 50%, 2% either side of the mid, ten days from the look (or expiring at its close). */
function marketOf(stockPrice: number, expiry = "2026-11-06"): VolFarmerV4Market {
  const years = expiry === "2026-10-27" ? 5 / 8760 : 10 / 365;
  const quotesOf = (right: "C" | "P"): SymbolFileQuote[] =>
    Array.from({ length: 101 }, (_, index) => 40 + index).map((strike) => {
      const mid = blackScholesPriceOnForward(stockPrice * Math.exp(0.04 * years), strike, years, 0.04, 0.5, right === "C");
      return { expiry, strike, right, bid: Math.round(mid * 0.98 * 10_000) / 10_000, ask: Math.round(mid * 1.02 * 10_000) / 10_000, bidSize: null, askSize: null };
    });
  const quotes = [...quotesOf("C"), ...quotesOf("P")];
  return {
    symbol: "VFT",
    todayIso: "2026-10-27",
    stockPrice,
    riskFreeRate: 0.04,
    quotes,
    forwardAnchors: new Map(),
    previousSessionVolumeByContract: new Map(quotes.map((quote) => [contractKey(quote), 1_000])),
    yearsToTodaysClose: 5 / 8760,
    yearsToExpiry: () => 1,
    leapsCallQuotes: undefined,
    stepImpliedVolatility: () => null,
    tradingSessionsThrough: () => 9,
    priceToCycleScale: 1,
    optionContractsRepresentable: true,
    spreadShareCharged: 0,
    commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator },
    optionCommissionDollars: (contracts) => 0.65 * contracts,
    stockCommissionDollars,
    leapsCapBaseLabel: "its share of the account",
    capsLeapsAtAskSize: false,
  };
}

/** A book with a $100,000 pot and $100,000 free cash, holding shares unless `flat`, recording its orders. */
function recordingBook(potDollars = 100_000, flat = false) {
  const orders = { bought: [] as VolFarmerV4SharesOrder[], sold: [] as VolFarmerV4SharesOrder[], calls: [] as VolFarmerV4CallSale[], puts: [] as VolFarmerV4PutSale[], flows: [] as VolFarmerV4PositionCashFlow[] };
  let legNumber = 0;
  const book: VolFarmerV4Book = {
    isFlat: () => flat,
    freeCash: () => 100_000,
    potForNewCycle: () => potDollars,
    leapsCapBaseDollars: () => potDollars,
    openOptionContracts: () => [],
    leg: () => undefined,
    sellCoveredCall: (sale) => {
      // As the ledger: one position per contract.
      if (orders.calls.some((sold) => sold.candidate.expiry === sale.candidate.expiry && sold.candidate.strike === sale.candidate.strike)) throw new Error(`the ${sale.candidate.strike} Call is already held`);
      orders.calls.push(sale);
      return `call-${++legNumber}`;
    },
    sellCashSecuredPut: (sale) => {
      orders.puts.push(sale);
      return `put-${++legNumber}`;
    },
    buyLeaps: () => `leaps-${++legNumber}`,
    sellLeaps: () => {},
    buyShares: (order) => void orders.bought.push(order),
    sellShares: (order) => void orders.sold.push(order),
    notePositionPnl: (flow) => void orders.flows.push(flow),
  };
  return { book, orders };
}

const v2 = { ...defaultBacktestVolFarmerV2Settings, stepRule: "fixed" as const };
const run = (state: VolFarmerV4SymbolState, stockPrice: number, book: VolFarmerV4Book, v3: Partial<BacktestVolFarmerV3Settings>, expiry?: string) =>
  runVolFarmerV4Steps({ state, market: marketOf(stockPrice, expiry), farmer: defaultBacktestVolFarmerSettings, v2, v3: { ...defaultBacktestVolFarmerV3Settings, ...v3 }, book });
const positionOf = (shares: number, costPerShare: number) => ({ shares, costPerShare, premiums: [], calls: [], puts: [] });

describe("Vol Farmer v3's holding", () => {
  it("rebalancing both positions as one, sells the higher break-even's lots first, the first position keeping one lot", () => {
    const state = { ...newVolFarmerV4SymbolState(), first: positionOf(500, 100), second: positionOf(600, 60) };
    const { book, orders } = recordingBook();
    // At 80: 1,100 shares ($88,000) against half the $100,000 pot ($50,000 ± $5,000): back to floor(50,000 ÷ 8,000.50) =
    // 6 lots of the 11 held. The first position's break-even (100) is the higher: it sells 4 lots, keeping one, and the
    // second the fifth.
    const note = run(state, 80, book, { rebalances: "both_positions" });
    expect(orders.sold.map((order) => order.shares)).toEqual([400, 100]);
    expect(note).toContain("first and second positions $88,000 against a target of $50,000");
    expect(note).toContain("first position 5 → 1 lots, break-even 100.00 kept");
    expect(note).toContain("second position 6 → 5 lots, break-even 60.00 kept");
    expect([state.first?.shares, state.second?.shares]).toEqual([100, 500]);
    // Each sale is the position's cash flow: 400 × 80 less its commission, then 100 × 80 less its.
    expect(orders.flows.filter((flow) => flow.kind === "shares")).toEqual([
      { position: "first", kind: "shares", dollars: 32_000 - stockCommissionDollars(400) },
      { position: "second", kind: "shares", dollars: 8_000 - stockCommissionDollars(100) },
    ]);

    // The second position first: its 6 lots go before the first's (5 → 4).
    const secondFirst = { ...newVolFarmerV4SymbolState(), first: positionOf(500, 100), second: positionOf(600, 60) };
    const secondFirstBook = recordingBook();
    run(secondFirst, 80, secondFirstBook.book, { rebalances: "both_positions", trimsSell: "second_position_first" });
    expect(secondFirstBook.orders.sold.map((order) => order.shares)).toEqual([500]);
    expect([secondFirst.first?.shares, secondFirst.second?.shares]).toEqual([500, 100]);

    // The first position alone: the same look sells only its own lots, the second's not counted.
    const firstOnly = { ...newVolFarmerV4SymbolState(), first: positionOf(500, 100), second: positionOf(600, 60) };
    const alone = recordingBook();
    run(firstOnly, 80, alone.book, {});
    expect(alone.orders.sold).toEqual([]);
  });

  it("ends a second position its sales sell out, as one called away: its LEAPS is sold at the next look", () => {
    // The second position's break-even (120) is the higher: its one lot goes first, then two of the first's.
    const state = { ...newVolFarmerV4SymbolState(), first: positionOf(500, 50), second: positionOf(100, 120), leaps: { legIds: ["leaps-0"], expiry: "2027-12-17", strike: 80, intendedContracts: 2 }, leapsBought: true };
    const { book, orders } = recordingBook(60_000);
    run(state, 80, book, { rebalances: "both_positions" });
    expect(orders.sold.map((order) => order.shares)).toEqual([100, 200]);
    expect(state.second).toBeNull();
    expect(state.first?.shares).toBe(300);
    expect([state.leapsToSell, state.leapsBought]).toEqual([true, false]);
  });

  it("rebuilds a first position the second outlived, as a cycle opens, less the second's shares when both are one", () => {
    // The second holds 300 shares (break-even 120) and no first position: at 100, half the $100,000 pot buys
    // floor(50,000 ÷ 10,000.50) = 4 lots, bought with their Call beside the second's shares.
    const state = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 120) };
    const { book, orders } = recordingBook();
    run(state, 100, book, { firstPositionAfterCalledAway: "rebuild" });
    expect(state.first?.shares).toBe(400);
    expect(orders.calls[0]).toMatchObject({ startsCycle: false, buysShares: true, contracts: 4 });
    expect(orders.flows[0]).toEqual({ position: "first", kind: "shares", dollars: -(400 * 100 + stockCommissionDollars(400)) });
    expect(volFarmerV4BreakEven(state.first!)).toBeLessThan(100 + stockCommissionDollars(400) / 400);

    // Both positions as one: the target less the second's $30,000 leaves $20,000, 1 lot.
    const both = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 120) };
    const bothBook = recordingBook();
    run(both, 100, bothBook.book, { firstPositionAfterCalledAway: "rebuild", rebalances: "both_positions" });
    expect(both.first?.shares).toBe(100);

    // A second position with its break-even at the price wants the rebuilt first position's Call: it takes another.
    const sameCall = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 100) };
    const sameCallBook = recordingBook();
    run(sameCall, 100, sameCallBook.book, { firstPositionAfterCalledAway: "rebuild" });
    expect(sameCallBook.orders.calls).toHaveLength(2);
    expect(sameCallBook.orders.calls[0]!.candidate.strike).not.toBe(sameCallBook.orders.calls[1]!.candidate.strike);

    // Waiting, as Vol Farmer v2 does: no first position.
    const waits = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 120) };
    run(waits, 100, recordingBook().book, {});
    expect(waits.first).toBeNull();
  });

  it("selling options that expire today, always holding the stock: a day without one buys a new cycle's shares alone, an expiry day sells that day's Call", () => {
    // Tuesday 27 October lists only the 6 November expiry: the flat ticker's first position buys floor(50,000 ÷ 10,000.50) =
    // 4 lots at 100, with no Call.
    const state = newVolFarmerV4SymbolState();
    const quiet = recordingBook(100_000, true);
    run(state, 100, quiet.book, { optionsExpiry: "today" });
    expect(quiet.orders.bought.map((order) => order.shares)).toEqual([400]);
    expect(quiet.orders.calls).toEqual([]);
    expect(state.first?.shares).toBe(400);
    // An expiry day: the Call expires at today's close.
    const expiryDay = recordingBook();
    run(state, 100, expiryDay.book, { optionsExpiry: "today" }, "2026-10-27");
    expect(expiryDay.orders.calls.map((sale) => sale.candidate.expiry)).toEqual(["2026-10-27"]);
    expect(expiryDay.orders.calls[0]!.candidate.dte).toBe(0);
  });

  it("always holding the stock, a day no Call is sold tops the holding up and rebuilds a first position the second outlived", () => {
    // 200 shares at 100 ($20,000) against half the $100,000 pot ($50,000 ± $5,000): topped up to 4 lots the same day.
    const under = { ...newVolFarmerV4SymbolState(), first: positionOf(200, 100) };
    const underBook = recordingBook();
    run(under, 100, underBook.book, { optionsExpiry: "today" });
    expect(underBook.orders.bought.map((order) => order.shares)).toEqual([200]);
    // The second position alone (300 shares at 100 = $30,000), rebuild set, both positions as one: 50,000 − 30,000 = $20,000,
    // floor(20,000 ÷ 10,000.50) = 1 lot bought alone.
    const outlived = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 120) };
    const outlivedBook = recordingBook();
    expect(run(outlived, 100, outlivedBook.book, { optionsExpiry: "today", firstPositionAfterCalledAway: "rebuild", rebalances: "both_positions" })).toContain("the first position rebuilt");
    expect(outlivedBook.orders.bought.map((order) => order.shares)).toEqual([100]);
  });

  it("a ticker's own Always hold the stock overrides the session's", () => {
    const flatBook = (alwaysHoldTheStock: "on" | "off", own: Record<string, "on" | "off">) => {
      const book = recordingBook(100_000, true);
      run(newVolFarmerV4SymbolState(), 100, book.book, { optionsExpiry: "today", alwaysHoldTheStock, tickerAlwaysHoldTheStock: own });
      return book.orders.bought.map((order) => order.shares);
    };
    expect(flatBook("on", { VFT: "off" })).toEqual([]);
    expect(flatBook("off", { VFT: "on" })).toEqual([400]);
    // Another ticker's value leaves this one on the session's.
    expect(flatBook("off", { OTHER: "on" })).toEqual([]);
  });

  it("selling options that expire today, Always hold the stock off: a day without one buys no shares, an expiry day buys them with that day's Call", () => {
    // Tuesday 27 October lists only the 6 November expiry: the flat ticker waits, no shares bought without a Call.
    const state = newVolFarmerV4SymbolState();
    const quiet = recordingBook(100_000, true);
    expect(run(state, 100, quiet.book, { optionsExpiry: "today", alwaysHoldTheStock: "off" })).toContain("no cycle opened: no Call is sold today, and with Always hold the stock off shares are bought only with one (until an expiry day)");
    expect([quiet.orders.bought, quiet.orders.calls, state.first]).toEqual([[], [], null]);
    // An expiry day: floor(50,000 ÷ 10,000.50) = 4 lots bought with their Call, expiring at today's close.
    const expiryDay = recordingBook(100_000, true);
    run(state, 100, expiryDay.book, { optionsExpiry: "today", alwaysHoldTheStock: "off" }, "2026-10-27");
    expect(expiryDay.orders.calls.map((sale) => [sale.candidate.expiry, sale.contracts, sale.startsCycle])).toEqual([["2026-10-27", 4, true]]);
    expect(expiryDay.orders.calls[0]!.candidate.dte).toBe(0);
    expect(state.first?.shares).toBe(400);
  });

  it("Always hold the stock off, a day no Call is sold: the holding is trimmed but never topped up, and a first position the second outlived is not rebuilt", () => {
    // 200 shares at 100 ($20,000) against half the $100,000 pot ($50,000 ± $5,000): a top-up waits for a day a Call is sold.
    const under = { ...newVolFarmerV4SymbolState(), first: positionOf(200, 100) };
    const underBook = recordingBook();
    expect(run(under, 100, underBook.book, { optionsExpiry: "today", alwaysHoldTheStock: "off" })).toContain("no top-up: first position $20,000 against a target of $50,000");
    expect(underBook.orders.bought).toEqual([]);
    expect(under.first?.shares).toBe(200);
    // 800 shares ($80,000): trimmed back to floor(50,000 ÷ 10,000.50) = 4 lots the same day.
    const over = { ...newVolFarmerV4SymbolState(), first: positionOf(800, 100) };
    const overBook = recordingBook();
    run(over, 100, overBook.book, { optionsExpiry: "today", alwaysHoldTheStock: "off" });
    expect(overBook.orders.sold.map((order) => order.shares)).toEqual([400]);
    // The second position alone, rebuild set: nothing bought.
    const outlived = { ...newVolFarmerV4SymbolState(), second: positionOf(300, 120) };
    const outlivedBook = recordingBook();
    expect(run(outlived, 100, outlivedBook.book, { optionsExpiry: "today", firstPositionAfterCalledAway: "rebuild", alwaysHoldTheStock: "off" })).toContain("no first position rebuilt");
    expect([outlivedBook.orders.bought, outlived.first]).toEqual([[], null]);
  });

  it("sells Calls on the lots no open Call covers, beside the Call still open; a position fully covered sells none", () => {
    // 200 shares at 100, one Call open on 100 of them (holdings adopted that way): the other lot gets its Call.
    const partly = { ...newVolFarmerV4SymbolState(), first: { ...positionOf(200, 100), calls: [{ legId: "call-0", shares: 100 }] } };
    const partlyBook = recordingBook();
    run(partly, 100, partlyBook.book, {});
    expect(partlyBook.orders.calls.map((sale) => [sale.contracts, sale.startsCycle])).toEqual([[1, false]]);
    expect(partly.first!.calls.map((call) => call.shares)).toEqual([100, 100]);
    // Both lots covered: nothing more to sell.
    const covered = recordingBook();
    run(partly, 100, covered.book, {});
    expect(covered.orders.calls).toEqual([]);
  });

  it("sells no Call whose commission is more than 20% of its premium; every Call capped, none is sold and the best is told", () => {
    const lookAt = (commissionPerContract: number) => {
      const commissions = { option: { perContractDollars: () => commissionPerContract }, stock: flatStockCommissionEstimator };
      const skips: Parameters<NonNullable<VolFarmerV4Book["noteCommissionCapSkip"]>>[0][] = [];
      const { book, orders } = recordingBook();
      const state = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 90) };
      const note = runVolFarmerV4Steps({ state, market: { ...marketOf(100), commissions }, farmer: defaultBacktestVolFarmerSettings, v2, v3: defaultBacktestVolFarmerV3Settings, book: { ...book, noteCommissionCapSkip: (skip) => void skips.push(skip) } });
      return { note, skips, calls: orders.calls };
    };
    // The best Call, the $105 at $1.4849 ($148.49 a contract): a $30 commission is 20.2% of it, over the cap, and every
    // other Call brings less: none is sold, the $105 told.
    const capped = lookAt(30);
    expect(capped.calls).toEqual([]);
    expect(capped.skips.map((skip) => [skip.position, skip.candidate.strike, skip.candidate.premiumDollars, skip.maxShareOfPremium])).toEqual([["first", 105, 148.49, 0.2]]);
    expect(capped.note).toContain("first position: the $105 Call · 6 Nov (10DTE) not sold: its commission $30.00 is 20% of its $148.49 premium, over 20%");
    expect(capped.note).toContain("commission over cap");
    // $29: 19.5% of it, under the cap: the $105 is sold and nothing is told (the Calls the cap leaves out all yield less).
    const sold = lookAt(29);
    expect([sold.calls.map((sale) => sale.candidate.strike), sold.skips]).toEqual([[105], []]);
  });

  it("waits for the next expiry to come within the days set: further out, the look sells no option", () => {
    // The look's next expiry is 10 days out. 400 shares at 100 are within a lot of the $50,000 target: nothing to rebalance.
    const state = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 100) };
    const far = recordingBook();
    expect(run(state, 100, far.book, { optionsMaxDaysToExpiry: 7 })).toBeNull();
    expect(far.orders.calls).toEqual([]);
    const near = recordingBook();
    run(state, 100, near.book, { optionsMaxDaysToExpiry: 10 });
    expect(near.orders.calls.map((sale) => sale.contracts)).toEqual([4]);
    // Always holding the stock, a flat ticker opens with shares alone, its Call waiting for the expiry to come within the days.
    const flat = newVolFarmerV4SymbolState();
    const opening = recordingBook(100_000, true);
    expect(run(flat, 100, opening.book, { optionsMaxDaysToExpiry: 7 })).toContain("with no Call until the next expiry is 7 days or fewer away");
    expect([opening.orders.bought.map((order) => order.shares), opening.orders.calls]).toEqual([[400], []]);
    // With it off, a flat ticker buys nothing until the expiry comes within the days.
    const waiting = newVolFarmerV4SymbolState();
    const waitingBook = recordingBook(100_000, true);
    expect(run(waiting, 100, waitingBook.book, { optionsMaxDaysToExpiry: 7, alwaysHoldTheStock: "off" })).toContain("no cycle opened: no Call is sold today, and with Always hold the stock off shares are bought only with one (until the next expiry is 7 days or fewer away)");
    expect([waitingBook.orders.bought, waitingBook.orders.calls]).toEqual([[], []]);
  });

  it("sells the Puts with every Call when set, struck below the price when uncapped", () => {
    // At 100 with its break-even at 100, the first position's best Call yields far above 5% a year: Vol Farmer v2 sells no Put.
    const yieldRule = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 100) };
    const yieldBook = recordingBook();
    expect(run(yieldRule, 100, yieldBook.book, {})).not.toContain("Put");
    // With every Call, still a Step (15%) below the first break-even (98.52 once the Call's premium counts, so $83.74): none
    // of the ten-day Puts that far down qualifies.
    const everyCall = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 100) };
    const everyCallBook = recordingBook();
    expect(run(everyCall, 100, everyCallBook.book, { putsSold: "with_every_call" })).toContain("no Put: Puts with every Call, but none qualifies at or below 83.74");
    // Below the price: |delta| at most 0.3, on the rest of the pot, floor(50,000 ÷ (strike × 100)) contracts.
    const uncapped = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 100) };
    const uncappedBook = recordingBook();
    run(uncapped, 100, uncappedBook.book, { putsSold: "with_every_call", putStrikeCap: "none" });
    expect(uncappedBook.orders.puts).toHaveLength(1);
    const { candidate: put, contracts } = uncappedBook.orders.puts[0]!;
    expect(put.strike).toBeGreaterThan(85);
    expect(put.strike).toBeLessThan(100);
    expect(Math.abs(put.delta)).toBeLessThanOrEqual(0.3);
    expect(contracts).toBe(Math.floor(50_000 / (put.strike * 100)));
  });

  it("with no strike floor, sells the first position's Call below its break-even", () => {
    // Break-even 120 at 100: no Call at or above 120 in the |delta| range; above the price, one.
    const floored = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 120) };
    const flooredBook = recordingBook();
    run(floored, 100, flooredBook.book, {});
    expect(flooredBook.orders.calls).toEqual([]);
    const free = { ...newVolFarmerV4SymbolState(), first: positionOf(400, 120) };
    const freeBook = recordingBook();
    run(free, 100, freeBook.book, { callStrikeFloor: "none" });
    expect(freeBook.orders.calls).toHaveLength(1);
    expect(freeBook.orders.calls[0]!.candidate.strike).toBeLessThan(120);
    expect(freeBook.orders.calls[0]!.candidate.strike).toBeGreaterThan(100);
  });
});
