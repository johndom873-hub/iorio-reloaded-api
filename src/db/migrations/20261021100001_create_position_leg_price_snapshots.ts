import type { Knex } from "knex";

// Each open leg's nightly closing price from the daily P&L snapshot job (stocks: the day's last trade; options: IBKR's
// own portfolio mark). Exposure values a leg with no live price at its latest row here before falling back to its entry
// price (approved 2026-10-21): an option that has not traded that day has no live price outside market hours.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("position_leg_price_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_leg_id").notNullable().references("id").inTable("position_legs").onDelete("CASCADE");
    table.date("snapshot_date").notNullable();
    table.decimal("price", 18, 8).notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["position_leg_id", "snapshot_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("position_leg_price_snapshots");
}
