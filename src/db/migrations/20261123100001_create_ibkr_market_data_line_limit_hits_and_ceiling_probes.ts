import type { Knex } from "knex";

// How IBKR works out the login's market-data line allocation (Marcelo 2026-11-23): the formula is
// max(100, monthly commissions ÷ $8, equity × 100 ÷ $1M), but not which equity (live, last night's, an average) or which
// month's commissions, nor how often it is recalculated. Two records answer that over time:
//   - ibkr_market_data_line_limit_hits: each time IBKR refused a line as over the limit (error 101), with what we held
//     and the live net liquidation at that moment (one row per process every 5 minutes, later refusals counted on the next);
//   - ibkr_market_data_line_ceiling_probes: the nightly probe, which subscribes until IBKR refuses, so the allocation
//     that night is what the probe held plus what the app held.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("ibkr_market_data_line_limit_hits", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.timestamp("occurred_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text("process").notNullable();
    table.text("trading_mode").notNullable();
    table.integer("request_id");
    table.integer("ibkr_code").notNullable();
    table.text("ibkr_message").notNullable();
    table.integer("budget").notNullable();
    table.integer("estimated_ibkr_ceiling").notNullable();
    table.integer("ledger_lines_in_use").notNullable();
    table.jsonb("ledger_reservations").notNullable();
    table.decimal("live_net_liquidation", 20, 4);
    table.integer("refusals_not_recorded_before").notNullable().defaultTo(0);
  });
  await knex.schema.createTable("ibkr_market_data_line_ceiling_probes", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.timestamp("probed_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text("trading_mode").notNullable();
    table.integer("lines_held_by_probe").notNullable();
    table.boolean("hit_the_limit").notNullable();
    table.integer("ledger_lines_before").notNullable();
    table.integer("ledger_lines_after").notNullable();
    table.jsonb("ledger_reservations_before").notNullable();
    table.jsonb("ledger_reservations_after").notNullable();
    table.integer("measured_ceiling");
    table.decimal("live_net_liquidation", 20, 4);
    table.integer("budget").notNullable();
    table.integer("estimated_ibkr_ceiling").notNullable();
    table.jsonb("other_failures").notNullable().defaultTo("[]");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("ibkr_market_data_line_ceiling_probes");
  await knex.schema.dropTableIfExists("ibkr_market_data_line_limit_hits");
}
