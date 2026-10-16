import type { Knex } from "knex";

// Max per ticker and max per sector become shares of Pluto's capital budget instead of the account (Marcelo, 2026-10-16),
// keeping the stored numbers: 10 % of the account becomes 10 % of the budget. The columns and the settings keys are renamed
// so no value is read with the old meaning. The backtest lab and each session's snapshot and overrides take the new keys
// too; sessions keep their engine_version, which tells the results ran under the old meaning. Pass settings versions,
// model payloads and audit rows stay as recorded.
const columnRenames = [
  ["max_ticker_exposure_pct", "max_ticker_pct_of_budget"],
  ["max_sector_exposure_pct", "max_sector_pct_of_budget"],
] as const;
const keyRenames = [
  ["maxTickerExposurePct", "maxTickerPctOfBudget"],
  ["maxSectorExposurePct", "maxSectorPctOfBudget"],
] as const;
const jsonColumns = [
  ["backtest_lab_settings", "settings"],
  ["backtest_sessions", "settings_snapshot"],
  ["backtest_sessions", "overrides"],
] as const;

async function renameKeys(knex: Knex, renames: readonly (readonly [string, string])[]): Promise<void> {
  for (const [table, column] of jsonColumns) {
    for (const [from, to] of renames) {
      await knex.raw(`UPDATE ?? SET ?? = jsonb_set(?? #- ?::text[], ?::text[], ?? -> 'pluto' -> ?) WHERE ?? -> 'pluto' \\? ?`, [table, column, column, `{pluto,${from}}`, `{pluto,${to}}`, column, from, column, from]);
    }
  }
}

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [from, to] of columnRenames) table.renameColumn(from, to);
  });
  await renameKeys(knex, keyRenames);
}

export async function down(knex: Knex): Promise<void> {
  await renameKeys(
    knex,
    keyRenames.map(([from, to]) => [to, from] as const),
  );
  await knex.schema.alterTable("pluto_settings", (table) => {
    for (const [from, to] of columnRenames) table.renameColumn(to, from);
  });
}
