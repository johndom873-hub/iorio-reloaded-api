import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trade_alerts", (table) => {
    // Flat, alert-type-agnostic list of every strike/expiry this alert
    // references — [{expiry: "YYYY-MM-DD", strike: number}, ...]. One entry
    // for a new_trade candidate, two (closeLeg + replacement) for a roll.
    // Exists so the option chain's must-include-strikes query
    // (fetchPendingAlertStrikesByExpiry, streamTickerDetail.ts) can read one
    // normalized column instead of hand-parsing suggested_structure's
    // per-alert-type JSON shape — the previous approach silently dropped a
    // roll alert's strikes from the chain for weeks after roll alerts
    // started needing chain visibility, since nothing forced a return trip
    // to that query when the roll flow changed (found live 2026-09-15).
    table.jsonb("referenced_strikes").notNullable().defaultTo("[]");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trade_alerts", (table) => {
    table.dropColumn("referenced_strikes");
  });
}
