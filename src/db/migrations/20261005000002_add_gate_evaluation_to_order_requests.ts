import type { Knex } from "knex";

// What the order gate saw when the order was confirmed (approved 2026-10-05): the blocks and warnings, the limit
// figures and the limits in force at that moment, so a later question about why an order was allowed can be answered.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.jsonb("gate_evaluation");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("gate_evaluation");
  });
}
