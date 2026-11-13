import "dotenv/config";
import { readFileSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { db } from "../src/db/connection.js";
import { fetchFlexStatements } from "../src/ibkr/fetchFlexCashTransactions.js";
import { accountCashItemsFromStatement, accountCashItemTotals } from "../src/lib/accountCashItems.js";
import { easternIsoDate } from "../src/lib/easternIsoDate.js";

// One-off per environment (Marcelo 2026-11-13): IBKR's statement cash items (interest, dividends, fees) from the account's
// first nightly snapshot to the books' start, into account_cash_items, for the P&L Analyser's All books figures. Prints
// what it would store; writes only with --apply. A row already stored (same IBKR row key) is left as it is.
//
// Usage: npm run import-account-cash-items -- [--file=statement.xml] [--apply]
//   Without --file it asks IBKR's Flex service for that period (fd/td) with this environment's token.

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const filePath = args.find((arg) => arg.startsWith("--file="))?.slice("--file=".length) ?? null;

const cutover = await db("books_cutover").first("cut_over_at");
if (!cutover) throw new Error("The books have not started on this database: nothing comes before them.");
const booksStartAt = new Date(cutover.cut_over_at);
const firstNight: string | null = (await db.raw("SELECT min(snapshot_date)::text AS night FROM account_pnl_snapshots")).rows[0]?.night ?? null;
if (firstNight === null) throw new Error("No account snapshots yet.");
const toFlexDate = (isoDate: string) => isoDate.replace(/-/g, "");
const period = { fromDate: toFlexDate(firstNight), toDate: toFlexDate(easternIsoDate(new Date(booksStartAt.getTime() - 1))) };

let statement: Record<string, unknown>;
if (filePath) {
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", parseTagValue: false }).parse(readFileSync(filePath, "utf8"));
  statement = [parsed.FlexQueryResponse?.FlexStatements?.FlexStatement].flat()[0];
} else {
  const statements = await fetchFlexStatements(period);
  if (statements.length !== 1) throw new Error(`expected one statement, got ${statements.length}`);
  statement = statements[0]! as Record<string, unknown>;
}
console.log(`Statement ${statement.fromDate}..${statement.toDate} (wanted ${period.fromDate}..${period.toDate}); books started ${booksStartAt.toISOString()}.`);
if (String(statement.fromDate) > period.fromDate) console.log(`WARNING: the statement starts after the first night (${firstNight}): rows before ${statement.fromDate} are missing.`);

const { items, problems } = accountCashItemsFromStatement(statement, booksStartAt);
for (const item of items) console.log(`${item.effectiveAt.toISOString()}  ${item.kind.padEnd(16)} ${(item.symbol ?? "").padEnd(6)} ${item.amount.toFixed(4).padStart(12)}  ${item.description}`);
console.log("Totals:", Object.fromEntries(Object.entries(accountCashItemTotals(items)).map(([component, amount]) => [component, amount.toFixed(4)])));
if (problems.length > 0) console.log("Statement problems:", problems);

if (!apply) {
  console.log(`Dry run: ${items.length} item(s) not stored. Run again with --apply to store them.`);
} else {
  const inserted = await db("account_cash_items")
    .insert(items.map((item) => ({ source_row_key: item.sourceRowKey, kind: item.kind, symbol: item.symbol, amount: item.amount, effective_at: item.effectiveAt, description: item.description, statement_row: JSON.stringify(item.statementRow) })))
    .onConflict("source_row_key")
    .ignore()
    .returning("id");
  console.log(`Stored ${inserted.length} new item(s) of ${items.length}.`);
}
await db.destroy();
