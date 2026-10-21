import type { Knex } from "knex";

// One row: which Pluto agent process may act (src/pluto/agentLease.ts). Its own table rather than columns on pluto_state:
// the order confirm holds a row lock on it while the gates run, which must not hold up a pause or a readiness save.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("pluto_agent_lease", (table) => {
    table.integer("id").primary();
    table.text("holder");
    table.timestamp("lease_until", { useTz: true });
    table.timestamp("taken_at", { useTz: true });
  });
  await knex.raw("ALTER TABLE pluto_agent_lease ADD CONSTRAINT pluto_agent_lease_single_row CHECK (id = 1)");
  await knex("pluto_agent_lease").insert({ id: 1 });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists("pluto_agent_lease");
}
