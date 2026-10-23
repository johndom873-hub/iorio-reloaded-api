import type { Knex } from "knex";

// The baseline wheel's hedge (Marcelo 2026-10-22): long Puts bought on the shares the entries bring in. A new position
// strategy, "hedge", and two action kinds, "buy_hedge" and "sell_hedge". Down removes them (and the rows of that strategy
// and those kinds, which only hedged sessions record).

const actionKindsBefore = ["open_cash_secured_put", "open_covered_call", "roll", "close_shares", "close_leg", "close_position", "buy_shares"];
const strategyKeysBefore = ["cash_secured_put", "covered_call", "unstructured"];

async function setActionKinds(knex: Knex, kinds: readonly string[]): Promise<void> {
  await knex.raw("ALTER TABLE backtest_actions DROP CONSTRAINT backtest_actions_kind_check");
  await knex.raw(`ALTER TABLE backtest_actions ADD CONSTRAINT backtest_actions_kind_check CHECK (kind = ANY (ARRAY[${kinds.map((kind) => `'${kind}'::text`).join(", ")}]))`);
}

async function setPositionStrategyKeys(knex: Knex, keys: readonly string[]): Promise<void> {
  await knex.raw("ALTER TABLE backtest_positions DROP CONSTRAINT backtest_positions_strategy_key_check");
  await knex.raw(`ALTER TABLE backtest_positions ADD CONSTRAINT backtest_positions_strategy_key_check CHECK (strategy_key = ANY (ARRAY[${keys.map((key) => `'${key}'::text`).join(", ")}]))`);
}

export async function up(knex: Knex): Promise<void> {
  await setActionKinds(knex, [...actionKindsBefore, "buy_hedge", "sell_hedge"]);
  await setPositionStrategyKeys(knex, [...strategyKeysBefore, "hedge"]);
}

export async function down(knex: Knex): Promise<void> {
  await knex("backtest_actions").whereIn("kind", ["buy_hedge", "sell_hedge"]).delete();
  await setActionKinds(knex, actionKindsBefore);
  const hedgePositions = knex("backtest_positions").where({ strategy_key: "hedge" }).select("session_id", "position_id");
  await knex("backtest_position_legs").whereIn(["session_id", "position_id"], hedgePositions).delete();
  await knex("backtest_fills").whereIn(["session_id", "position_id"], hedgePositions).delete();
  await knex("backtest_positions").where({ strategy_key: "hedge" }).delete();
  await setPositionStrategyKeys(knex, strategyKeysBefore);
}
