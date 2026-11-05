import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import { computeTickerExposure } from "./positionExposure.js";
import { fetchAvailableUncoveredShares } from "./positionQueries.js";
import { loadTradingSettings, type TradingSettings } from "./tradingSettingsStore.js";
import { orderFillsPendingSql } from "./orderFills.js";
import { formatWholeDollars } from "./formatWholeDollars.js";
import type { BookKey } from "../books/bookKeys.js";

// The three trading settings that block *placing* an order: max order size %, max concentration per ticker %
// and min cash reserve % (table trading_settings, edited on Risk & Limits). They apply to EVERY opening or
// rolling order whatever its origin (Signals, the position form, the chain, Pluto); a close only reduces exposure and is
// not limit-checked (approved 2026-10-05). Formulas all reuse the platform's existing valuation conventions --
// total portfolio value is netLiquidationValue (same as riskLimits.ts's /exposure), existing per-ticker
// exposure is computePositionExposures (same as the concentration-by-ticker figure there), and free cash is
// totalCashValue minus CSP collateral.
//
// This order's own notional contribution, net of the premium it sells for (Marcelo 2026-10-12, the same exposure
// as Positions' EXP $): a cash-secured put reserves (strike − premium) × 100 × quantity, since the premium lands in
// cash as the strike is reserved; a covered call only adds notional for the shares it buys, less the premium on
// those shares: a built order's own stock leg (a typed share count counts in full, Marcelo 2026-10-19), else, for a
// setup form's check, the shortfall beyond what's already held uncovered (the same shortfall math positions.ts's
// order-build auto-fill uses) -- a fully-covered covered call therefore contributes 0. Free cash is IBKR's cash
// balance (which already holds every premium received) less the full strike of each open put, so cash after a
// fill is exactly free cash less this net notional.
//
// Orders still on their way to or working at IBKR (confirmed, submitted, partially filled, cancel requested) are
// counted too (approved 2026-10-05): their notional is added to the ticker's exposure and subtracted from free
// cash, so two orders confirmed seconds apart cannot both pass a limit only one fits under. A partly filled order
// is counted in full, so its filled part is briefly counted twice: the check errs towards blocking.
//
// A LEAPS buy (Marcelo 2026-10-27) adds the premium it pays, premium × 100 × quantity: its maximum loss, and the cash it takes.
// A share purchase (Vol Farmer v4's rebalancing, Marcelo 2026-10-31) adds what it pays, shares × limit price.
//
// A Pluto strategy order also gets the book-wide cap: every Pluto ticker's exposure and working orders together, after
// the order, at most Pluto's book value (strategyBookCapitalVerdict, Marcelo 2026-10-21; the book's value since 2026-11-05).
//
// The Pluto and Manual books (Marcelo 2026-11-05): a live order is measured against its own book, Pluto's for a Pluto
// order or an order on a ticker in Pluto's book, Manual's otherwise. The portfolio value is the book's value, the cash its
// usable cash (src/books/bookFigures.ts), the Puts and working orders its own; so an order can only use its book's cash,
// whoever places it (this replaced the traders' capital cap of 2026-10-17).
//
// Fails closed: if account/portfolio data can't be verified, every check is reported as blocked rather than
// silently skipped (Marcelo approved 2026-09-24) -- this function gates real order confirmations.

export type OrderLimitsStrategyKey = "covered_call" | "cash_secured_put" | "leaps" | "shares";

