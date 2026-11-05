import { db } from "../db/connection.js";
import { fetchAccountSummary, type AccountSummary } from "../ibkr/fetchAccountSummary.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { settledCashForTrading } from "../lib/accountContext.js";
import { environment } from "../config/env.js";
import { computeInFlightOrderNotional, inFlightOrderRequestsQuery } from "../lib/orderLimits.js";
import { loadOpenLegMarketValues } from "../lib/positionExposure.js";
import { loadTradingSettings } from "../lib/tradingSettingsStore.js";
import { bookKeys, otherBook, type BookKey } from "./bookKeys.js";
import { loadBooksCutover, loadConfirmedLedgerCutOffAt, loadLedgerCashByBook, loadProvisionalCashMovements, loadUnsettledSaleProceedsByBook } from "./bookLedger.js";
import { bookOfLegAt, loadTickerBookPeriods, strategiesAlwaysInManualBook } from "./tickerBookPeriods.js";

// Each book's live figures (Marcelo 2026-11-05; formulas approved the same day). For a book B with the other book O:
//   cash(B)          = confirmed ledger cash + cash moved since the last statement (bookLedger.ts)
//   book value(B)    = cash(B) + market value of B's open legs (short legs negative; a Put's collateral is cash, not counted twice)
//   usable cash(B)   = the smaller of cash(B) and IBKR's live total cash − cash(O) − Unallocated
//   settled(B)       = cash(B) − B's sale proceeds not settled yet; usable settled the same way against IBKR's settled cash
//   available(B)     = usable cash(B) − what B's open Puts hold − B's orders still working − min cash reserve % × book value(B)
// The guard (usable cash) means a book's own records running ahead of IBKR only ever block that book, never let it
// spend the other's cash. Example: Pluto's ledger says $220,000, Manual's $150,000, nothing unallocated, IBKR $360,000
// (a Pluto assignment not seen yet) → Pluto may use $210,000.

export interface BookLiveFigures {
  book: BookKey;
  cash: number;
  positionsValue: number;
  bookValue: number;
  heldAgainstPuts: number;
  ordersWorking: number;
  minCashReserve: number;
  /** What an opening order of this book may use now; null when IBKR's cash is unknown (orders are then blocked). */
  availableCash: number | null;
  /** The same, on settled cash (a cash account buys with settled cash only); null when unknown. */
  availableSettledCash: number | null;
  /** True when IBKR's live cash, not the book's own ledger, set the usable cash. */
  limitedByAccountCash: boolean;
}

export type BooksLiveState =
  | { ready: false }
  | {
      ready: true;
      books: Record<BookKey, BookLiveFigures>;
      unallocatedCash: number;
      ibkrTotalCash: number | null;
      ibkrNetLiquidationValue: number | null;
      /** IBKR's live cash − (both books + Unallocated); null when IBKR's cash is unknown. */
      cashGapAgainstIbkr: number | null;
      confirmedThrough: Date;
      minCashReservePct: number;
    };

export interface BookFiguresInput {
  ledgerCash: Record<BookKey | "unallocated", number>;
  provisionalCash: Record<BookKey, number>;
  unsettledSaleProceeds: Record<BookKey, number>;
  positionsValue: Record<BookKey, number>;
  heldAgainstPuts: Record<BookKey, number>;
  ordersWorking: Record<BookKey, number>;
  minCashReservePct: number;
  ibkrTotalCash: number | null;
  ibkrSettledCash: number | null;
}

/** Pure: both books' figures from their parts (the header's formulas). */
export function computeBookFigures(input: BookFiguresInput): { books: Record<BookKey, BookLiveFigures>; cashGapAgainstIbkr: number | null } {
  const cash = { pluto: input.ledgerCash.pluto + input.provisionalCash.pluto, manual: input.ledgerCash.manual + input.provisionalCash.manual };
  const settled = { pluto: cash.pluto - input.unsettledSaleProceeds.pluto, manual: cash.manual - input.unsettledSaleProceeds.manual };
  const unallocated = input.ledgerCash.unallocated;
  const books = {} as Record<BookKey, BookLiveFigures>;
  for (const book of bookKeys) {
    const other = otherBook(book);
    const bookValue = cash[book] + input.positionsValue[book];
    const minCashReserve = (input.minCashReservePct / 100) * bookValue;
    const commitments = input.heldAgainstPuts[book] + input.ordersWorking[book] + minCashReserve;
    const accountCashLeft = input.ibkrTotalCash === null ? null : input.ibkrTotalCash - cash[other] - unallocated;
    const accountSettledLeft = input.ibkrSettledCash === null ? null : input.ibkrSettledCash - settled[other] - unallocated;
    const usableCash = accountCashLeft === null ? null : Math.min(cash[book], accountCashLeft);
    const usableSettled = accountSettledLeft === null ? null : Math.min(settled[book], accountSettledLeft);
    books[book] = {
      book,
      cash: cash[book],
      positionsValue: input.positionsValue[book],
      bookValue,
      heldAgainstPuts: input.heldAgainstPuts[book],
      ordersWorking: input.ordersWorking[book],
      minCashReserve,
      availableCash: usableCash === null ? null : usableCash - commitments,
      availableSettledCash: usableSettled === null ? null : usableSettled - commitments,
      limitedByAccountCash: accountCashLeft !== null && accountCashLeft < cash[book],
    };
  }
  const cashGapAgainstIbkr = input.ibkrTotalCash === null ? null : input.ibkrTotalCash - (cash.pluto + cash.manual + unallocated);
  return { books, cashGapAgainstIbkr };
}

