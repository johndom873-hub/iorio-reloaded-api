import type { Knex } from "knex";

// Pluto's pre-open readiness check (Marcelo, 2026-10-06): today's last run, kept on the state row so a restart mid-morning
// picks up where it left off and the screen can show it.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_state", (table) => {
    table.jsonb("readiness").nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_state", (table) => {
    table.dropColumn("readiness");
  });
}
