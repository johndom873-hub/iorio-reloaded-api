import type { Knex } from "knex";

// The economic-calendar warning as data ({title, eventDate}[]) so Order Review can list one event per
// line; calendar_warning keeps the one-line text (and is all that older orders have).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.jsonb("calendar_warning_events").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("calendar_warning_events");
  });
}
