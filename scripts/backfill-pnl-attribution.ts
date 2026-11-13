import "dotenv/config";
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { db } from "../src/db/connection.js";
import { loadBookDailySeries } from "../src/books/bookDashboard.js";
import { accountCashItemsFromStatement } from "../src/lib/accountCashItems.js";
import { buildPnlAnalysis, loadLedgerCashItems, type AccountCashItemRow, type AnalysisBook, type StoredMoveRow, type StoredRow } from "../src/lib/pnlAnalysis.js";
import { computeAttributionMoveNights, computeAttributionNights, loadAttributionLedger, writeAttributionSnapshots } from "../src/lib/pnlAttributionSnapshots.js";
import { attributionBuckets } from "../src/lib/pnlAttribution.js";

// The P&L Analyser's attribution for every night (pnlAttributionSnapshots.ts), with each night's reconciliation per book
// printed: book P&L = strategies + cash items + incomplete-data cycles + Unexplained. Nights whose Unexplained exceeds
// $50 or 0.01% of the book are marked "CHECK" (the threshold agreed 2026-11-13 before shipping).
// Dry run by default: computes in memory and writes nothing, so it also runs on a database without the new tables.
//
// Usage: npm run backfill-pnl-attribution -- [--apply] [--cash-file=statement.xml]
//   --apply       replaces the stored rows of every night
//   --cash-file   (dry run) takes the account cash items from before the books from that IBKR statement instead of the table

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const stockMark = args.includes("--stock-mark=daily-close") ? "dailyClose" : "nightlySnapshot";
const cashFile = args.find((arg) => arg.startsWith("--cash-file="))?.slice("--cash-file=".length) ?? null;
const unexplainedDollarsThreshold = 50;
const unexplainedFractionThreshold = 0.0001;

async function tableExists(name: string): Promise<boolean> {
  return (await db.raw("SELECT to_regclass(?) IS NOT NULL AS found", [`public.${name}`])).rows[0].found;
}

const accountRows = (await db.raw(`SELECT snapshot_date::text AS night, captured_at AS "capturedAt", net_liquidation_value::float AS nav, net_cash_flow::float AS flow FROM account_pnl_snapshots ORDER BY snapshot_date`)).rows;
const nights: string[] = accountRows.map((row: { night: string }) => row.night);
console.log(`${nights.length} nights, ${nights[0]} to ${nights.at(-1)}.`);

if (apply) {
  const written = await writeAttributionSnapshots(nights);
  console.log(`Stored ${written.rowCount} rows and ${written.moveRowCount} rows at moves between the books over ${written.nights.length} nights.`);
}

const ledger = await loadAttributionLedger();
const [rowsByNight, moveRowsByNight] = await Promise.all([computeAttributionNights(nights, stockMark, ledger), computeAttributionMoveNights(nights, ledger)]);
console.log(`Shares marked at ${stockMark === "dailyClose" ? "the 16:00 daily close" : "the nightly snapshot's price"}.`);
const storedRows: StoredRow[] = [...rowsByNight.values()].flat().map((row) => ({ ...row, snapshotDate: row.snapshotDate }));
const moveRows: StoredMoveRow[] = [...moveRowsByNight.values()].flat();
console.log(`${moveRows.length} rows at moves between the books.`);

let accountItems: AccountCashItemRow[] = [];
if (cashFile) {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false }).parse(readFileSync(cashFile, "utf8"));
  const cutover = await db("books_cutover").first("cut_over_at");
  accountItems = accountCashItemsFromStatement([parsed.FlexQueryResponse?.FlexStatements?.FlexStatement].flat()[0], new Date(cutover.cut_over_at)).items;
} else if (await tableExists("account_cash_items")) {
  accountItems = (await db.raw(`SELECT kind, symbol, amount::float AS amount, effective_at AS "effectiveAt" FROM account_cash_items`)).rows;
}

const analysis = buildPnlAnalysis(
  {
    accountRows,
    plutoSeries: await loadBookDailySeries("pluto"),
    manualSeries: await loadBookDailySeries("manual"),
    bookCaptures: (await db.raw(`SELECT book_key AS book, snapshot_date::text AS night, captured_at AS "capturedAt" FROM book_value_snapshots WHERE book_key IN ('pluto', 'manual') ORDER BY captured_at`)).rows,
    attributionNights: new Set(nights),
    storedRows,
    moveRows,
    ledgerItems: await loadLedgerCashItems(),
    accountItems,
    closedShortOptions: [],
    riskFreeAt: () => null,
  },
  null,
  null,
);

const money = (value: number | null) => (value === null ? "—" : value.toFixed(2)).padStart(11);
const bookValueByNight: Record<AnalysisBook, Map<string, number>> = { all: new Map(), pluto: new Map(), manual: new Map() };
for (const row of accountRows as { night: string; nav: number | null }[]) if (row.nav !== null) bookValueByNight.all.set(row.night, row.nav);
for (const book of ["pluto", "manual"] as const) for (const row of await loadBookDailySeries(book)) bookValueByNight[book].set(row.snapshotDate, row.bookValue);

let checks = 0;
for (const book of ["all", "pluto", "manual"] as const) {
  console.log(`\n${book.toUpperCase()}  night        book P&L  strategies       cash  incomplete  IBKR value  unexplained`);
  const totals = { bookPnl: 0, strategies: 0, cash: 0, flagged: 0, valuation: 0, unexplained: 0 };
  for (const night of analysis.books[book].nights) {
    const strategies = night.buckets === null ? null : attributionBuckets.reduce((sum, bucket) => sum + night.buckets![bucket].total, 0);
    const flagged = night.buckets === null ? null : attributionBuckets.reduce((sum, bucket) => sum + night.buckets![bucket].flaggedChange, 0);
    const cash = night.cash.dividends + night.cash.interest + night.cash.fees + night.cash.otherCash;
    const value = bookValueByNight[book].get(night.night) ?? 0;
    const check = night.unexplained !== null && Math.abs(night.unexplained) > unexplainedDollarsThreshold && Math.abs(night.unexplained) > unexplainedFractionThreshold * value;
    if (check) checks += 1;
    console.log(`      ${night.night} ${money(night.bookPnl)} ${money(strategies)} ${money(cash)} ${money(flagged)} ${money(night.ibkrValuationDifference)} ${money(night.unexplained)}${check ? "  CHECK" : ""}`);
    totals.valuation += night.ibkrValuationDifference ?? 0;
    totals.bookPnl += night.bookPnl ?? 0;
    totals.strategies += strategies ?? 0;
    totals.cash += cash;
    totals.flagged += flagged ?? 0;
    totals.unexplained += night.unexplained ?? 0;
  }
  console.log(`      total      ${money(totals.bookPnl)} ${money(totals.strategies)} ${money(totals.cash)} ${money(totals.flagged)} ${money(totals.valuation)} ${money(totals.unexplained)}`);
}
console.log(`\n${checks} night(s) above the threshold ($${unexplainedDollarsThreshold} and ${unexplainedFractionThreshold * 100}% of the book).${apply ? "" : " Dry run: nothing stored."}`);
await db.destroy();
