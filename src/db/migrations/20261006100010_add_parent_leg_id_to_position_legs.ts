import type { Knex } from "knex";

// A partial close is carved into its own closed leg (partialCloseSlice.ts); the slice records the leg it was carved
// from, so whoever opened that leg (a Pluto action, for its realized P&L) still owns the slice (Marcelo, 2026-10-05).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.uuid("parent_leg_id").references("id").inTable("position_legs").onDelete("SET NULL");
    table.index(["parent_leg_id"]);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("position_legs", (table) => {
    table.dropIndex(["parent_leg_id"]);
    table.dropColumn("parent_leg_id");
  });
}
