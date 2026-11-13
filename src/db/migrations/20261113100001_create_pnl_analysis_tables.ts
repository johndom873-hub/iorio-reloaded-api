import type { Knex } from "knex";

// The P&L Analyser's stored figures (Marcelo 2026-11-13; see src/lib/pnlAttribution.ts):
//   pnl_attribution_snapshots  each night, each ticker's lifetime attribution by strategy bucket as the ledger stood that day
//   pnl_attribution_nights     the nights computed, so a night with no positions is not recomputed forever
//   account_cash_items         IBKR statement cash rows (interest, dividends, fees) from before the books' ledger began,
//                              at account level only: the books did not exist yet, and their ledger must keep matching IBKR's cash
//   risk_free_rate_history     FRED's monthly TB3MS, for the Sharpe, Sortino and Excess Calmar of past months
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pnl_attribution_snapshots", (table) => {
    table.date("snapshot_date").notNullable();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("bucket").notNullable();
    table.text("book_key").notNullable();
    table.decimal("premium_gross", 20, 6).notNullable();
    table.decimal("stock_gross", 20, 6).notNullable();
    table.decimal("commissions", 20, 6).notNullable();
    table.decimal("total", 20, 6).notNullable();
    table.decimal("unrealized", 20, 6).notNullable();
    table.decimal("capital", 20, 6).notNullable();
    table.decimal("flagged_total", 20, 6).notNullable();
    table.jsonb("flag_reasons").notNullable().defaultTo("[]");
    table.primary(["snapshot_date", "ticker_id", "bucket"]);
  });
  await knex.raw("ALTER TABLE pnl_attribution_snapshots ADD CONSTRAINT pnl_attribution_snapshots_bucket_check CHECK (bucket IN ('csp', 'unstructured', 'cc', 'hedge', 'leaps'))");
  await knex.raw("ALTER TABLE pnl_attribution_snapshots ADD CONSTRAINT pnl_attribution_snapshots_book_check CHECK (book_key IN ('pluto', 'manual'))");

  await knex.schema.createTable("pnl_attribution_nights", (table) => {
    table.date("snapshot_date").primary();
    table.integer("ticker_count").notNullable();
    table.timestamp("computed_at", { useTz: true }).notNullable();
  });

  await knex.schema.createTable("account_cash_items", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.text("source_row_key").notNullable().unique();
    table.text("kind").notNullable();
    table.text("symbol");
    table.decimal("amount", 20, 6).notNullable();
    table.timestamp("effective_at", { useTz: true }).notNullable();
    table.text("description").notNullable();
    table.jsonb("statement_row").notNullable();
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable("risk_free_rate_history", (table) => {
    table.text("series_id").notNullable();
    table.date("observation_date").notNullable();
    table.decimal("rate_percent", 8, 4).notNullable();
    table.primary(["series_id", "observation_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("risk_free_rate_history");
  await knex.schema.dropTableIfExists("account_cash_items");
  await knex.schema.dropTableIfExists("pnl_attribution_nights");
  await knex.schema.dropTableIfExists("pnl_attribution_snapshots");
}
