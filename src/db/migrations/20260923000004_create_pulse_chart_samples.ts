import type { Knex } from "knex";

// The two series Pulse's two charts plot, sampled at the same 60s cadence
// the frontend already down-samples its live stream to (not every tick) —
// keyed the way each producer naturally has the data: unrealized P&L per
// position (streamPnlHandler), profit probability per option leg
// (streamGreeksHandler; the frontend maps a position to its one option leg
// today, same join done here at read time). Rolling 8h window, pruned by
// the sampler itself (pulseChartSampleCollector.ts) on every flush.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pulse_unrealized_pnl_samples", (table) => {
    table.uuid("position_id").notNullable().references("id").inTable("positions").onDelete("CASCADE");
    table.timestamp("sampled_at", { useTz: true }).notNullable();
    table.decimal("unrealized_pnl", 14, 4).nullable();
    table.primary(["position_id", "sampled_at"]);
  });
  await knex.schema.raw("CREATE INDEX pulse_unrealized_pnl_samples_sampled_at_index ON pulse_unrealized_pnl_samples (sampled_at)");

  await knex.schema.createTable("pulse_profit_probability_samples", (table) => {
    table.uuid("position_leg_id").notNullable().references("id").inTable("position_legs").onDelete("CASCADE");
    table.timestamp("sampled_at", { useTz: true }).notNullable();
    table.decimal("profit_probability", 8, 6).nullable();
    table.primary(["position_leg_id", "sampled_at"]);
  });
  await knex.schema.raw("CREATE INDEX pulse_profit_probability_samples_sampled_at_index ON pulse_profit_probability_samples (sampled_at)");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("pulse_profit_probability_samples");
  await knex.schema.dropTableIfExists("pulse_unrealized_pnl_samples");
}
