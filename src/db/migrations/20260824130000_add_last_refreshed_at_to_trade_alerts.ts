import type { Knex } from "knex";

// Lets a single pending alert be re-quoted against live IBKR data without
// re-running the full nightly scan — see refreshTradeAlert.ts. created_at
// already exists; this adds the other half of the "when was this actually
// last validated" picture Juan needs each morning before acting on an
// alert generated the night before (10pm UTC, reviewed EU-morning).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trade_alerts", (table) => {
    table.timestamp("last_refreshed_at", { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("trade_alerts", (table) => {
    table.dropColumn("last_refreshed_at");
  });
}
