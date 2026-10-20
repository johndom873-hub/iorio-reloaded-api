import type { Knex } from "knex";

// The baseline's put ladder levels (Marcelo 2026-10-20, recorded only: no decision reads them): per session, symbol and
// day, at the day's first look while the cycle holds shares and before that look's orders, the ladder's top A, floor F,
// shock S, reserve committed U and reserve R0, the first rung's cap (U = 0) and the next put's cap, on that day's price
// scale with its split factor. The Analyse window's price chart draws the next put's cap and the floor from them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("backtest_ladder_levels", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("symbol").notNullable();
    table.date("trading_date").notNullable();
    table.timestamp("at", { useTz: true }).notNullable();
    table.text("look_time").notNullable();
    /** Today's cumulative split factor: a price as traded ÷ it = split-adjusted. */
    table.decimal("split_factor", 18, 10).notNullable();
    /** A; null without a break-even. */
    table.decimal("ladder_top", 16, 6);
    /** F; null with no shares held (not recorded then). */
    table.decimal("floor", 16, 6);
    table.decimal("shock", 10, 6).notNullable();
    table.decimal("reserve_committed", 16, 2).notNullable();
    table.decimal("reserve", 16, 2).notNullable();
    /** K_max with nothing committed; null when no put fits. */
    table.decimal("first_rung_cap", 16, 6);
    /** K_max at the look: the highest strike the next ladder put may have; null when none fits. */
    table.decimal("next_put_cap", 16, 6);
    /** Why no ladder put could be sold at the look; null when one could. */
    table.text("blocked_because").checkIn(["ladder_puts_off", "every_lot_has_a_call", "a_put_is_open", "no_cap"]);
    table.primary(["session_id", "symbol", "trading_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_ladder_levels");
}
