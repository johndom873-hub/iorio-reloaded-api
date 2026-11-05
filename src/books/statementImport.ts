import { randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { easternInstant, easternIsoDate } from "../lib/easternIsoDate.js";
import type { BookKey } from "./bookKeys.js";
import { loadBooksCutover } from "./bookLedger.js";
import { attributeStatement, statementBaseCurrencyProblem, statementCutOffAt, type StatementAttributionContext, type StatementEntryDraft } from "./statementAttribution.js";
import { bookOfTickerAt, loadTickerBookPeriods } from "./tickerBookPeriods.js";

// Posts IBKR's nightly statement to the books' ledger and checks it against IBKR's ending cash (Marcelo 2026-11-05).
//
// All or nothing: a statement missing a section the books need (trades, cash transactions, sales taxes, transfers, the
// cash report) posts nothing and leaves the ledger's cut-off where it was, so the app's own fills keep standing in for
// it. Posting part of one would move the cut-off past fills it does not hold.
//
// A row already posted adds nothing (book_cash_entries' source_row_key); one whose amount changed since is reported.
// A row already in the cut-over's opening cash is skipped; a row first seen later, even one dated before the cut-over,
// is new cash and is posted at the cut-over.
//
// The check: every ledger entry before the statement's cut-off (the start of the day after its last day, New York time)
// adds up to its ending cash. A gap means a row was not understood, never lost money: it is reported for a person.

export const statementSectionsTheBooksNeed = ["Trades", "CashTransactions", "SalesTaxes", "Transfers", "CashReport"] as const;

/** Allowed difference between the ledger and IBKR's ending cash: rounding at IBKR's 8 decimals against the ledger's 6. */
export const statementGapToleranceDollars = 0.01;

export interface BooksStatementImportResult {
  posted: boolean;
  toDate: string | null;
  newEntryCount: number;
  gap: number | null;
  needsReviewCount: number;
  problems: string[];
}

const zeroByBook = (): Record<BookKey, number> => ({ pluto: 0, manual: 0 });

/** The attribution's lookups, loaded once per import. */
async function loadAttributionContext(cutOverAt: Date): Promise<StatementAttributionContext> {
  const [periods, tickers, hedgeContracts, snapshots, cashEntries] = await Promise.all([
    loadTickerBookPeriods(),
    db("tickers").select("id", "symbol") as Promise<{ id: string; symbol: string }[]>,
    db("position_legs as pl").join("positions as p", "p.id", "pl.position_id").where("p.strategy_key", "hedge").whereNotNull("pl.ibkr_contract_id").distinct("pl.ibkr_contract_id").pluck("pl.ibkr_contract_id") as Promise<(string | number)[]>,
    db("book_value_snapshots").whereIn("book_key", ["pluto", "manual"]).orderBy("snapshot_date").select(db.raw("snapshot_date::text AS snapshot_date"), "book_key", "book_value") as Promise<{ snapshot_date: string; book_key: BookKey; book_value: string }[]>,
    db("book_cash_entries").whereIn("book_key", ["pluto", "manual"]).orderBy("effective_at").select("book_key", "amount", "effective_at") as Promise<{ book_key: BookKey; amount: string; effective_at: Date }[]>,
  ]);
  const tickerIdBySymbol = new Map(tickers.map((ticker) => [ticker.symbol.toUpperCase(), ticker.id]));
  const hedgeContractIds = new Set(hedgeContracts.map(String));
  const valuesByDate = new Map<string, Record<BookKey, number>>();
  for (const row of snapshots) {
    const values = valuesByDate.get(row.snapshot_date) ?? zeroByBook();
    values[row.book_key] = Number(row.book_value);
    valuesByDate.set(row.snapshot_date, values);
  }
  const snapshotDates = [...valuesByDate.keys()].sort();
  const entries = cashEntries.map((entry) => ({ book: entry.book_key, amount: Number(entry.amount), at: new Date(entry.effective_at).getTime() }));
  const cashBefore = (time: number): Record<BookKey, number> => {
    const totals = zeroByBook();
    for (const entry of entries) if (entry.at < time) totals[entry.book] += entry.amount;
    return totals;
  };
  return {
    bookOfSymbolAt: (symbol, at) => {
      const tickerId = tickerIdBySymbol.get(symbol.toUpperCase());
      return tickerId === undefined ? "manual" : bookOfTickerAt(periods, tickerId, at);
    },
    isHedgeOptionContract: (conid) => hedgeContractIds.has(conid),
    // The last nightly values before the row's day; before the first snapshot, the first one.
    bookValueWeightsAt: (at) => {
      const dayIso = easternIsoDate(at);
      const date = [...snapshotDates].reverse().find((snapshotDate) => snapshotDate < dayIso) ?? snapshotDates[0];
      return date === undefined ? { pluto: 1, manual: 1 } : valuesByDate.get(date)!;
    },
    // Each book's cash at the end of each day (New York), summed; a day before the cut-over counts the opening cash.
    dailyCashWeightsBetween: (startIso, endIso) => {
      const totals = zeroByBook();
      const day = new Date(`${startIso}T12:00:00Z`);
      const end = new Date(`${endIso}T12:00:00Z`);
      while (day.getTime() <= end.getTime()) {
        const next = new Date(day);
        next.setUTCDate(next.getUTCDate() + 1);
        const endOfDay = Math.max(easternInstant(next.toISOString().slice(0, 10), 0, 0).getTime(), cutOverAt.getTime() + 1);
        const cash = cashBefore(endOfDay);
        totals.pluto += Math.max(0, cash.pluto);
        totals.manual += Math.max(0, cash.manual);
        day.setUTCDate(day.getUTCDate() + 1);
      }
      return totals;
    },
  };
}

/** The sections of `statement` the books need that it does not hold (an empty section is held: it reads as ""). */
export function missingStatementSections(statement: Record<string, unknown>): string[] {
  return statementSectionsTheBooksNeed.filter((section) => !(section in statement));
}

export async function importStatementIntoBooks(statement: Record<string, unknown>): Promise<BooksStatementImportResult> {
  const cutover = await loadBooksCutover();
  if (!cutover) return { posted: false, toDate: null, newEntryCount: 0, gap: null, needsReviewCount: 0, problems: [] };
  const toDate = statement.toDate === undefined ? null : String(statement.toDate);
  const missing = missingStatementSections(statement);
  if (missing.length > 0 || toDate === null) {
    return { posted: false, toDate, newEntryCount: 0, gap: null, needsReviewCount: 0, problems: [`IBKR's statement lacks ${missing.join(", ") || "its end date"}: the books keep counting from the app's own fills`] };
  }
  const currencyProblem = statementBaseCurrencyProblem(statement);
  if (currencyProblem !== null) return { posted: false, toDate, newEntryCount: 0, gap: null, needsReviewCount: 0, problems: [currencyProblem] };
  const cutOffAt = statementCutOffAt(toDate);
  if (cutOffAt.getTime() <= cutover.cutOverAt.getTime()) return { posted: false, toDate, newEntryCount: 0, gap: null, needsReviewCount: 0, problems: [] };

  const context = await loadAttributionContext(cutover.cutOverAt);
  const parsed = attributeStatement(statement, context);
  const cutoverRow: { statement_row_keys: string[] } = await db("books_cutover").first("statement_row_keys");
  const inOpeningCash = new Set(cutoverRow.statement_row_keys);
  const drafts = parsed.entries.filter((entry) => !inOpeningCash.has(entry.sourceRowKey) && !(cutover.statementToDate === null && entry.effectiveAt.getTime() < cutover.cutOverAt.getTime()));
  const draftsByRow = new Map<string, StatementEntryDraft[]>();
  for (const draft of drafts) draftsByRow.set(draft.sourceRowKey, [...(draftsByRow.get(draft.sourceRowKey) ?? []), draft]);

  const problems = [...parsed.problems];
  let newEntryCount = 0;
  let needsReviewCount = 0;
  let gap: number | null = null;
  let ledgerCash = 0;
  await db.transaction(async (trx) => {
    const existing: { source_row_key: string; total: string }[] = await trx("book_cash_entries").whereIn("source_row_key", [...draftsByRow.keys()]).groupBy("source_row_key").select("source_row_key", trx.raw("SUM(amount)::text AS total"));
    const existingTotalByRow = new Map(existing.map((row) => [row.source_row_key, Number(row.total)]));
    for (const [sourceRowKey, rowDrafts] of draftsByRow) {
      const total = rowDrafts.reduce((sum, draft) => sum + draft.amount, 0);
      const existingTotal = existingTotalByRow.get(sourceRowKey);
      if (existingTotal !== undefined) {
        if (Math.abs(existingTotal - total) > 1e-6) problems.push(`statement row ${sourceRowKey} now reads ${total.toFixed(2)}, posted as ${existingTotal.toFixed(2)}`);
        continue;
      }
      const groupId = randomUUID();
      await trx("book_cash_entries").insert(
        rowDrafts.map((draft) => ({
          book_key: draft.bookKey,
          amount: draft.amount,
          effective_at: new Date(Math.max(draft.effectiveAt.getTime(), cutover.cutOverAt.getTime())),
          kind: draft.kind,
          source_row_key: draft.sourceRowKey,
          group_id: groupId,
          symbol: draft.symbol,
          description: draft.description,
          needs_review: draft.needsReview,
          statement_row: draft.statementRow,
        })),
      );
      newEntryCount += rowDrafts.length;
      if (rowDrafts.some((draft) => draft.needsReview)) needsReviewCount++;
    }
    const ledger = await trx("book_cash_entries").where("effective_at", "<", cutOffAt).sum({ total: "amount" }).first();
    ledgerCash = Number(ledger?.total ?? 0);
    gap = parsed.endingCash === null ? null : parsed.endingCash - ledgerCash;
    if (gap === null) problems.push("IBKR's statement has no ending cash: the books could not be checked against it");
    else if (Math.abs(gap) >= statementGapToleranceDollars) problems.push(`the books' cash differs from IBKR's ending cash of ${toDate} by ${gap.toFixed(2)}`);
    await trx("book_statement_imports").insert({
      from_date: `${parsed.fromDate.slice(0, 4)}-${parsed.fromDate.slice(4, 6)}-${parsed.fromDate.slice(6, 8)}`,
      to_date: `${toDate.slice(0, 4)}-${toDate.slice(4, 6)}-${toDate.slice(6, 8)}`,
      generated_at: parsed.whenGenerated,
      cut_off_at: cutOffAt,
      ending_cash: parsed.endingCash,
      ledger_cash: ledgerCash,
      gap,
      new_entry_count: newEntryCount,
      problems: JSON.stringify(problems),
    });
  });
  if (needsReviewCount > 0) problems.push(`${needsReviewCount} statement row(s) could not be matched to a book and were split by book value: review them on Risk & Limits`);
  return { posted: true, toDate, newEntryCount, gap, needsReviewCount, problems };
}