const zeroByBook = (): Record<BookKey, number> => ({ pluto: 0, manual: 0 });

/** The cash each book's open cash-secured Puts hold (strike × multiplier × quantity of the position's latest Put leg). */
async function loadHeldAgainstPutsByBook(periods: Awaited<ReturnType<typeof loadTickerBookPeriods>>, now: Date): Promise<Record<BookKey, number>> {
  const result = await db.raw(`
    SELECT p.ticker_id, p.strategy_key,
      (SELECT pl.strike_price * pl.multiplier * pl.quantity FROM position_legs pl
       WHERE pl.position_id = p.id AND pl.leg_type = 'option'
       ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC LIMIT 1)::text AS reserved
    FROM positions p WHERE p.status = 'open' AND p.strategy_key = 'cash_secured_put'`);
  const totals = zeroByBook();
  for (const row of result.rows as { ticker_id: string; strategy_key: string; reserved: string | null }[]) {
    totals[bookOfLegAt(periods, row.ticker_id, row.strategy_key, now)] += Number(row.reserved ?? 0);
  }
  return totals;
}

/** Each book's orders still on their way to or working at IBKR: Pluto's own orders and every order on a Pluto ticker are Pluto's. */
export async function loadOrdersWorkingByBook(plutoSymbolsNow: ReadonlySet<string>, excludeOrderRequestId?: string): Promise<Record<BookKey, number>> {
  let query = inFlightOrderRequestsQuery().select("orq.request_type", "orq.payload", "orq.pluto_action_id");
  if (excludeOrderRequestId) query = query.whereNot("orq.id", excludeOrderRequestId);
  const rows: { request_type: string; payload: OrderRequestPayload; pluto_action_id: string | null }[] = await query;
  const totals = zeroByBook();
  for (const row of rows) {
    const strategyKey = String(row.payload.strategyKey ?? "");
    const book: BookKey = row.pluto_action_id !== null || (plutoSymbolsNow.has(row.payload.symbol) && !strategiesAlwaysInManualBook.includes(strategyKey)) ? "pluto" : "manual";
    totals[book] += computeInFlightOrderNotional(row.request_type, row.payload);
  }
  return totals;
}

/** The symbols Pluto's book holds now (an open ticker_book_periods row). */
export async function loadPlutoBookSymbolsNow(): Promise<Set<string>> {
  const rows: { symbol: string }[] = await db("ticker_book_periods as tbp").join("tickers as t", "t.id", "tbp.ticker_id").whereNull("tbp.ended_at").select("t.symbol");
  return new Set(rows.map((row) => row.symbol));
}

export interface LoadBooksLiveStateOptions {
  now?: Date;
  fetchSummary?: () => Promise<AccountSummary>;
  /** An order being checked, left out of the orders still working (it is not working against itself). */
  excludeOrderRequestId?: string;
}

/** Both books' live figures; `ready: false` until the cut-over has run (opening orders are then refused). */
export async function loadBooksLiveState(options: LoadBooksLiveStateOptions = {}): Promise<BooksLiveState> {
  const now = options.now ?? new Date();
  const cutover = await loadBooksCutover();
  if (!cutover) return { ready: false };
  const periods = await loadTickerBookPeriods();
  const confirmedThrough = await loadConfirmedLedgerCutOffAt(cutover);
  const [ledgerCash, provisional, legValues, heldAgainstPuts, plutoSymbolsNow, tradingSettings, summary] = await Promise.all([
    loadLedgerCashByBook(null),
    loadProvisionalCashMovements(confirmedThrough, periods),
    loadOpenLegMarketValues(),
    loadHeldAgainstPutsByBook(periods, now),
    loadPlutoBookSymbolsNow(),
    loadTradingSettings(),
    (options.fetchSummary ?? fetchAccountSummary)().catch(() => null),
  ]);
  const [unsettledSaleProceeds, ordersWorking] = await Promise.all([loadUnsettledSaleProceedsByBook(provisional, now), loadOrdersWorkingByBook(plutoSymbolsNow, options.excludeOrderRequestId)]);
  const provisionalCash = zeroByBook();
  for (const movement of provisional) provisionalCash[movement.book] += movement.amount;
  const positionsValue = zeroByBook();
  for (const leg of legValues) positionsValue[bookOfLegAt(periods, leg.tickerId, leg.strategyKey, now)] += leg.marketValue;
  const settled = summary === null ? null : settledCashForTrading(summary, environment.ibkrTradingMode).settledCash;
  const { books, cashGapAgainstIbkr } = computeBookFigures({
    ledgerCash,
    provisionalCash,
    unsettledSaleProceeds,
    positionsValue,
    heldAgainstPuts,
    ordersWorking,
    minCashReservePct: tradingSettings.minCashReservePct,
    ibkrTotalCash: summary?.totalCashValue ?? null,
    ibkrSettledCash: settled,
  });
  return {
    ready: true,
    books,
    unallocatedCash: ledgerCash.unallocated,
    ibkrTotalCash: summary?.totalCashValue ?? null,
    ibkrNetLiquidationValue: summary?.netLiquidationValue ?? null,
    cashGapAgainstIbkr,
    confirmedThrough,
    minCashReservePct: tradingSettings.minCashReservePct,
  };
}
