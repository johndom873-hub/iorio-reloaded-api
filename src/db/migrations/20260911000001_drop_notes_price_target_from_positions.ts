import type { Knex } from "knex";

// notes/price_target/close_trigger_notes were never used in practice (0 of
// 37 real prod positions had any of the three set, confirmed via direct
// query before writing this migration) — removed per Marcelo's call
// 2026-09-11, along with the UI form and the now-dead PATCH /positions/:id
// route and update_position_notes Genosuke tool that only existed to write
// them.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.dropColumn("notes");
    table.dropColumn("price_target");
    table.dropColumn("close_trigger_notes");
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("positions", (table) => {
    table.text("notes");
    table.decimal("price_target", 12, 4);
    table.text("close_trigger_notes");
  });
}
