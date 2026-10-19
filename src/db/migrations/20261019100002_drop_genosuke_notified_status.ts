import type { Knex } from "knex";

// Genosuke no longer places orders (Marcelo 2026-10-17), so nothing follows them to a final status: the column it kept
// that follow-up's last notified status in is unused.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("genosuke_notified_status");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.text("genosuke_notified_status");
  });
}
