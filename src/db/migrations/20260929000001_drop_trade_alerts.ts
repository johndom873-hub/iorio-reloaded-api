import type { Knex } from "knex";

// Trade Alerts is retired (Signals, Day Signals and Roll Signals replace it).
// down() recreates the schema only — the dropped rows do not come back.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("order_requests", (table) => {
    table.dropForeign(["source_alert_id"]);
    table.dropColumn("source_alert_id");
  });
  await knex.schema.dropTable("trade_alerts");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.createTable("trade_alerts", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("strategy_key").notNullable();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    table.text("alert_type").notNullable().defaultTo("new_trade");
    table.uuid("related_position_id").references("id").inTable("positions");
    table.jsonb("suggested_structure").notNullable();
    table.text("rationale");
    table
      .enu("status", ["pending", "approved", "rejected", "modified", "expired"], {
        useNative: false,
        enumName: "trade_alert_status",
      })
      .notNullable()
      .defaultTo("pending");
    table.uuid("reviewed_by_user_id").references("id").inTable("users");
    table.timestamp("reviewed_at", { useTz: true });
    table.uuid("resulting_position_id").references("id").inTable("positions");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp("last_refreshed_at", { useTz: true });
    table.jsonb("referenced_strikes").notNullable().defaultTo("[]");

    table.index(["strategy_key", "status"]);
    table.index(["created_at"]);
    table.index(["alert_type"]);
  });
  await knex.schema.alterTable("order_requests", (table) => {
    table.uuid("source_alert_id").references("id").inTable("trade_alerts");
  });
}
