// Stock splits, part 3 (Marcelo 2026-10-15): the scripts a person runs, usually through a Claude session started from the
// frozen-ticker Telegram alert. Nothing here unfreezes a ticker except `unfreeze`.
//
// Usage (DATABASE_URL points at the environment's database; --env names it, as a check):
//   npm run split:rewrite -- --env staging --split <stock_splits.id>            preview: every change, IBKR's holdings, problems
//   npm run split:rewrite -- --env staging --split <id> --apply                 applies it in one transaction
//   npm run split:rewrite -- --env staging --split <id> --apply --accept-problems   applies despite listed problems (a person decided)
//   npm run split:undo -- --env staging --split <id>                            puts back every value the rewrite replaced
//   npm run ticker:unfreeze -- --env staging --ticker SMCI [--force]            unfreezes (refused while a split is pending, unless --force)
import "dotenv/config";
import { db } from "../src/db/connection.js";
import { applySplitRecordRewrite, loadSplitRecordRewritePlan, undoSplitRecordRewrite, type SplitRewritePlan } from "../src/lib/stockSplitRewrite.js";
import { unfreezeTicker } from "../src/lib/tickerFreeze.js";
import { clearDownState } from "../src/lib/throttledAlert.js";
import { frozenTickerAlertKey } from "../src/lib/frozenTickerAlert.js";

const environments = ["development", "staging", "production"] as const;

function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1]! : null;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** --env must agree with where DATABASE_URL points: a local database for development, a remote one otherwise. */
function checkEnvironment(): string {
  const environment = readFlag("env");
  if (!environment || !(environments as readonly string[]).includes(environment)) throw new Error(`--env must be one of ${environments.join(", ")}.`);
  const host = new URL(process.env.DATABASE_URL ?? "postgres://missing").hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "";
  if ((environment === "development") !== local) throw new Error(`--env ${environment} but DATABASE_URL points at ${local ? "a local" : "a remote"} database (${host}).`);
  return environment;
}

function printPlan(plan: SplitRewritePlan): void {
  console.log(`${plan.symbol}: ${plan.description} effective ${plan.effectiveDateIso} (split ${plan.splitId}, ratio ${plan.ratio})\n`);
  console.log(`Changes (${plan.changes.length}):`);
  for (const change of plan.changes) console.log(`  ${change.tableName} ${change.rowId} ${change.columnName}: ${change.oldValue} → ${change.newValue}`);
  console.log(`\nOpen holdings after the rewrite against IBKR's:`);
  for (const line of plan.holdingsComparison) console.log(`  ${line}`);
  console.log(`\nProblems (stop --apply): ${plan.problems.length === 0 ? "none" : ""}`);
  for (const problem of plan.problems) console.log(`  ❌ ${problem}`);
  if (plan.notes.length > 0) console.log(`\nNotes:`);
  for (const note of plan.notes) console.log(`  • ${note}`);
}

async function rewrite(): Promise<void> {
  const splitId = readFlag("split");
  if (!splitId) throw new Error("--split <stock_splits.id> is required.");
  const plan = await loadSplitRecordRewritePlan(splitId);
  printPlan(plan);
  if (!hasFlag("apply")) {
    console.log("\nPreview only: nothing changed. Add --apply to apply it.");
    return;
  }
  await applySplitRecordRewrite(plan, { acceptProblems: hasFlag("accept-problems") });
  console.log(`\nApplied: ${plan.changes.length} value(s) rewritten, the split is marked rewritten. ${plan.symbol} is STILL FROZEN: unfreeze it with npm run ticker:unfreeze once the records look right.`);
}

async function undo(): Promise<void> {
  const splitId = readFlag("split");
  if (!splitId) throw new Error("--split <stock_splits.id> is required.");
  const restored = await undoSplitRecordRewrite(splitId);
  console.log(`Restored ${restored} value(s); split ${splitId} is pending again.`);
}

async function unfreeze(): Promise<void> {
  const symbol = readFlag("ticker")?.toUpperCase();
  if (!symbol) throw new Error("--ticker <symbol> is required.");
  const ticker = await db("tickers").where({ symbol }).first("id", "trading_frozen_at", "trading_frozen_reason");
  if (!ticker) throw new Error(`No ticker ${symbol}.`);
  if (!ticker.trading_frozen_at) {
    console.log(`${symbol} is not frozen.`);
    return;
  }
  const pending = await db("stock_splits").where({ ticker_id: ticker.id }).whereNull("records_rewritten_at").select("id", db.raw("effective_date::text as effective_date"));
  if (pending.length > 0 && !hasFlag("force")) {
    throw new Error(`${symbol} has ${pending.length} split(s) not yet rewritten (${pending.map((split) => `${split.id} effective ${split.effective_date}`).join(", ")}). Run split:rewrite first, or add --force.`);
  }
  await unfreezeTicker(ticker.id);
  await clearDownState(frozenTickerAlertKey(ticker.id));
  console.log(`${symbol} unfrozen (was: ${ticker.trading_frozen_reason}). The position sync, the order route and Pluto take it up again.`);
}

const commands: Record<string, () => Promise<void>> = { rewrite, undo, unfreeze };

async function main(): Promise<void> {
  const command = commands[process.argv[2] ?? ""];
  if (!command) throw new Error(`Command must be one of ${Object.keys(commands).join(", ")}.`);
  const environment = checkEnvironment();
  console.log(`Environment: ${environment}\n`);
  await command();
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
