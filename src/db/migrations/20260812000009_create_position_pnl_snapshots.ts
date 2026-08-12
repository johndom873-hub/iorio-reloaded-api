import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("position_pnl_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("position_id").notNullable().references("id").inTable("positions");
    table.date("snapshot_date").notNullable();
    table.decimal("realized_pnl", 14, 4);
    table.decimal("unrealized_pnl", 14, 4);
    table.decimal("market_value", 14, 4);
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(["position_id", "snapshot_date"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("position_pnl_snapshots");
}
