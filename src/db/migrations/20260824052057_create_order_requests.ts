import type { Knex } from "knex";

// The web-to-worker order queue. The web dyno only ever writes a row here
// (build → pending_confirmation, then confirm → confirmed) — it never
// writes positions/position_legs/trades directly anymore. Only the
// persistent worker process (src/worker.ts), acting on IBKR's own
// orderStatus/execDetails events, writes those tables — see PROGRESS.md's
// "IBKR is the source of truth" decision, 2026-08-24.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("order_requests", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.uuid("requested_by_user_id").notNullable().references("id").inTable("users");
    // Not constrained to a fixed enum — same rationale as trade_alerts'
    // alert_type — expect this taxonomy to grow (e.g. a future
    // 'close_leg_partial' type once partial closes are supported).
    table.text("request_type").notNullable();
    // Everything the worker needs to build the IBKR Contract/Order: symbol,
    // strategy, combo leg specs (strike/expiry/right/quantity per leg),
    // limit price. Shape depends on request_type.
    table.jsonb("payload").notNullable();
    // Set for close_position/roll_leg — the existing position this order
    // acts on. Null for a brand-new open_covered_call/open_cash_secured_put.
    table.uuid("related_position_id").references("id").inTable("positions");
    // Links back to the Trade Alert this order originated from, if any —
    // mirrors trade_alerts.related_position_id's nullability rationale.
    table.uuid("source_alert_id").references("id").inTable("trade_alerts");
    table
      .enu(
        "status",
        ["pending_confirmation", "confirmed", "submitted", "filled", "partially_filled", "cancelled", "rejected", "error"],
        { useNative: false, enumName: "order_request_status" },
      )
      .notNullable()
      .defaultTo("pending_confirmation");
    // Populated once the worker actually calls placeOrder.
    table.integer("ibkr_order_id");
    table.integer("ibkr_perm_id");
    table.text("error_message");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("updated_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["status"]);
    table.index(["requested_by_user_id", "created_at"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("order_requests");
}
