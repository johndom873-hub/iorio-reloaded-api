import type { Knex } from "knex";

// Per-day session close for market_calendar (approved 2026-09-28). MarketData.app only says
// open/closed; the close time comes from IBKR's liquidHours for SPY, read by the Pluto agent
// before each session, so half days (13:00 ET) are known platform-wide. NULL means the regular
// 16:00 ET close. Additive only.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("market_calendar", (table) => {
    table.time("close_time").nullable();
    table.text("close_time_source").nullable();
    table.timestamp("close_time_read_at", { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("market_calendar", (table) => {
    table.dropColumn("close_time");
    table.dropColumn("close_time_source");
    table.dropColumn("close_time_read_at");
  });
}
