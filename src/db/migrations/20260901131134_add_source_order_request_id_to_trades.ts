import type { Knex } from "knex";

// Lets the Trade Blotter show who requested a filled trade — previously
// impossible, since `trades` had no link back to the order_requests row
// that placed it. Nullable: a trade recorded from a fill placed outside the
// app (or before this column existed) legitimately has no source order.
// Populated by ibkrGatewayWorker.ts via execution.permId, not ibkr_order_id
// — ibkr_order_id resets and gets reused after every Gateway/worker
// restart (see setupOrderTrackingListeners's own permId comment), so
// matching an old trade against a reused order id could attribute it to
// the wrong request.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trades", (table) => {
    table.uuid("source_order_request_id").references("id").inTable("order_requests");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trades", (table) => {
    table.dropColumn("source_order_request_id");
  });
}
