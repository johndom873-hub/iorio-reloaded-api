import type { Knex } from "knex";

// Tracks whether a short leg has already been notified for crossing the
// assignment-risk delta threshold (|delta| >= 0.50 -- see
// checkAssignmentRisk.ts) so the trade-alert scan doesn't re-notify on every
// run while the leg stays in that zone. Cleared once delta moves back out of
// the zone, so a future crossing notifies again.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.timestamp("assignment_risk_notified_at", { useTz: true });
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropColumn("assignment_risk_notified_at");
  });
}