export interface OrderLimitsInput {
  strategyKey: OrderLimitsStrategyKey;
  symbol: string;
  tickerId: string;
  quantity: number;
  strike: number;
  /**
   * Price per share the option trades at (the limit, or the mid for a preview): a sale's notional is net of it, a LEAPS buy's
   * is it. A share purchase: the shares' limit price, `quantity` being the shares.
   */
  premium: number;
  /** Underlying stock price, used only for a covered call's share-shortfall notional. Omit to read the pool, then fetch a live price. */
  spotPrice?: number;
  /**
   * Roll: the strike of the short leg this order closes. A roll re-uses the closed leg's notional, so
   * only the difference counts -- a covered-call roll adds nothing (the shares are already held), a
   * cash-secured-put roll adds (newStrike − oldStrike − net credit) × 100 × quantity, never a negative.
   */
  rollFromStrike?: number;
  /** Roll: the price per share paid to buy the closed leg back; the roll's net credit is premium − rollFromPremium. Required with rollFromStrike. */
  rollFromPremium?: number;
  /** The order being evaluated, left out of the in-flight totals (it is not in flight against itself). */
  excludeOrderRequestId?: string;
  /**
   * A Pluto strategy order (Marcelo 2026-10-15): the pot cap replaces the max order size and max concentration limits (the
   * cash reserve stays), and a covered call's shares are those its stock leg buys (the strategy can buy every share even
   * with uncovered ones held), not the shortfall against the uncovered shares.
   */
  strategy?: { potFraction: number | null; stockSharesBought: number; book: StrategyBookInput };
  /** A built covered-call open with a stock leg: the shares that leg buys, counted in place of the shortfall against uncovered shares held. */
  stockSharesBought?: number;
}

/** Pluto's book (Marcelo 2026-10-21): every ticker Pluto trades, under Pluto's book value together. */
export interface StrategyBookInput {
  /** Pluto's enabled tickers. */
  symbols: readonly string[];
  /** The cap as a share of the value it is measured on: 1 (all of Pluto's book value) since 2026-11-05. */
  budgetFraction: number;
}

export interface OrderLimitsDetails {
  orderNotional: number;
  totalPortfolioValue: number;
  orderSharePct: number;
  concentrationAfterPct: number;
  cashReserveAfterPct: number;
  inFlightNotional: number;
  limits: { maxOrderPctOfPortfolio: number; maxConcentrationPerTickerPct: number; minCashReservePct: number };
  /** A strategy order's pot in dollars (allocation × capital budget × net liquidation value); absent for every other order. */
  strategyPotDollars?: number;
  /** A strategy order: the book's committed capital after it, and Pluto's capital budget in dollars. */
  strategyBook?: StrategyBookCapitalVerdict;
  /** A live order: the book it is measured against and that book's available cash before it. */
  book?: { book: BookKey; bookValue: number; availableCash: number };
}

export interface OrderLimitsResult {
  blocked: boolean;
  reasons: string[];
  /** Absent when the limits could not be verified (the result is then a block with its reason). */
  details?: OrderLimitsDetails;
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

async function resolveSpotPrice(input: OrderLimitsInput): Promise<number | null> {
  if (input.spotPrice !== undefined) return input.spotPrice;
  if (input.strategyKey !== "covered_call" || input.rollFromStrike !== undefined) return 0; // not needed for a cash-secured put or any roll
  const prices = await fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol: input.symbol }]);
  return prices["stock"] ?? null;
}

/** A put roll's added notional per share: the strike difference less the roll's net credit, never a negative. */
function putRollNotionalPerShare(newStrike: number, oldStrike: number, newPremium: number, buybackPrice: number): number {
  return Math.max(0, newStrike - oldStrike - (newPremium - buybackPrice));
}

/** Pure: this order's own added notional -- see file header for the CSP/covered-call formulas and the roll rule. */
export function computeOrderNotional(input: Pick<OrderLimitsInput, "strategyKey" | "strike" | "quantity" | "premium" | "rollFromStrike" | "rollFromPremium">, spotPrice: number, availableUncoveredShares: number): number {
  if (input.strategyKey === "leaps") return input.premium * 100 * input.quantity;
  if (input.strategyKey === "shares") return input.premium * input.quantity;
  if (input.rollFromStrike !== undefined) {
    if (input.strategyKey === "covered_call") return 0;
    if (input.rollFromPremium === undefined) throw new Error("A roll's limit check needs the closed leg's buyback price (rollFromPremium).");
    return putRollNotionalPerShare(input.strike, input.rollFromStrike, input.premium, input.rollFromPremium) * 100 * input.quantity;
  }
  if (input.strategyKey === "cash_secured_put") return Math.max(0, input.strike - input.premium) * 100 * input.quantity;
  const shortfallShares = Math.max(0, input.quantity * 100 - availableUncoveredShares);
  return shortfallShares * Math.max(0, spotPrice - input.premium);
}

