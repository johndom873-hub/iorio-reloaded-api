import { easternInstant } from "../lib/easternIsoDate.js";
import { parseFlexDateTime, statementSectionRows, type StatementRow } from "../lib/flexCashFlowAssignment.js";
import type { BookKey, LedgerBookKey } from "./bookKeys.js";
import { splitAmountByWeights } from "./proRataSplit.js";

// Turns IBKR's nightly statement (Flex) into the books' ledger entries (Marcelo 2026-11-05). Every row that moves cash
// goes to a book or to Unallocated, so the ledger's total follows IBKR's ending cash to the cent:
//   startingCash + Σ trades' net cash + Σ cash transactions + Σ cash transfers + Σ sales taxes not inside a trade = endingCash
// (checked on the live 05 Oct–03 Nov statement: 0.0000 off).
//
// Who gets each row:
//   Trades (fills, assignments and expiries; net cash includes commission and its GST): the book of the ticker at the
//     fill, Manual for a hedge's option.
//   Dividends, payments in lieu, withholding tax with a symbol: the book of the ticker on the ex-date.
//   Interest (credited monthly, "FOR SEP-2026"): split by each book's daily cash over that month; withholding on interest the same.
//   Other fees and commission adjustments: the ticker's book when they name one, else split by book value.
//   Sales tax on a trade is already in its net cash and is skipped; on a fee it follows the fee.
//   Deposits, withdrawals and cash transfers: Unallocated, until an admin splits them.
//   Anything else (an unknown type, a corporate action paying cash): the ticker's book, or split by book value, flagged
//     for review so an admin can re-assign it.

export type StatementEntryKind = "trade" | "dividend" | "withholding_tax" | "interest" | "fee" | "sales_tax" | "commission_adjustment" | "corporate_action" | "other_statement_row" | "external_transfer";

export interface StatementEntryDraft {
  bookKey: LedgerBookKey;
  amount: number;
  effectiveAt: Date;
  kind: StatementEntryKind;
  /** The statement row's identity, e.g. "trade:1020366327": the same row read again adds nothing. */
  sourceRowKey: string;
  symbol: string | null;
  description: string;
  needsReview: boolean;
  statementRow: Record<string, string>;
}

export interface StatementAttributionContext {
  /** The book of a ticker symbol at a moment; a symbol the app does not know is Manual's. */
  bookOfSymbolAt(symbol: string, at: Date): BookKey;
  /** True when an option contract (IBKR conid) is a leg of a hedge position. */
  isHedgeOptionContract(conid: string): boolean;
  /** Each book's value at the last nightly snapshot before `at`. */
  bookValueWeightsAt(at: Date): Record<BookKey, number>;
  /** Each book's end-of-day cash summed over the days of [startIso, endIso] (YYYY-MM-DD, inclusive). */
  dailyCashWeightsBetween(startIso: string, endIso: string): Record<BookKey, number>;
}

export interface ParsedStatement {
  fromDate: string;
  toDate: string;
  whenGenerated: string | null;
  startingCash: number | null;
  endingCash: number | null;
  entries: StatementEntryDraft[];
  /** Rows the statement holds that cannot be posted (a securities transfer, a malformed amount). */
  problems: string[];
  /** Every row key in the statement, posted or not (the cut-over keeps those already in its opening cash). */
  rowKeys: string[];
}

/**
 * Why the statement's base currency is not the US dollar, or null when it is (Marcelo 2026-11-05: Iorio reports
 * everything in USD). The books are in dollars and the statement's ending cash is in its base currency, so a USD row
 * converted to base at anything but 1 means the statement cannot be used. A statement with no USD row cannot tell.
 */
export function statementBaseCurrencyProblem(statement: Record<string, unknown>): string | null {
  for (const section of ["Trades", "CashTransactions", "SalesTaxes", "Transfers"]) {
    const row = statementSectionRows(statement[section]).find((candidate) => candidate.currency === "USD" && candidate.fxRateToBase !== undefined && candidate.fxRateToBase !== "" && Number(candidate.fxRateToBase) !== 1);
    if (row) return `IBKR's statement is not in US dollars (a USD row converts to its base at ${row.fxRateToBase}), so the books cannot use it`;
  }
  return null;
}

