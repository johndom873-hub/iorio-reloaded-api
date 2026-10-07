import type { Knex } from "knex";

// The major US macro events the Signals macro flag, Pluto, the Calendar page and the order-review warning read:
// the Fed rate decision (Federal Reserve FOMC calendar page), CPI and GDP (FRED release dates) and US federal
// elections (generated from the legal date rule). Replaces TradingView's economic_calendar_events, which only
// served ~30 days ahead and stored every minor release. Rows are refreshed per event_key by the daily calendar
// capture (macroEventCalendar.ts replaceMajorMacroEvents), so the table only holds what is used.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("major_macro_events", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("event_key").notNullable(); // fed_rate_decision | cpi | gdp | us_federal_election
    table.text("title").notNullable();
    table.timestamp("event_at", { useTz: true }).notNullable(); // the release instant: the date at the convention time in ET
    table.text("source").notNullable(); // federal_reserve | fred | election_rule
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(["event_key", "event_at"]);
    table.index("event_at");
  });
  await knex.schema.dropTable("economic_calendar_events");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.createTable("economic_calendar_events", (table) => {
    table.uuid("id", { primaryKey: true }).defaultTo(knex.raw("gen_random_uuid()"));
    table.text("external_id").notNullable().unique();
    table.text("title").notNullable();
    table.text("country").notNullable();
    table.text("category");
    table.smallint("importance");
    table.decimal("actual", 18, 6);
    table.decimal("forecast", 18, 6);
    table.decimal("previous", 18, 6);
    table.timestamp("event_at", { useTz: true }).notNullable();
    table.jsonb("raw").notNullable();
    table.timestamp("captured_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index("event_at");
  });
  await knex.schema.dropTable("major_macro_events");
}
