import { describe, expect, it } from "vitest";
import { computeInFlightOrderNotional, computeOrderNotional, evaluateOrderLimitFigures, ladderBookCapitalVerdict } from "./orderLimits.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// Formula 3g's OrderNotional, plus the Roll Signals rule (2026-09-24): a roll re-uses the
// closed leg's notional, so only a cash-secured put moving UP in strike adds anything. Net of the
// premium since 2026-10-12 (Marcelo): the exposure Positions shows.
describe("computeOrderNotional", () => {
  it("open orders: a CSP reserves (strike − premium) × 100 × qty; a covered call only the share shortfall at spot less the premium", () => {
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2, premium: 1.5 }, 100, 0)).toBe(17_700);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 0)).toBe(19_800);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 150)).toBe(4_950);
    expect(computeOrderNotional({ strategyKey: "leaps", strike: 300, quantity: 2, premium: 71.69 }, 343.91, 0)).toBeCloseTo(14_338, 6);
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 110, quantity: 2, premium: 1 }, 100, 300)).toBe(0);
  });

  it("rolls: a covered-call roll adds nothing; a CSP roll adds the strike increase less the net credit × 100 × qty, never a negative", () => {
    expect(computeOrderNotional({ strategyKey: "covered_call", strike: 105, quantity: 3, premium: 2, rollFromStrike: 110, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 2, rollFromStrike: 90, rollFromPremium: 1.5 }, 100, 0)).toBe(900);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 7, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 85, quantity: 2, premium: 1, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(computeOrderNotional({ strategyKey: "cash_secured_put", strike: 90, quantity: 2, premium: 1, rollFromStrike: 90, rollFromPremium: 1 }, 100, 0)).toBe(0);
    expect(() => computeOrderNotional({ strategyKey: "cash_secured_put", strike: 95, quantity: 2, premium: 1, rollFromStrike: 90 }, 100, 0)).toThrow("rollFromPremium");
  });
});

const putOpen: OrderRequestPayload = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [{ role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1.5, strike: 90, expiry: "20261016", right: "P" }] } as OrderRequestPayload;

describe("computeInFlightOrderNotional", () => {
  it("reserves (strike − limit price) x 100 x contracts for a put open", () => {
    expect(computeInFlightOrderNotional("open_cash_secured_put", putOpen)).toBe(17_700);
  });

  it("counts a Covered Call entry's stock leg at shares x (limit price − call premium), and nothing when it is written against held shares", () => {
    const coveredCallEntry = { symbol: "AAA", strategyKey: "covered_call", legs: [
      { role: "stock", action: "BUY", symbol: "AAA", quantity: 200, unitPrice: 50 },
      { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 1, strike: 55, expiry: "20261016", right: "C" },
    ] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("open_covered_call", coveredCallEntry)).toBe(9_800);
    const heldShares = { ...coveredCallEntry, legs: [coveredCallEntry.legs[1]!] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("open_covered_call", heldShares)).toBe(0);
  });

  it("adds only the upward strike difference less the net credit for a put roll, never for a call roll", () => {
    const putRoll = { symbol: "AAA", strategyKey: "cash_secured_put", legs: [
      { role: "option", action: "BUY", symbol: "AAA", quantity: 2, unitPrice: 1, strike: 90, expiry: "20261009", right: "P", positionLegId: "leg-1" },
      { role: "option", action: "SELL", symbol: "AAA", quantity: 2, unitPrice: 2, strike: 95, expiry: "20261016", right: "P" },
    ] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("roll_leg", putRoll)).toBe(800); // (95 − 90 − (2 − 1)) × 100 × 2
    expect(computeInFlightOrderNotional("roll_leg", { ...putRoll, strategyKey: "covered_call" } as OrderRequestPayload)).toBe(0);
  });

  it("counts a LEAPS buy at the premium it pays, and nothing for its sale", () => {
    const leapsBuy = { symbol: "AAA", strategyKey: "leaps", legs: [{ role: "option", action: "BUY", symbol: "AAA", quantity: 2, unitPrice: 71.69, strike: 300, expiry: "20271217", right: "C" }] } as OrderRequestPayload;
    expect(computeInFlightOrderNotional("open_leaps", leapsBuy)).toBeCloseTo(14_338, 6);
    expect(computeInFlightOrderNotional("close_position", leapsBuy)).toBe(0);
  });

  it("ignores closes and orders with no strategy", () => {
    expect(computeInFlightOrderNotional("close_position", putOpen)).toBe(0);
    expect(computeInFlightOrderNotional("open_covered_call", { ...putOpen, strategyKey: undefined } as unknown as OrderRequestPayload)).toBe(0);
  });
});

