import type { Knex } from "knex";

// Each ticker's newest finished cycle of the option quote band today (Marcelo 2026-10-30). The market quote loop stores a
// cycle's quotes in batches as they settle; a look reads the ticker's quotes from its newest finished cycle on, so it never
// sees a cycle half stored, and Pluto's rounds start when a cycle finishes. By start time, not cycle number: the loop's
// count restarts at 1 with the process.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("option_quote_band_cycles", (table) => {
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers").onDelete("CASCADE");
    table.date("trading_date").notNullable();
    /** The market quote loop's own count, which restarts at 1 with the process. */
    table.integer("cycle_number").notNullable();
    /** When the cycle began quoting options: every option quote of the cycle is stamped later. */
    table.timestamp("started_at", { useTz: true }).notNullable();
    table.timestamp("finished_at", { useTz: true }).notNullable();
    table.primary(["ticker_id", "trading_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("option_quote_band_cycles");
}
