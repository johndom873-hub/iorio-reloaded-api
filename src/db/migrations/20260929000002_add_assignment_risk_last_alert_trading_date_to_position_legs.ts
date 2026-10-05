import type { Knex } from "knex";

// Assignment-risk alerts (Day Signals loop): assignment_risk_notified_at says
// whether the leg is currently flagged (set on alert, cleared when |delta|
// falls back below the re-arm threshold); this column keeps the Eastern
// trading date of the last alert, so a leg that re-arms and crosses again the
// same day stays quiet until the next trading day.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.date("assignment_risk_last_alert_trading_date").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropColumn("assignment_risk_last_alert_trading_date");
  });
}
