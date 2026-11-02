import type { Knex } from "knex";

// The Data files table's Vol Farmer v4 columns (Marcelo 2026-11-01): the few figures each analysis gives the table, kept
// apart from its full figures so the table reads them without loading every analysis's charts.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_ticker_analyses", (table) => {
    /** { verdict, failedChecks, uncoveredWindows, optionsIncomeTwelveMonths, v4Cagr, holdCagr, v4ExcessCalmar, holdExcessCalmar, smallestPotDollars }; null before v4. */
    table.jsonb("table_figures");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_ticker_analyses", (table) => {
    table.dropColumn("table_figures");
  });
}