function isoFromFlexDate(flexDate: string): string {
  return `${flexDate.slice(0, 4)}-${flexDate.slice(4, 6)}-${flexDate.slice(6, 8)}`;
}

/** A Flex timestamp as a moment; a date with no time is the start of that day, New York time. */
export function flexMoment(dateTime: string): Date {
  const { isoDate, occurredAt } = parseFlexDateTime(dateTime);
  return occurredAt ?? easternInstant(isoDate, 0, 0);
}

/** The moment a statement ending on `toDate` (YYYYMMDD) stops: the start of the next day, New York time. */
export function statementCutOffAt(toDate: string): Date {
  const next = new Date(`${isoFromFlexDate(toDate)}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return easternInstant(next.toISOString().slice(0, 10), 0, 0);
}

const monthNumbers: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

/** The month an interest row is for: "USD CREDIT INT FOR SEP-2026" → 2026-09-01..2026-09-30; else the month before the row's date. */
export function interestPeriodOf(description: string, rowIsoDate: string): { startIso: string; endIso: string } {
  const match = /FOR ([A-Z]{3})-(\d{4})/.exec(description.toUpperCase());
  let year: number;
  let month: number;
  const matchedMonth = match?.[1] === undefined ? undefined : monthNumbers[match[1]];
  if (match && matchedMonth !== undefined) {
    year = Number(match[2]);
    month = matchedMonth;
  } else {
    const rowDate = new Date(`${rowIsoDate}T12:00:00Z`);
    rowDate.setUTCMonth(rowDate.getUTCMonth() - 1);
    year = rowDate.getUTCFullYear();
    month = rowDate.getUTCMonth() + 1;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthText = String(month).padStart(2, "0");
  return { startIso: `${year}-${monthText}-01`, endIso: `${year}-${monthText}-${String(lastDay).padStart(2, "0")}` };
}

function symbolOf(row: StatementRow): string | null {
  const symbol = (row.underlyingSymbol || row.symbol || "").trim().toUpperCase();
  return symbol === "" ? null : symbol;
}

/** A fill as its sales-tax row names it: trade date, side, share or contract count and contract, spaces collapsed. */
function tradeTaxKey(dateText: string | undefined, side: string | undefined, quantity: string | undefined, contract: string | undefined): string {
  return [String(dateText ?? "").slice(0, 8), String(side ?? "").toUpperCase(), Math.abs(Number(String(quantity ?? "").replace(/,/g, ""))), String(contract ?? "").trim().replace(/\s+/g, " ").toUpperCase()].join("|");
}

function amountOf(text: string | undefined): number | null {
  if (text === undefined || text.trim() === "") return null;
  const amount = Number(text);
  return Number.isFinite(amount) ? amount : null;
}

const depositWithdrawalTypes = new Set(["deposits & withdrawals", "deposits/withdrawals"]);
const dividendTypes = new Set(["dividends", "payment in lieu of dividends"]);
const interestTypes = new Set(["broker interest received", "broker interest paid", "bond interest received", "bond interest paid", "broker fees"]);

interface Placement {
  /** One book, or a split by weights. */
  book?: BookKey | "unallocated";
  weights?: Record<BookKey, number>;
  needsReview: boolean;
}

export function attributeStatement(statement: Record<string, unknown>, context: StatementAttributionContext): ParsedStatement {
  const entries: StatementEntryDraft[] = [];
  const problems: string[] = [];
  const rowKeys: string[] = [];
  const fromDate = String(statement.fromDate ?? "");
  const toDate = String(statement.toDate ?? "");
  const cashReport = statementSectionRows(statement.CashReport).find((row) => row.levelOfDetail === "BaseCurrency");

  const place = (row: StatementRow, sourceRowKey: string, amount: number, effectiveAt: Date, kind: StatementEntryKind, description: string, placement: Placement) => {
    const symbol = symbolOf(row);
    if (placement.book !== undefined) {
      entries.push({ bookKey: placement.book, amount, effectiveAt, kind, sourceRowKey, symbol, description, needsReview: placement.needsReview, statementRow: row });
      return;
    }
    const parts = splitAmountByWeights(amount, placement.weights!);
    for (const book of ["pluto", "manual"] as const) {
      entries.push({ bookKey: book, amount: parts[book], effectiveAt, kind, sourceRowKey, symbol, description, needsReview: placement.needsReview, statementRow: row });
    }
  };

  // Trades: fills, assignments ("A") and expiries ("Ep"), each with its net cash.
  const tradeTaxKeys = new Set<string>();
  for (const row of statementSectionRows(statement.Trades)) {
    if (row.levelOfDetail !== undefined && row.levelOfDetail !== "EXECUTION") continue;
    const sourceRowKey = `trade:${row.transactionID}`;
    rowKeys.push(sourceRowKey);
    tradeTaxKeys.add(tradeTaxKey(row.tradeDate, row.buySell, row.quantity, row.symbol));
    const amount = amountOf(row.netCash);
    const symbol = symbolOf(row);
    if (amount === null || symbol === null || !row.dateTime) {
      problems.push(`trade ${row.transactionID}: no net cash, symbol or time`);
      continue;
    }
    if (amount === 0) continue;
    const at = flexMoment(row.dateTime);
    const book = row.assetCategory === "OPT" && context.isHedgeOptionContract(String(row.conid ?? "")) ? "manual" : context.bookOfSymbolAt(symbol, at);
    place(row, sourceRowKey, amount, at, "trade", `${row.buySell} ${Math.abs(Number(row.quantity))} ${row.description || row.symbol}`.trim(), { book, needsReview: false });
  }

  // Cash transactions: fees, interest, dividends, taxes, deposits.
  const placementByCashTransactionId = new Map<string, { placement: Placement; at: Date }>();
  for (const row of statementSectionRows(statement.CashTransactions)) {
    if (row.levelOfDetail !== undefined && row.levelOfDetail !== "DETAIL") continue;
    const sourceRowKey = `cash:${row.transactionID}`;
    rowKeys.push(sourceRowKey);
    const amount = amountOf(row.amount);
    if (amount === null || !row.dateTime) {
      problems.push(`cash transaction ${row.transactionID}: no amount or time`);
      continue;
    }
    const at = flexMoment(row.dateTime);
    const type = String(row.type ?? "").trim().toLowerCase();
    const symbol = symbolOf(row);
    const description = String(row.description ?? row.type ?? "");
    let kind: StatementEntryKind;
    let placement: Placement;
    if (depositWithdrawalTypes.has(type)) {
      kind = "external_transfer";
      placement = { book: "unallocated", needsReview: false };
    } else if (dividendTypes.has(type) || (type === "withholding tax" && symbol !== null)) {
      kind = dividendTypes.has(type) ? "dividend" : "withholding_tax";
      const exDate = row.exDate ? flexMoment(row.exDate) : at;
      placement = symbol === null ? { weights: context.bookValueWeightsAt(at), needsReview: true } : { book: context.bookOfSymbolAt(symbol, exDate), needsReview: false };
    } else if (interestTypes.has(type) || (type === "withholding tax" && /\bINT\b/i.test(description))) {
      kind = type === "withholding tax" ? "withholding_tax" : "interest";
      const period = interestPeriodOf(description, parseFlexDateTime(row.dateTime).isoDate);
      placement = { weights: context.dailyCashWeightsBetween(period.startIso, period.endIso), needsReview: false };
    } else if (type === "other fees" || type === "commission adjustments") {
      kind = type === "other fees" ? "fee" : "commission_adjustment";
      placement = symbol === null ? { weights: context.bookValueWeightsAt(at), needsReview: false } : { book: context.bookOfSymbolAt(symbol, at), needsReview: false };
    } else {
      kind = "other_statement_row";
      placement = symbol === null ? { weights: context.bookValueWeightsAt(at), needsReview: true } : { book: context.bookOfSymbolAt(symbol, at), needsReview: true };
    }
    placementByCashTransactionId.set(String(row.transactionID), { placement, at });
    if (amount === 0) continue;
    place(row, sourceRowKey, amount, at, kind, description, placement);
  }

  // Sales taxes (Singapore GST): on a fee it follows the fee (linked by taxableTransactionID); on a trade it is already
  // in the trade's net cash. A trade's tax row carries no link to the trade, only its words and date: "SG Goods and
  // Services Tax (Sell 1 BMNR  261009P00024500)" on the fill's trade date.
  for (const row of statementSectionRows(statement.SalesTaxes)) {
    const sourceRowKey = `tax:${row.transactionID}`;
    rowKeys.push(sourceRowKey);
    const taxed = placementByCashTransactionId.get(String(row.taxableTransactionID ?? ""));
    const taxedTrade = /\((Buy|Sell) ([\d,.]+) (.+)\)\s*$/i.exec(String(row.taxableDescription ?? ""));
    if (!taxed && taxedTrade && tradeTaxKeys.has(tradeTaxKey(row.date, taxedTrade[1], taxedTrade[2], taxedTrade[3]))) continue;
    const amount = amountOf(row.salesTax);
    if (amount === null || !row.date) {
      problems.push(`sales tax ${row.transactionID}: no amount or date`);
      continue;
    }
    if (amount === 0) continue;
    const at = taxed?.at ?? flexMoment(row.date);
    const placement: Placement = taxed ? { ...taxed.placement, needsReview: taxed.placement.needsReview } : { weights: context.bookValueWeightsAt(at), needsReview: true };
    place(row, sourceRowKey, amount, at, "sales_tax", String(row.taxableDescription ?? "Sales tax"), placement);
  }

  // Transfers: cash in or out of the account waits in Unallocated; securities transfers are not handled.
  for (const row of statementSectionRows(statement.Transfers)) {
    const sourceRowKey = `transfer:${row.transactionID || [row.dateTime ?? row.date, row.direction, row.cashTransfer, row.description].join("|")}`;
    rowKeys.push(sourceRowKey);
    if (row.assetCategory !== "CASH") {
      problems.push(`transfer of ${row.assetCategory || "securities"} on ${row.date}: not posted, needs a person`);
      continue;
    }
    const cashAmount = amountOf(row.cashTransfer);
    const direction = String(row.direction ?? "").toUpperCase();
    const timestamp = row.dateTime || row.date;
    if (cashAmount === null || (direction !== "IN" && direction !== "OUT") || !timestamp) {
      problems.push(`transfer on ${row.date}: no amount, direction or time`);
      continue;
    }
    const rateToBase = amountOf(row.fxRateToBase) ?? 1;
    const amount = (direction === "IN" ? 1 : -1) * Math.abs(cashAmount) * rateToBase;
    if (amount === 0) continue;
    place(row, sourceRowKey, amount, flexMoment(timestamp), "external_transfer", String(row.description ?? "Transfer"), { book: "unallocated", needsReview: false });
  }

  // Corporate actions: most move no cash (splits); one that does goes to its ticker's book, flagged for review.
  for (const row of statementSectionRows(statement.CorporateActions)) {
    const sourceRowKey = `corporate:${row.transactionID || [row.dateTime ?? row.reportDate, row.symbol, row.description].join("|")}`;
    rowKeys.push(sourceRowKey);
    const amount = amountOf(row.proceeds) ?? amountOf(row.amount) ?? 0;
    if (amount === 0) continue;
    const timestamp = row.dateTime || row.reportDate;
    const symbol = symbolOf(row);
    if (!timestamp) {
      problems.push(`corporate action ${row.description}: no time`);
      continue;
    }
    const at = flexMoment(timestamp);
    place(row, sourceRowKey, amount, at, "corporate_action", String(row.description ?? "Corporate action"), symbol === null ? { weights: context.bookValueWeightsAt(at), needsReview: true } : { book: context.bookOfSymbolAt(symbol, at), needsReview: true });
  }

  return {
    fromDate,
    toDate,
    whenGenerated: statement.whenGenerated === undefined ? null : String(statement.whenGenerated),
    startingCash: amountOf(cashReport?.startingCash),
    endingCash: amountOf(cashReport?.endingCash),
    entries,
    problems,
    rowKeys,
  };
}