/**
 * Pure: the notional an order already on its way to IBKR still ties up, read from its stored payload (no market data needed), net of
 * the premium at its limit prices: a put open reserves (strike − premium) × 100 × contracts, a covered-call open costs the stock leg
 * of its Covered Call entry less the call's premium on those shares (nothing when it is written against shares already held), a put roll adds the
 * strike difference less its net credit when that is positive, a LEAPS buy its premium, a share purchase what it pays, a call
 * roll and every close add nothing.
 */
export function computeInFlightOrderNotional(requestType: string, payload: OrderRequestPayload): number {
  const strategyKey = payload.strategyKey;
  if (strategyKey === "shares") {
    const stockLeg = payload.legs.find((leg) => leg.role === "stock");
    return requestType === "open_shares" && stockLeg ? stockLeg.unitPrice * stockLeg.quantity : 0;
  }
  if (strategyKey === "leaps") {
    const callLeg = payload.legs.find((leg) => leg.role === "option");
    return requestType.startsWith("open_") && callLeg ? callLeg.unitPrice * 100 * callLeg.quantity : 0;
  }
  if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put") return 0;
  if (requestType === "roll_leg") {
    if (strategyKey === "covered_call") return 0;
    const openLeg = payload.legs.find((leg) => leg.role === "option" && !leg.positionLegId);
    const closeLeg = payload.legs.find((leg) => leg.role === "option" && leg.positionLegId);
    if (!openLeg?.strike || !closeLeg?.strike) return 0;
    return putRollNotionalPerShare(openLeg.strike, closeLeg.strike, openLeg.unitPrice, closeLeg.unitPrice) * 100 * openLeg.quantity;
  }
  if (!requestType.startsWith("open_")) return 0;
  if (strategyKey === "cash_secured_put") {
    const putLeg = payload.legs.find((leg) => leg.role === "option");
    return putLeg?.strike ? Math.max(0, putLeg.strike - putLeg.unitPrice) * 100 * putLeg.quantity : 0;
  }
  const stockLeg = payload.legs.find((leg) => leg.role === "stock");
  const callLeg = payload.legs.find((leg) => leg.role === "option");
  return stockLeg ? stockLeg.quantity * Math.max(0, stockLeg.unitPrice - (callLeg?.unitPrice ?? 0)) : 0;
}

export interface InFlightTotals {
  totalNotional: number;
  tickerNotional: number;
}

/** Statuses the order gate counts as in flight: confirmed and not yet done. */
export const inFlightOrderRequestStatuses = ["confirmed", "submitted", "partially_filled", "cancel_requested"];

/**
 * order_requests (aliased orq) still committing capital: in flight, or filled with fills not yet recorded, i.e. not yet a
 * position either (orderFillsPendingSql).
 */
export function inFlightOrderRequestsQuery() {
  return db("order_requests as orq").where((builder) => builder.whereIn("orq.status", inFlightOrderRequestStatuses).orWhereRaw(orderFillsPendingSql("orq")));
}

async function loadInFlightOrderRows(excludeOrderRequestId: string | undefined): Promise<{ request_type: string; payload: OrderRequestPayload }[]> {
  let query = inFlightOrderRequestsQuery().select("orq.request_type", "orq.payload");
  if (excludeOrderRequestId) query = query.whereNot("orq.id", excludeOrderRequestId);
  return query;
}

