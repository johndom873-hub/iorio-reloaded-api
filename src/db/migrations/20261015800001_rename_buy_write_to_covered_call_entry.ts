import type { Knex } from "knex";

// The baseline's entry value "buy_write" becomes "covered_call" (Marcelo 2026-10-15: no "buy-write" anywhere), in every
// stored settings document, so Run again and the lab keep validating; the texts already written by earlier sessions (session
// names, day summaries, action reasons) say "Covered Call entry" instead. Down restores the entry value only.
const settingsColumns: [string, string][] = [
  ["backtest_sessions", "overrides"],
  ["backtest_sessions", "settings_snapshot"],
  ["backtest_lab_settings", "settings"],
  ["backtest_ticker_analyses", "lab_values"],
];
const auditColumns: [string, string][] = [
  ["backtest_lab_settings_audit", "old_value"],
  ["backtest_lab_settings_audit", "new_value"],
];
const textColumns: [string, string][] = [
  ["backtest_sessions", "name"],
  ["backtest_session_days", "decision_summary"],
  ["backtest_actions", "chosen_because"],
];

async function renameEntryValue(knex: Knex, from: string, to: string): Promise<void> {
  for (const [table, column] of settingsColumns) {
    await knex.raw(`update ?? set ?? = replace(??::text, ?, ?)::jsonb where ??::text like ?`, [table, column, column, `"entry": "${from}"`, `"entry": "${to}"`, column, `%"entry": "${from}"%`]);
  }
  for (const [table, column] of auditColumns) {
    await knex.raw(`update ?? set ?? = ? where ?? = ?`, [table, column, to, column, from]);
  }
}

export async function up(knex: Knex): Promise<void> {
  await renameEntryValue(knex, "buy_write", "covered_call");
  for (const [table, column] of textColumns) {
    await knex.raw(
      `update ?? set ?? = replace(replace(replace(replace(??, 'buy-write entry', 'Covered Call entry'), 'buy-writes', 'Covered Call entries'), 'Buy-write', 'Covered Call entry'), 'buy-write', 'Covered Call entry') where ?? ilike '%buy-write%'`,
      [table, column, column, column],
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  await renameEntryValue(knex, "covered_call", "buy_write");
}