describe("evaluateOrderLimitFigures for a CC + Put Ladder order", () => {
  // A $200,000 account, $60,000 cash, nothing locked; the platform's limits at 20% per position, 10% per ticker, 5% cash reserve.
  const figures = { symbol: "LADR", totalPortfolioValue: 200_000, totalCashValue: 60_000, cashLockedInCsps: 0, inFlight: { totalNotional: 0, tickerNotional: 0 }, settings: { maxOrderPctOfPortfolio: 20, maxConcentrationPerTickerPct: 10, minCashReservePct: 5 } };

  it("an order the platform's 10% per ticker would refuse passes inside a 25% pot", () => {
    // LADR already $30,000; the order adds $15,000 → $45,000: 22.5% of the account, under the $50,000 pot.
    expect(evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 30_000, orderNotional: 15_000 }).reasons).toEqual([expect.stringMatching(/22.5% of portfolio value, above the 10% max concentration/)]);
    const ladder = evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 30_000, orderNotional: 15_000, ladderPotFraction: 0.25 });
    expect(ladder).toMatchObject({ blocked: false, reasons: [], details: { ladderPotDollars: 50_000 } });
  });

  it("refuses an order that takes the ticker past its pot, counting orders still working", () => {
    const over = evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 30_000, inFlight: { totalNotional: 8_000, tickerNotional: 8_000 }, orderNotional: 15_000, ladderPotFraction: 0.25 });
    expect(over.blocked).toBe(true);
    expect(over.reasons).toEqual(["LADR would be $53,000, above its CC + Put Ladder pot of $50,000 (25.0% of portfolio value) (counting $8,000 of orders still working)."]);
  });

  it("refuses an order that takes the ladder's book past Pluto's capital budget (A1), with its reason at confirm", () => {
    // Budget 50% of $200,000 = $100,000; the book commits $96,000. A $45 Put ×1 at 0.80 adds $4,420 → $100,420: refused.
    const book = { committedBeforeDollars: 96_000, budgetFraction: 0.5 };
    const over = evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 0, orderNotional: 4_420, ladderPotFraction: 0.25, ladderBook: book });
    expect(over.reasons).toEqual(["The CC + Put Ladder's tickers would commit $100,420 together, above Pluto's capital budget of $100,000 (50.0% of portfolio value); $96,000 is already committed, counting orders still working."]);
    expect(over.details!.ladderBook).toEqual({ committedBeforeDollars: 96_000, committedAfterDollars: 100_420, capDollars: 100_000, fits: false });
    expect(evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 0, orderNotional: 4_000, ladderPotFraction: 0.25, ladderBook: book })).toMatchObject({ blocked: false, details: { ladderBook: { committedAfterDollars: 100_000, fits: true } } });
    // A Call on shares already held commits nothing: it passes an already full book.
    expect(evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 0, orderNotional: 0, ladderPotFraction: 0.25, ladderBook: { committedBeforeDollars: 120_000, budgetFraction: 0.5 } }).blocked).toBe(false);
  });

  it("keeps the cash reserve", () => {
    // $60,000 cash − $52,000 order = $8,000 = 4% of the account, under the 5% reserve.
    expect(evaluateOrderLimitFigures({ ...figures, existingTickerExposure: 0, orderNotional: 52_000, ladderPotFraction: 0.3 }).reasons).toEqual([expect.stringMatching(/4.0% of portfolio value as cash, below the 5% min cash reserve/)]);
  });
});

