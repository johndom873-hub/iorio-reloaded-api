import type { Knex } from "knex";

// The P&L Analyser's trade statistics (src/lib/shortOptionTradeStats.ts): every closed short option leg with its result
// under the fair attribution, the night and book it closed in. Rewritten whole by the nightly attribution step.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pnl_closed_short_options", (table) => {
    table.uuid("position_leg_id").primary().references("id").inTable("position_legs");
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("bucket").notNullable();
    table.text("book_key").notNullable();
    table.date("closed_night").notNullable();
    table.decimal("result", 20, 6).notNullable();
    table.decimal("gross_credit", 20, 6).notNullable();
    table.decimal("gross_buyback", 20, 6).notNullable();
    table.boolean("assigned").notNullable();
    table.boolean("held_to_expiry").notNullable();
    table.decimal("days_held", 12, 4).notNullable();
    table.index(["closed_night"]);
  });
  await knex.raw("ALTER TABLE pnl_closed_short_options ADD CONSTRAINT pnl_closed_short_options_bucket_check CHECK (bucket IN ('csp', 'cc'))");
  await knex.raw("ALTER TABLE pnl_closed_short_options ADD CONSTRAINT pnl_closed_short_options_book_check CHECK (book_key IN ('pluto', 'manual'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("pnl_closed_short_options");
}
