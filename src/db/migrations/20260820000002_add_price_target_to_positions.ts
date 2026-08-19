import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.decimal("price_target", 12, 4);
    table.text("close_trigger_notes");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.dropColumn("price_target");
    table.dropColumn("close_trigger_notes");
  });
}
