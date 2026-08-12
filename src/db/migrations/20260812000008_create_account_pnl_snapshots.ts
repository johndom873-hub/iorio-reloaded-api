import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("account_pnl_snapshots", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.date("snapshot_date").notNullable().unique();
    table.decimal("daily_pnl", 14, 4);
    table.decimal("realized_pnl", 14, 4);
    table.decimal("unrealized_pnl", 14, 4);
    table.decimal("net_liquidation_value", 14, 4);
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("account_pnl_snapshots");
}
