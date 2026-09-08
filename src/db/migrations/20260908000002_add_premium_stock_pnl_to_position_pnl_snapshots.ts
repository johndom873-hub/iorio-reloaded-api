import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_pnl_snapshots", (table) => {
    table.decimal("premium_pnl", 14, 4);
    table.decimal("stock_pnl", 14, 4);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_pnl_snapshots", (table) => {
    table.dropColumn("premium_pnl");
    table.dropColumn("stock_pnl");
  });
}
