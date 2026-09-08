import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("position_leg_greeks_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_leg_id").notNullable().references("id").inTable("position_legs");
    table.date("snapshot_date").notNullable();
    table.decimal("delta", 10, 6);
    table.decimal("gamma", 10, 6);
    table.decimal("vega", 10, 6);
    table.decimal("theta", 10, 6);
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["position_leg_id", "snapshot_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("position_leg_greeks_snapshots");
}
