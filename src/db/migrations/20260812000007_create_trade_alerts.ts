import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("trade_alerts", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("strategy_key").notNullable();
    table.uuid("ticker_id").notNullable().references("id").inTable("tickers");
    // Not constrained to a fixed enum yet — the taxonomy may grow as
    // strategy logic is built out (e.g. a future 'close_early' type).
    // 'new_trade': open a fresh position. 'roll': close the existing short
    // option leg on related_position_id and open a new one (same position).
    table.text("alert_type").notNullable().defaultTo("new_trade");
    // The existing position this alert adjusts (rolls). Null for a
    // 'new_trade' alert, since there's no existing position yet.
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
    // The position that resulted from executing this alert. For 'new_trade'
    // this is a newly-created position; for 'roll' it's typically the same
    // position as related_position_id (new legs added, not a new position).
    table.uuid("resulting_position_id").references("id").inTable("positions");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(["strategy_key", "status"]);
    table.index(["created_at"]);
    table.index(["alert_type"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("trade_alerts");
}
