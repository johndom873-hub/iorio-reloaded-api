import type { Knex } from "knex";

// Vol Farmer v2's two break-evens after each 10:00 look (Marcelo 2026-10-27): the session's price chart draws them as
// B-E and B-E2. One row per session, symbol and day whose cycle holds shares, prices as traded that day.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_break_even_levels", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("symbol").notNullable();
    table.date("trading_date").notNullable();
    table.timestamp("at", { useTz: true }).notNullable();
    table.text("look_time").notNullable();
    /** Today's cumulative split factor: a price as traded ÷ it = split-adjusted. */
    table.decimal("split_factor", 18, 10).notNullable();
    /** The first position's break-even per share; null while it holds no shares. */
    table.decimal("first_break_even", 16, 6);
    /** The second position's (the assigned Puts' shares); null while it holds none. */
    table.decimal("second_break_even", 16, 6);
    table.primary(["session_id", "symbol", "trading_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_break_even_levels");
}