async function loadInFlightNotionals(symbol: string, excludeOrderRequestId: string | undefined): Promise<InFlightTotals> {
  const rows = await loadInFlightOrderRows(excludeOrderRequestId);
  const totals: InFlightTotals = { totalNotional: 0, tickerNotional: 0 };
  for (const row of rows) {
    const notional = computeInFlightOrderNotional(row.request_type, row.payload);
    totals.totalNotional += notional;
    if (row.payload.symbol === symbol) totals.tickerNotional += notional;
  }
  return totals;
}

/**
 * The capital the given tickers commit (Pluto's book): each ticker's exposure as the pot check counts it
 * (computeTickerExposure) plus the notional of the orders still in flight on them, `excludeOrderRequestId` left out.
 */
export async function loadCommittedCapitalOnSymbols(symbols: readonly string[], excludeOrderRequestId?: string): Promise<number> {
  const symbolSet = new Set(symbols);
  const [exposures, rows] = await Promise.all([Promise.all(symbols.map((symbol) => computeTickerExposure(symbol))), loadInFlightOrderRows(excludeOrderRequestId)]);
  const inFlightNotional = rows.filter((row) => symbolSet.has(row.payload.symbol)).reduce((sum, row) => sum + computeInFlightOrderNotional(row.request_type, row.payload), 0);
  return exposures.reduce((sum, exposure) => sum + exposure, 0) + inFlightNotional;
}

export interface StrategyBookCapitalVerdict {
  committedBeforeDollars: number;
  committedAfterDollars: number;
  /** Pluto's capital budget in dollars: budgetFraction × net liquidation value. */
  capDollars: number;
  fits: boolean;
}

/**
 * Pure A1 (Marcelo 2026-10-21): a strategy opening order goes only if, after it, what Pluto's tickers commit together is at
 * most Pluto's capital budget (budget % × net liquidation value). The round's own check and the order gate's at confirm.
 */
export function strategyBookCapitalVerdict(input: { committedBeforeDollars: number; orderNotional: number; budgetFraction: number; netLiquidationValue: number }): StrategyBookCapitalVerdict {
  const capDollars = input.budgetFraction * input.netLiquidationValue;
  const committedAfterDollars = input.committedBeforeDollars + input.orderNotional;
  // An order that adds nothing (a Call on shares already held) passes even when the book is already over: it only covers shares.
  return { committedBeforeDollars: input.committedBeforeDollars, committedAfterDollars, capDollars, fits: input.orderNotional <= 0 || committedAfterDollars <= capDollars };
}

/** The refusal's wording, for the order gate and the round's notes. */
export function describeStrategyBookCapitalRefusal(verdict: StrategyBookCapitalVerdict): string {
  return `Pluto's tickers would commit ${formatWholeDollars(verdict.committedAfterDollars)} together, above Pluto's book value of ${formatWholeDollars(verdict.capDollars)}; ${formatWholeDollars(verdict.committedBeforeDollars)} is already committed, counting orders still working.`;
}

async function computeOrderNotionalForInput(input: OrderLimitsInput, spotPrice: number): Promise<number> {
  const needsShares = input.strategyKey === "covered_call" && input.rollFromStrike === undefined;
  if (needsShares && input.strategy) return input.strategy.stockSharesBought * Math.max(0, spotPrice - input.premium);
  if (needsShares && input.stockSharesBought !== undefined) return input.stockSharesBought * Math.max(0, spotPrice - input.premium);
  return computeOrderNotional(input, spotPrice, needsShares ? await fetchAvailableUncoveredShares(input.tickerId) : 0);
}

