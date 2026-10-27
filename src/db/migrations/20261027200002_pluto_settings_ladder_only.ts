import type { Knex } from "knex";

// Edge Margin is retired with Signals (Marcelo 2026-10-27): the CC + Put Ladder is Pluto's only strategy and the code no
// longer reads execution_strategy. The stored value is set to the ladder so a rolled-back release runs the ladder too;
// the column is dropped with the retired Signals tables, once the release has settled.
export async function up(knex: Knex): Promise<void> {
  await knex("pluto_settings").update({ execution_strategy: "cc_put_ladder" });
  await knex.raw("alter table pluto_settings alter column execution_strategy set default 'cc_put_ladder'");
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw("alter table pluto_settings alter column execution_strategy set default 'edge_margin'");
}
