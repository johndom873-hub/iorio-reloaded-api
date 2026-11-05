// Starts the Pluto and Manual books (Marcelo 2026-11-05), once per environment. See src/books/cutover.ts for the rules.
//
// Usage (DATABASE_URL points at the environment's database; --env names it, as a check):
//   npm run books:cutover -- --env production --pluto-value 600000                         preview, nothing written
//   npm run books:cutover -- --env production --pluto-value 600000 --apply --user marce    starts the books
//   add --without-statement on staging: its paper account has no usable IBKR statement, so the books start from the live figures
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { sharedReadConnection } from "../src/ibkr/sharedReadConnection.js";
import { applyBooksCutover, planBooksCutover } from "../src/books/cutover.js";
import { formatWholeDollars } from "../src/lib/formatWholeDollars.js";

const environments = ["development", "staging", "production"] as const;

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function checkEnvironment(): string {
  const environment = readFlag("env");
  if (!environment || !(environments as readonly string[]).includes(environment)) throw new Error(`--env must be one of ${environments.join(", ")}.`);
  const host = new URL(process.env.DATABASE_URL ?? "postgres://missing").hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "";
  if ((environment === "development") !== local) throw new Error(`--env ${environment} but DATABASE_URL points at ${local ? "a local" : "a remote"} database (${host}).`);
  return environment;
}

async function main(): Promise<void> {
  const environment = checkEnvironment();
  const plutoValueText = readFlag("pluto-value");
  const plutoStartingValue = Number(plutoValueText);
  if (plutoValueText === null || !Number.isFinite(plutoStartingValue)) throw new Error("--pluto-value must be Pluto's starting value in dollars, e.g. 600000.");
  const plan = await planBooksCutover(plutoStartingValue, { withoutStatement: hasFlag("without-statement") });
  console.log(`Books cut-over on ${environment} (${plan.mode === "statement" ? `IBKR's statement through ${plan.statementToDate}` : "IBKR's live figures"}), starting ${plan.cutOverAt.toISOString()}`);
  console.log(`  IBKR cash:            ${formatWholeDollars(plan.ibkrCash)}`);
  console.log(`  Pluto:  value ${formatWholeDollars(plan.plutoStartingValue)} = cash ${formatWholeDollars(plan.plutoOpeningCash)} + positions ${formatWholeDollars(plan.plutoPositionsValue)}`);
  console.log(`  Manual: value ${formatWholeDollars(plan.manualOpeningCash + plan.manualPositionsValue)} = cash ${formatWholeDollars(plan.manualOpeningCash)} + positions ${formatWholeDollars(plan.manualPositionsValue)}`);
  console.log(`  Pluto's tickers: ${plan.plutoSymbols.join(", ") || "none"}`);
  if (plan.legsWithoutClosingPrice.length > 0) console.log(`  Valued at entry price (no closing price that day): ${plan.legsWithoutClosingPrice.join(", ")}`);
  if (plan.plutoOpeningCash < 0 || plan.manualOpeningCash < 0) console.log("  WARNING: a book would start with negative cash; check Pluto's starting value.");
  if (!hasFlag("apply")) {
    console.log("\nPreview only. Add --apply to start the books.");
    return;
  }
  const username = readFlag("user");
  const user = username === null ? null : await db("users").where({ username }).first("id");
  if (username !== null && !user) throw new Error(`No user named ${username}.`);
  await applyBooksCutover(plan, user?.id ?? null);
  console.log("\nThe books are started.");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sharedReadConnection.shutdown();
    await db.destroy();
  });
