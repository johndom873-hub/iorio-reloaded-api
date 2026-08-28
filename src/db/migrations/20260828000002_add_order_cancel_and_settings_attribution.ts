import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.uuid("cancelled_by_user_id").references("id").inTable("users");
  });
  await knex.schema.alterTable("strategy_settings", (table) => {
    table.uuid("updated_by_user_id").references("id").inTable("users");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("cancelled_by_user_id");
  });
  await knex.schema.alterTable("strategy_settings", (table) => {
    table.dropColumn("updated_by_user_id");
  });
}