export async function evaluateOrderLimits(input: OrderLimitsInput): Promise<OrderLimitsResult> {
  // Imported here: the books read this file's in-flight helpers.
  const { loadBooksLiveState, loadPlutoBookSymbolsNow } = await import("../books/bookFigures.js");
  const { bookLabels } = await import("../books/bookKeys.js");
  let books: Awaited<ReturnType<typeof loadBooksLiveState>>;
  let plutoSymbols: Set<string>;
  let existingTickerExposure: number;
  let settings: Awaited<ReturnType<typeof loadTradingSettings>>;
  let spotPrice: number | null;
  let inFlight: InFlightTotals;
  let strategyBookCommitted: number | undefined;
  try {
    [books, plutoSymbols, existingTickerExposure, settings, spotPrice, inFlight, strategyBookCommitted] = await Promise.all([
      loadBooksLiveState({ excludeOrderRequestId: input.excludeOrderRequestId }),
      loadPlutoBookSymbolsNow(),
      computeTickerExposure(input.symbol),
      loadTradingSettings(),
      resolveSpotPrice(input),
      loadInFlightNotionals(input.symbol, input.excludeOrderRequestId),
      input.strategy ? loadCommittedCapitalOnSymbols(input.strategy.book.symbols, input.excludeOrderRequestId) : Promise.resolve(undefined),
    ]);
  } catch (error) {
    return { blocked: true, reasons: [`Could not verify position limits: ${error instanceof Error ? error.message : String(error)}`] };
  }

  if (!books.ready) {
    return { blocked: true, reasons: ["The Pluto and Manual books have not been started yet, so no opening order can be placed."] };
  }
  if (spotPrice === null) {
    return { blocked: true, reasons: ["Could not fetch a live stock price to verify position limits."] };
  }

  const book: BookKey = input.strategy || plutoSymbols.has(input.symbol) ? "pluto" : "manual";
  const bookFigures = books.books[book];
  if (bookFigures.availableCash === null) {
    return { blocked: true, reasons: ["Could not verify position limits: IBKR's cash is unavailable."] };
  }
  const totalPortfolioValue = bookFigures.bookValue;
  if (!(totalPortfolioValue > 0)) {
    return { blocked: true, reasons: [`The ${bookLabels[book]} book's value is ${formatWholeDollars(totalPortfolioValue)}, so it cannot open positions.`] };
  }
  // The book's usable cash: what is available plus what its Puts, working orders and reserve hold, which the limits take off again.
  const usableCash = bookFigures.availableCash + bookFigures.heldAgainstPuts + bookFigures.ordersWorking + bookFigures.minCashReserve;

  const orderNotional = await computeOrderNotionalForInput(input, spotPrice);
  const strategyBook = input.strategy && strategyBookCommitted !== undefined ? { committedBeforeDollars: strategyBookCommitted, budgetFraction: input.strategy.book.budgetFraction } : undefined;
  const result = evaluateOrderLimitFigures({
    symbol: input.symbol,
    orderNotional,
    totalPortfolioValue,
    totalCashValue: usableCash,
    cashLockedInCsps: bookFigures.heldAgainstPuts,
    existingTickerExposure,
    inFlight: { totalNotional: bookFigures.ordersWorking, tickerNotional: inFlight.tickerNotional },
    settings,
    strategyPotFraction: input.strategy?.potFraction,
    strategyBook,
    valueLabel: `the ${bookLabels[book]} book's value`,
  });
  if (result.details) result.details.book = { book, bookValue: bookFigures.bookValue, availableCash: bookFigures.availableCash };
  return result;
}

export interface OrderLimitFigures {
  symbol: string;
  orderNotional: number;
  /** Net liquidation value, > 0. */
  totalPortfolioValue: number;
  totalCashValue: number | null;
  cashLockedInCsps: number;
  existingTickerExposure: number;
  inFlight: InFlightTotals;
  settings: Pick<TradingSettings, "maxOrderPctOfPortfolio" | "maxConcentrationPerTickerPct" | "minCashReservePct">;
  /**
   * A Pluto strategy's order (Vol Farmer v4's): its pot as a share of the account, the pot cap in
   * place of the max order size and concentration limits; null for an order with no pot cap (a v4 LEAPS), which gets the book's alone.
   */
  strategyPotFraction?: number | null;
  /** A Pluto strategy order: what Pluto's tickers commit before it (counting orders still working) and Pluto's capital budget as a share of the account. */
  strategyBook?: { committedBeforeDollars: number; budgetFraction: number };
  /** What the limits' wording calls the value they are measured on (default "portfolio value"; a live order: its book's). */
  valueLabel?: string;
}

