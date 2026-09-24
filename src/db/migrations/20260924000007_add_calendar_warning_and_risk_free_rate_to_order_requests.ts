import type { Knex } from "knex";

// Previously computed once at order-creation time and returned only on the
// POST /orders and POST /positions/:id/roll response bodies, never
// persisted -- so a later GET /orders/:id (including the one the
// background-jobs SSE listener triggers right after order creation) came
// back without them, causing the Order Review calendar-warning banner to
// flash and disappear (found 2026-09-24).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.text("calendar_warning").nullable();
    table.float("risk_free_rate").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("calendar_warning");
    table.dropColumn("risk_free_rate");
  });
}
