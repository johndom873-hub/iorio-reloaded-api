import type { Knex } from "knex";

// Orders sent to IBKR that nobody filled are cancelled by the worker after a limit (Marcelo 2026-10-05, default 15 minutes,
// editable on Risk & Limits, 0 = never): signals move within minutes, and a mid limit left resting fills when the price has
// moved against it. placed_at is when the order went to IBKR (created_at also counts the time spent unconfirmed).
// Additive with defaults, so the old web dynos serving during a release keep working.
const reasonsBefore = ["expired_at_close", "cancelled_by_ibkr", "not_confirmed_in_time"];
const reasonsAfter = [...reasonsBefore, "not_filled_in_time"];
const asList = (reasons: string[]) => reasons.map((reason) => `'${reason}'`).join(", ");

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.timestamp("placed_at", { useTz: true }).nullable();
  });
  await knex.schema.alterTable("trading_settings", (table) => {
    table.integer("order_unfilled_cancel_minutes").notNullable().defaultTo(15);
  });
  await knex.raw("alter table trading_settings add constraint trading_settings_unfilled_cancel_in_range check (order_unfilled_cancel_minutes between 0 and 1440)");
  await knex.raw("alter table order_requests drop constraint order_requests_cancellation_reason_check");
  await knex.raw(`alter table order_requests add constraint order_requests_cancellation_reason_check check (cancellation_reason is null or cancellation_reason in (${asList(reasonsAfter)}))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("update order_requests set cancellation_reason = 'cancelled_by_ibkr' where cancellation_reason = 'not_filled_in_time'");
  await knex.raw("alter table order_requests drop constraint order_requests_cancellation_reason_check");
  await knex.raw(`alter table order_requests add constraint order_requests_cancellation_reason_check check (cancellation_reason is null or cancellation_reason in (${asList(reasonsBefore)}))`);
  await knex.raw("alter table trading_settings drop constraint if exists trading_settings_unfilled_cancel_in_range");
  await knex.schema.alterTable("trading_settings", (table) => {
    table.dropColumn("order_unfilled_cancel_minutes");
  });
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("placed_at");
  });
}
