// Records a deposit (or withdrawal) before IBKR's nightly statement holds it (Marcelo 2026-11-09), so it can be split on
// the Dashboard at once and the books' cash matches IBKR's. See src/books/recordedDeposits.ts for the rules: the
// statement's transfer later takes this entry's place, matched to the cent.
//
// Usage (DATABASE_URL points at the environment's database; --env names it, as a check). The amount is the transfer's
// exact USD amount from IBKR's transfer history:
//   npm run books:record-deposit -- --env production --amount 1050003.70 --description "transfer from U9813636"                        preview
//   npm run books:record-deposit -- --env production --amount 1050003.70 --description "transfer from U9813636" --apply --user marce    records it
// On a Heroku dyno: node dist/scripts/books-record-deposit.js with the same arguments.
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { loadLedgerCashByBook } from "../src/books/bookLedger.js";
import { loadUnmatchedRecordedDeposits, recordDepositBeforeStatement } from "../src/books/recordedDeposits.js";
import { formatSignedDollars } from "../src/lib/formatSignedDollars.js";

const environments = ["development", "staging", "production"] as const;

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);
const dollars = (amount: number) => formatSignedDollars(amount, 2);

function checkEnvironment(): string {
  const environment = readFlag("env");
  if (!environment || !(environments as readonly string[]).includes(environment)) throw new Error(`--env must be one of ${environments.join(", ")}.`);
  const host = new URL(process.env.DATABASE_URL ?? "postgres://missing").hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "";
  if ((environment === "development") !== local) throw new Error(`--env ${environment} but DATABASE_URL points at ${local ? "a local" : "a remote"} database (${host}).`);
  return environment;
}

async function printLedger(title: string): Promise<void> {
  const cash = await loadLedgerCashByBook(null);
  const waiting = await loadUnmatchedRecordedDeposits(db);
  console.log(`${title}: Pluto ${dollars(cash.pluto)}, Manual ${dollars(cash.manual)}, Unallocated ${dollars(cash.unallocated)} (ledger cash, before today's fills)`);
  for (const deposit of waiting) console.log(`  recorded, waiting for the statement: ${dollars(deposit.amount)} at ${deposit.effectiveAt.toISOString()} (${deposit.id})`);
}

async function main(): Promise<void> {
  const environment = checkEnvironment();
  const amountText = readFlag("amount");
  const amountDollars = Number(amountText);
  if (amountText === null || !Number.isFinite(amountDollars) || amountDollars === 0) throw new Error("--amount must be the transfer's USD amount, e.g. 1050003.70 (negative for a withdrawal).");
  const description = readFlag("description");
  if (!description) throw new Error('--description is required, e.g. "transfer from U9813636".');
  if (!(await db("books_cutover").first("id"))) throw new Error("The books have not been started on this database.");
  await printLedger(`Books on ${environment} now`);
  console.log(`\nTo record: ${dollars(amountDollars)} into Unallocated, "${description}", effective now; then split it on the Dashboard.`);
  if (!hasFlag("apply")) {
    console.log("\nPreview only. Add --apply --user <username> to record it.");
    return;
  }
  const username = readFlag("user");
  if (!username) throw new Error("--user is required with --apply (the admin recording it).");
  const user = await db("users").where({ username }).first("id", "access_level");
  if (!user) throw new Error(`No user named ${username}.`);
  if (user.access_level !== "admin") throw new Error(`${username} is not an admin.`);
  const { entryId } = await recordDepositBeforeStatement(db, { amountDollars, description, at: new Date(), createdByUserId: user.id });
  console.log(`\nRecorded (${entryId}).`);
  await printLedger("Books after");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.destroy();
  });
