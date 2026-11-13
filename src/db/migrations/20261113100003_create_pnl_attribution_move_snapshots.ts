import type { Knex } from "knex";

// A ticker moved between the books during a night (Marcelo 2026-11-13): its attribution by strategy bucket as the ledger
// stood at the move, its open legs at their move marks (book_leg_transfers.mark_price), in the same lifetime figures as
// pnl_attribution_snapshots. The night's change splits at the move: the book it left gets the change from the previous
// night to the move, the book it joined the rest. `snapshot_date` is the night the move falls in.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pnl_attribution_move_snapshots", (table) => {
    table.date("snapshot_date").notNullable();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("bucket").notNullable();
    table.timestamp("moved_at", { useTz: true }).notNullable();
    table.text("from_book").notNullable();
    table.text("to_book").notNullable();
    table.decimal("premium_gross", 20, 6).notNullable();
    table.decimal("stock_gross", 20, 6).notNullable();
    table.decimal("commissions", 20, 6).notNullable();
    table.decimal("total", 20, 6).notNullable();
    table.decimal("unrealized", 20, 6).notNullable();
    table.decimal("capital", 20, 6).notNullable();
    table.decimal("flagged_total", 20, 6).notNullable();
    table.jsonb("flag_reasons").notNullable().defaultTo("[]");
    table.primary(["snapshot_date", "ticker_id", "bucket", "moved_at"]);
  });
  await knex.raw("ALTER TABLE pnl_attribution_move_snapshots ADD CONSTRAINT pnl_attribution_move_snapshots_bucket_check CHECK (bucket IN ('csp', 'unstructured', 'cc', 'leaps'))");
  await knex.raw("ALTER TABLE pnl_attribution_move_snapshots ADD CONSTRAINT pnl_attribution_move_snapshots_books_check CHECK (from_book IN ('pluto', 'manual') AND to_book IN ('pluto', 'manual') AND from_book <> to_book)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("pnl_attribution_move_snapshots");
}
