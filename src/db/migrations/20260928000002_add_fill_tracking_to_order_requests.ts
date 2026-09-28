import type { Knex } from "knex";

// Honest order states (gap fix 7 for Pluto, 2026-09-28). Until now a partially
// filled DAY order whose remainder expired at the close ended as plain
// "cancelled" with no record that part of it filled, and IBKR's own status
// was never kept. Three additive columns, written by the worker's orderStatus
// listener on every change:
//   filled_quantity / remaining_quantity — IBKR's running fill counts for the
//     order (combo orders count in combo units, the same units the order was
//     placed in);
//   ibkr_status — IBKR's last raw status ("Submitted", "Filled", "Cancelled",
//     "Inactive", ...). A "partially_filled" row whose ibkr_status is Cancelled /
//     ApiCancelled / Inactive is final: nothing more will fill.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.integer("filled_quantity");
    table.integer("remaining_quantity");
    table.text("ibkr_status");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropColumn("filled_quantity");
    table.dropColumn("remaining_quantity");
    table.dropColumn("ibkr_status");
  });
}
