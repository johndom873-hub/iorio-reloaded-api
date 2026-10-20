import type { Knex } from "knex";

// The Wheel cycles table's detail (Marcelo 2026-10-20, recorded only): each cycle's timeline from the platform's cycle
// derivation (the rows that add up to its figures) and its stretches of shares held with no call on them; and the
// stretches of a symbol with no cycle open. Null, or no gap rows, for sessions run before it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("backtest_cycles", (table) => {
    /** The cycle's timeline rows (BacktestCycleTimelineRow[]), prices as traded. */
    table.jsonb("timeline").nullable();
    /** BacktestUncoveredStretch[]: one or more whole sessions with shares held and no call on them. */
    table.jsonb("uncovered_stretches").nullable();
  });
  await knex.schema.createTable("backtest_cycle_gaps", (table) => {
    table.uuid("session_id").notNullable().references("id").inTable("backtest_sessions").onDelete("CASCADE");
    table.text("symbol").notNullable();
    /** The cycle before the gap; null before the symbol's first cycle. */
    table.integer("after_cycle_number");
    /** The cycle after the gap; null after the last cycle, up to the session's end. */
    table.integer("before_cycle_number");
    table.date("first_idle_day").notNullable();
    table.date("last_idle_day").notNullable();
    table.integer("idle_sessions").notNullable();
    /** C(last idle day) ÷ C(the session before the first idle day) − 1, split-adjusted closes; null when one is missing. */
    table.decimal("stock_move", 14, 10);
    /** BacktestNoSaleDays: the idle days on which each reason stopped an entry. */
    table.jsonb("no_sale_days").notNullable();
    /** { extensionZ, ivRank }: the Entry filters' limits when they blocked an entry in the gap, else null. */
    table.jsonb("entry_filter_limits").notNullable();
    table.primary(["session_id", "symbol", "first_idle_day"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("backtest_cycle_gaps");
  await knex.schema.alterTable("backtest_cycles", (table) => {
    table.dropColumn("timeline");
    table.dropColumn("uncovered_stretches");
  });
}
