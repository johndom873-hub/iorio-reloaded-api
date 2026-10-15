import type { Knex } from "knex";

// Stock splits, part 3 (Marcelo 2026-10-15). A detected split freezes its ticker (tickers.trading_frozen_at): no orders, no
// Pluto, and the position sync leaves its holdings alone until a person has rewritten its records to the new basis with
// the split:rewrite script and unfrozen it with ticker:unfreeze. While frozen, the worker keeps IBKR's holdings of the
// ticker on the split (stock_splits.ibkr_holdings), so the script, which has no IBKR connection, can match them.
// stock_split_record_rewrites keeps every value the rewrite replaced, for split:undo and the as-traded figures. Freezing
// cancels the ticker's orders with the new cancellation reason ticker_frozen.
const reasonsBefore = ["expired_at_close", "cancelled_by_ibkr", "not_confirmed_in_time", "not_filled_in_time"];
const reasonsAfter = [...reasonsBefore, "ticker_frozen"];
const asList = (reasons: string[]) => reasons.map((reason) => `'${reason}'`).join(", ");

async function setCancellationReasons(knex: Knex, reasons: string[]): Promise<void> {
  await knex.raw("alter table order_requests drop constraint order_requests_cancellation_reason_check");
  await knex.raw(`alter table order_requests add constraint order_requests_cancellation_reason_check check (cancellation_reason is null or cancellation_reason in (${asList(reasons)}))`);
}

export async function up(knex: Knex): Promise<void> {
  await setCancellationReasons(knex, reasonsAfter);
  await knex.schema.alterTable("tickers", (table) => {
    table.timestamp("trading_frozen_at", { useTz: true }).nullable();
    table.text("trading_frozen_reason").nullable();
  });
  await knex.schema.alterTable("stock_splits", (table) => {
    table.jsonb("ibkr_holdings").nullable();
    table.timestamp("ibkr_holdings_at", { useTz: true }).nullable();
  });
  await knex.schema.createTable("stock_split_record_rewrites", (table) => {
    table.uuid("id").primary().defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("stock_split_id").notNullable().references("id").inTable("stock_splits").onDelete("cascade");
    table.text("table_name").notNullable().checkIn(["position_legs", "trades"]);
    table.uuid("row_id").notNullable();
    table.text("column_name").notNullable();
    table.text("old_value").nullable();
    table.text("new_value").nullable();
    table.timestamp("rewritten_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("undone_at", { useTz: true }).nullable();
    table.index(["stock_split_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("stock_split_record_rewrites");
  await knex.schema.alterTable("stock_splits", (table) => {
    table.dropColumn("ibkr_holdings");
    table.dropColumn("ibkr_holdings_at");
  });
  await knex.schema.alterTable("tickers", (table) => {
    table.dropColumn("trading_frozen_at");
    table.dropColumn("trading_frozen_reason");
  });
  await knex.raw("update order_requests set cancellation_reason = 'cancelled_by_ibkr' where cancellation_reason = 'ticker_frozen'");
  await setCancellationReasons(knex, reasonsBefore);
}
