import type { Knex } from "knex";

// "Allow opens under stress today" (Marcelo, 2026-09-28): a same-day override of the SPY
// stress check, set from the Pluto screen and audited; it expires with the Eastern date.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_state", (table) => {
    table.date("stress_override_date").nullable();
    table.uuid("stress_override_by_user_id").nullable().references("id").inTable("users");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_state", (table) => {
    table.dropColumn("stress_override_date");
    table.dropColumn("stress_override_by_user_id");
  });
}
