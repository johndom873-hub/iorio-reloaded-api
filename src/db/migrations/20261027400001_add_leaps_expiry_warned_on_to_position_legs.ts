import type { Knex } from "knex";

// LEAPS expiry warnings (leapsExpiryWarnings.ts): the session date of the last warning sent for the leg. Null = the
// 30-day notice has not gone out yet; equal to tonight's session = tonight's final-days notice already sent.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.date("leaps_expiry_warned_on").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropColumn("leaps_expiry_warned_on");
  });
}
