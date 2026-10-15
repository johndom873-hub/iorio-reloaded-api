import type { Knex } from "knex";

// Each Pluto action records the strategy that took it (Marcelo 2026-10-15), so the order route and its gates judge a
// CC + Put Ladder order by the ladder's rules even if the strategy is switched while it works. Written from the action's
// pass (the settings version it ran under) by recordPlutoAction; the default is Edge Margin's, the only strategy before the ladder.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.text("execution_strategy").notNullable().defaultTo("edge_margin");
  });
  await knex.raw("alter table pluto_actions add constraint pluto_actions_execution_strategy_check check (execution_strategy in ('edge_margin', 'cc_put_ladder'))");
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable("pluto_actions", (table) => {
    table.dropColumn("execution_strategy");
  });
}
