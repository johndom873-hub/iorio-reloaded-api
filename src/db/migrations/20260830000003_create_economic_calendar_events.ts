import type { Knex } from "knex";

// Macro economic calendar (CPI, FOMC, etc.), sourced from TradingView's
// public "economic-calendar.tradingview.com/events" endpoint -- confirmed
// live via a direct curl 2026-08-30 (returns real upcoming US events with
// this exact shape), not previously used anywhere in this codebase or
// menaris-admin-api. Not ticker-scoped -- a standalone macro feed.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("economic_calendar_events", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    // TradingView's own event id (e.g. "399143") -- a stable, natural
    // dedup key, unlike composite title+date (titles repeat monthly for
    // recurring indicators like CPI, but TradingView's id does not).
    table.text("external_id").notNullable().unique();
    table.text("title").notNullable();
    table.text("country").notNullable();
    table.text("category");
    table.smallint("importance"); // TradingView's 0-2 scale, low to high
    table.decimal("actual", 18, 6);
    table.decimal("forecast", 18, 6);
    table.decimal("previous", 18, 6);
    table.timestamp("event_at", { useTz: true }).notNullable();
    table.jsonb("raw").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index("event_at");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("economic_calendar_events");
}
