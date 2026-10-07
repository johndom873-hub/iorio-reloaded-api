import type { Knex } from "knex";

// What the trading-events Telegram catch-all (approved 2026-10-07) has already told the chat: the last order status
// reported, and when a position's opening and closing were reported. Existing rows are backfilled as already told, so
// only events from now on produce a message.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.text("telegram_notified_status");
  });
  await knex.raw("update order_requests set telegram_notified_status = status");

  await knex.schema.alterTable("positions", (table) => {
    table.timestamp("telegram_opened_notified_at", { useTz: true });
    table.timestamp("telegram_closed_notified_at", { useTz: true });
  });
  await knex.raw("update positions set telegram_opened_notified_at = now()");
  await knex.raw("update positions set telegram_closed_notified_at = now() where closed_at is not null");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.dropColumn("telegram_opened_notified_at");
    table.dropColumn("telegram_closed_notified_at");
  });
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("telegram_notified_status");
  });
}
