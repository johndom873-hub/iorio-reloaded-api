import type { Knex } from "knex";

// The baseline's orders that left contracts unsold (Marcelo 2026-10-15, recorded only: no decision reads them): what the
// order wanted in contracts of its best candidate, what it filled, the rest, and why the rest went unsold. One row per
// look, symbol and order cut by volume or cash; looks that found nothing within the rules are one row per day, symbol
// and order, with their count (look_count), from the day's first such look. The Analyse window's pot sizing and a pots
// session's cash-bound report read them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_look_shortfalls", (table) => {
    table.bigIncrements("id").primary();
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.date("trading_date").notNullable();
    table.timestamp("at", { useTz: true }).notNullable();
    table.text("look_time").notNullable();
    table.text("symbol").notNullable();
    table.text("step").notNullable().checkIn(["held_calls", "entry", "ladder_put", "budget_put"]);
    table.text("option_right").notNullable().checkIn(["C", "P"]);
    /** In contracts of the order's best candidate; null when there was none to measure it by. */
    table.integer("wanted_contracts");
    table.integer("filled_contracts").notNullable();
    table.integer("unsold_contracts");
    table.text("reason").notNullable().checkIn(["cash", "volume", "no_candidate"]);
    /** 1, or the day's looks a no_candidate row stands for. */
    table.integer("look_count").notNullable().defaultTo(1);
    /** { expiry, strike, dte, premiumYield, volumeCap }; null when none. */
    table.jsonb("best_candidate");
    table.index(["session_id", "trading_date"]);
    table.index(["session_id", "symbol"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_look_shortfalls");
}
