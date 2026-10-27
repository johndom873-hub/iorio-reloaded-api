import type { Knex } from "knex";

// Vol Farmer v2's LEAPS Calls (Marcelo 2026-10-27: the hedge is protective Puts, every long Call a LEAPS): a position
// strategy of their own, "leaps", and two action kinds, "buy_leaps" and "sell_leaps". Down removes them (and the rows of
// that strategy and those kinds, which only Vol Farmer v2 sessions record).

const actionKindsBefore = ["open_cash_secured_put", "open_covered_call", "roll", "close_shares", "close_leg", "close_position", "buy_shares", "buy_hedge", "sell_hedge"];
const strategyKeysBefore = ["cash_secured_put", "covered_call", "unstructured", "hedge"];

async function setActionKinds(knex: Knex, kinds: readonly string[]): Promise<void> {
  await knex.raw("ALTER TABLE backtest_actions DROP CONSTRAINT backtest_actions_kind_check");
  await knex.raw(`ALTER TABLE backtest_actions ADD CONSTRAINT backtest_actions_kind_check CHECK (kind = ANY (ARRAY[${kinds.map((kind) => `'${kind}'::text`).join(", ")}]))`);
}

async function setPositionStrategyKeys(knex: Knex, keys: readonly string[]): Promise<void> {
  await knex.raw("ALTER TABLE backtest_positions DROP CONSTRAINT backtest_positions_strategy_key_check");
  await knex.raw(`ALTER TABLE backtest_positions ADD CONSTRAINT backtest_positions_strategy_key_check CHECK (strategy_key = ANY (ARRAY[${keys.map((key) => `'${key}'::text`).join(", ")}]))`);
}

export async function up(knex: Knex): Promise<void> {
  await setActionKinds(knex, [...actionKindsBefore, "buy_leaps", "sell_leaps"]);
  await setPositionStrategyKeys(knex, [...strategyKeysBefore, "leaps"]);
}

export async function down(knex: Knex): Promise<void> {
  await knex("backtest_actions").whereIn("kind", ["buy_leaps", "sell_leaps"]).delete();
  await setActionKinds(knex, actionKindsBefore);
  const leapsPositions = knex("backtest_positions").where({ strategy_key: "leaps" }).select("session_id", "position_id");
  await knex("backtest_position_legs").whereIn(["session_id", "position_id"], leapsPositions).delete();
  await knex("backtest_fills").whereIn(["session_id", "position_id"], leapsPositions).delete();
  await knex("backtest_positions").where({ strategy_key: "leaps" }).delete();
  await setPositionStrategyKeys(knex, strategyKeysBefore);
}
