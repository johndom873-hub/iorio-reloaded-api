import type { Knex } from "knex";

// Where a position's shares came from (Marcelo, 2026-09-29, option A): reconciliation records a link
// whenever it hands shares from one position to another (a covered call expiring or rolling, leftover
// stock getting a call sold against it) or an assigned put delivers them. Pluto's book follows these
// links, so shares from a Pluto position stay Pluto's after they move to a new row.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable("position_share_sources", (table) => {
    table.uuid("position_id").notNullable().references("id").inTable("positions").onDelete("CASCADE");
    table.uuid("source_position_id").notNullable().references("id").inTable("positions").onDelete("CASCADE");
    table.timestamp("created_at", { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.primary(["position_id", "source_position_id"]);
    table.index(["source_position_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable("position_share_sources");
}