/** Pure: the three limits on figures already read (the live gate reads them from IBKR and the book; a backtest from its simulated book). */
export function evaluateOrderLimitFigures(figures: OrderLimitFigures): OrderLimitsResult {
  const { orderNotional, totalPortfolioValue, existingTickerExposure, inFlight, settings } = figures;
  const valueLabel = figures.valueLabel ?? "portfolio value";
  const freeCash = Math.max(0, (figures.totalCashValue ?? 0) - figures.cashLockedInCsps - inFlight.totalNotional);
  const workingOrdersNote = inFlight.totalNotional > 0 ? ` (counting ${formatWholeDollars(inFlight.totalNotional)} of orders still working)` : "";

  const reasons: string[] = [];

  // Compared in dollars, not as fraction x 100 against the percentage: 0.07 * 100 is 7.000000000000001, which would block an order
  // sitting exactly at a 7% limit.
  const limitInDollars = (limitPct: number) => (limitPct * totalPortfolioValue) / 100;

  const orderSharePct = orderNotional / totalPortfolioValue;
  const tickerExposureAfter = existingTickerExposure + inFlight.tickerNotional + orderNotional;
  const concentrationAfterPct = tickerExposureAfter / totalPortfolioValue;
  const strategyPotDollars = figures.strategyPotFraction === undefined || figures.strategyPotFraction === null ? undefined : figures.strategyPotFraction * totalPortfolioValue;
  const strategyBook = figures.strategyBook && strategyBookCapitalVerdict({ ...figures.strategyBook, orderNotional, netLiquidationValue: totalPortfolioValue });
  if (figures.strategyPotFraction !== undefined) {
    if (strategyPotDollars !== undefined && tickerExposureAfter > strategyPotDollars) {
      reasons.push(`${figures.symbol} would be ${formatWholeDollars(tickerExposureAfter)}, above its Pluto pot of ${formatWholeDollars(strategyPotDollars)} (${formatPct(figures.strategyPotFraction!)} of ${valueLabel})${workingOrdersNote}.`);
    }
    if (strategyBook && !strategyBook.fits) reasons.push(describeStrategyBookCapitalRefusal(strategyBook));
  } else {
    if (orderNotional > limitInDollars(settings.maxOrderPctOfPortfolio)) {
      reasons.push(`This order is ${formatPct(orderSharePct)} of ${valueLabel}, above the ${settings.maxOrderPctOfPortfolio}% max order size.`);
    }
    if (tickerExposureAfter > limitInDollars(settings.maxConcentrationPerTickerPct)) {
      reasons.push(`${figures.symbol} would be ${formatPct(concentrationAfterPct)} of ${valueLabel}, above the ${settings.maxConcentrationPerTickerPct}% max concentration per ticker${workingOrdersNote}.`);
    }
  }

  const cashAfter = freeCash - orderNotional;
  const cashReserveAfterPct = cashAfter / totalPortfolioValue;
  if (cashAfter < limitInDollars(settings.minCashReservePct)) {
    reasons.push(`Placing this order would leave only ${formatPct(cashReserveAfterPct)} of ${valueLabel} as cash, below the ${settings.minCashReservePct}% min cash reserve${workingOrdersNote}.`);
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    details: {
      orderNotional,
      totalPortfolioValue,
      orderSharePct,
      concentrationAfterPct,
      cashReserveAfterPct,
      inFlightNotional: inFlight.totalNotional,
      limits: { maxOrderPctOfPortfolio: settings.maxOrderPctOfPortfolio, maxConcentrationPerTickerPct: settings.maxConcentrationPerTickerPct, minCashReservePct: settings.minCashReservePct },
      ...(strategyPotDollars === undefined ? {} : { strategyPotDollars }),
      ...(strategyBook ? { strategyBook } : {}),
    },
  };
}
