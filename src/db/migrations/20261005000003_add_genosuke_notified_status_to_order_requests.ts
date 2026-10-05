import type { Knex } from "knex";

// The last status Genosuke told its chat about for an order it placed (approved 2026-10-05: Genosuke follows its own
// orders until a final status, instead of a 5-minute poll). Existing rows are backfilled with their current status so
// only changes from now on produce a message.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.text("genosuke_notified_status");
  });
  await knex.raw("update order_requests set genosuke_notified_status = status");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("genosuke_notified_status");
  });
}
