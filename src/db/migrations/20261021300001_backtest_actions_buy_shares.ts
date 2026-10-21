import type { Knex } from "knex";

// The Steady Stake (backtest decision maker "steady_stake") buys shares outright when it rebalances: a new action kind,
// "buy_shares". Down removes it (and the actions of that kind, which only Steady Stake sessions record).

const kindsBefore = ["open_cash_secured_put", "open_covered_call", "roll", "close_shares", "close_leg", "close_position"];

async function setKinds(knex: Knex, kinds: readonly string[]): Promise<void> {
  await knex.raw("ALTER TABLE backtest_actions DROP CONSTRAINT backtest_actions_kind_check");
  await knex.raw(`ALTER TABLE backtest_actions ADD CONSTRAINT backtest_actions_kind_check CHECK (kind = ANY (ARRAY[${kinds.map((kind) => `'${kind}'::text`).join(", ")}]))`);
}

export async function up(knex: Knex): Promise<void> {
  await setKinds(knex, [...kindsBefore, "buy_shares"]);
}

export async function down(knex: Knex): Promise<void> {
  await knex("backtest_actions").where({ kind: "buy_shares" }).delete();
  await setKinds(knex, kindsBefore);
}
