import type { Knex } from "knex";

// Why an order ended cancelled when nobody pressed Cancel (Marcelo 2026-10-05). A user cancel keeps cancelled_by_user_id
// and no reason. expired_at_close: IBKR ended a DAY order at or after the 16:00 ET close. cancelled_by_ibkr: IBKR ended it
// earlier (an early-close day, or IBKR's own reason). not_confirmed_in_time: the 15-minute sweep for orders never confirmed.
//
// Backfill: IBKR announces a DAY order's expiry twice (orderStatus "Cancelled" and error 202 "Order Canceled"); whichever
// reached the worker first used to win, so some expiries were stored as status "error". Those, and the plain cancelled
// expiries, are relabelled from their final timestamp. down() drops the column only: the relabelled statuses stay cancelled.
export const cancellationReasons = ["expired_at_close", "cancelled_by_ibkr", "not_confirmed_in_time"] as const;

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.text("cancellation_reason").nullable();
  });
  await knex.raw(
    `alter table order_requests add constraint order_requests_cancellation_reason_check check (cancellation_reason is null or cancellation_reason in (${cancellationReasons.map((reason) => `'${reason}'`).join(", ")}))`,
  );

  const atOrAfterClose = "(updated_at at time zone 'America/New_York')::time >= time '16:00'";
  await knex.raw(`
    update order_requests orq
       set status = 'cancelled', cancellation_reason = 'expired_at_close', error_message = null
     where orq.status = 'error'
       and orq.error_message like 'IBKR error 202:%'
       and ${atOrAfterClose.replaceAll("updated_at", "orq.updated_at")}
       and not exists (
         select 1 from trades t
          where t.ibkr_order_id = orq.ibkr_order_id::text and t.executed_at between orq.created_at and orq.updated_at)
  `);
  await knex.raw(`
    update order_requests
       set cancellation_reason = 'expired_at_close',
           error_message = case when error_message like 'IBKR error 202:%' then null else error_message end
     where status in ('cancelled', 'cancelled_partially_filled')
       and cancelled_by_user_id is null
       and ibkr_order_id is not null
       and ${atOrAfterClose}
  `);
  await knex.raw(`
    update order_requests set cancellation_reason = 'not_confirmed_in_time'
     where status = 'cancelled' and error_message like 'Not confirmed within 15 minutes%'
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table order_requests drop constraint if exists order_requests_cancellation_reason_check");
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("cancellation_reason");
  });
}