describe("evaluateOrderLimitFigures: the traders' capital cap", () => {
  // A $200,000 account with plenty of cash and loose platform limits, so only the cap can refuse. Pluto's budget is 50%: traders
  // may use $100,000 outside Pluto.
  const figures = { symbol: "TRDR", totalPortfolioValue: 200_000, totalCashValue: 200_000, cashLockedInCsps: 0, existingTickerExposure: 0, inFlight: { totalNotional: 0, tickerNotional: 0 }, settings: { maxOrderPctOfPortfolio: 100, maxConcentrationPerTickerPct: 100, minCashReservePct: 0 } };

  it("does not apply to an order that is not a trader's", () => {
    const result = evaluateOrderLimitFigures({ ...figures, orderNotional: 150_000 });
    expect(result.blocked).toBe(false);
    expect(result.details).not.toHaveProperty("traderCapital");
  });

  it("passes an order that takes the capital in use exactly to what traders may use", () => {
    const result = evaluateOrderLimitFigures({ ...figures, orderNotional: 20_000, traderCapital: { capitalInUseOutsidePluto: 80_000, plutoCapitalBudgetPct: 50 } });
    expect(result).toMatchObject({ blocked: false, reasons: [], details: { traderCapital: { availableDollars: 100_000, inUseDollars: 80_000, plutoCapitalBudgetPct: 50 } } });
  });

  it("refuses an order that takes it a dollar past, saying how much is available, in use and after", () => {
    const result = evaluateOrderLimitFigures({ ...figures, orderNotional: 20_001, traderCapital: { capitalInUseOutsidePluto: 80_000, plutoCapitalBudgetPct: 50 } });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toEqual(["Traders may use $100,000 outside Pluto (portfolio value less Pluto's 50% capital budget). $80,000 is already in use, so this order's $20,001 would take it to $100,001."]);
  });

  it("lets through an order that adds nothing even when the cap is already exceeded (a covered call on shares held, a call roll)", () => {
    expect(evaluateOrderLimitFigures({ ...figures, orderNotional: 0, traderCapital: { capitalInUseOutsidePluto: 150_000, plutoCapitalBudgetPct: 50 } }).blocked).toBe(false);
    expect(evaluateOrderLimitFigures({ ...figures, orderNotional: 1, traderCapital: { capitalInUseOutsidePluto: 150_000, plutoCapitalBudgetPct: 50 } }).blocked).toBe(true);
  });

  it("reserves Pluto's whole budget: at 100% traders may open nothing, at 0% the whole account is theirs", () => {
    expect(evaluateOrderLimitFigures({ ...figures, orderNotional: 1, traderCapital: { capitalInUseOutsidePluto: 0, plutoCapitalBudgetPct: 100 } }).blocked).toBe(true);
    expect(evaluateOrderLimitFigures({ ...figures, orderNotional: 200_000, traderCapital: { capitalInUseOutsidePluto: 0, plutoCapitalBudgetPct: 0 } }).blocked).toBe(false);
  });

  it("adds its refusal to the platform's own limits rather than replacing them", () => {
    const result = evaluateOrderLimitFigures({ ...figures, settings: { ...figures.settings, maxOrderPctOfPortfolio: 10 }, orderNotional: 30_000, traderCapital: { capitalInUseOutsidePluto: 90_000, plutoCapitalBudgetPct: 50 } });
    expect(result.reasons).toEqual([expect.stringMatching(/above the 10% max order size/), expect.stringMatching(/^Traders may use \$100,000 outside Pluto/)]);
  });
});

describe("ladderBookCapitalVerdict", () => {
  it("lets an order go only while the book's committed capital after it stays within the budget (the brief's example)", () => {
    // NLV $1,000,000 × 50% = $500,000 cap; $480,000 committed: a $4,500 order fits, a $22,500 one does not.
    expect(ladderBookCapitalVerdict({ committedBeforeDollars: 480_000, orderNotional: 4_500, budgetFraction: 0.5, netLiquidationValue: 1_000_000 })).toEqual({ committedBeforeDollars: 480_000, committedAfterDollars: 484_500, capDollars: 500_000, fits: true });
    expect(ladderBookCapitalVerdict({ committedBeforeDollars: 480_000, orderNotional: 22_500, budgetFraction: 0.5, netLiquidationValue: 1_000_000 }).fits).toBe(false);
  });
});
