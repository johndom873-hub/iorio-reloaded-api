import { db } from "../db/connection.js";
import { easternDateIso } from "../lib/marketSessionStatus.js";

// Today's session counters, straight from the ledger in Eastern time. Read by the screen's
// state endpoint and by the agent's system checks (action cap, model-call cap, cost ceiling).

export interface PlutoTodayCounters {
  actionsToday: number;
  modelCallsToday: number;
  costTodayUsd: number;
}

const actionOutcomesThatCount = ["order_built", "confirmed", "filled", "partially_filled", "cancelled", "rejected", "error"];

export async function loadPlutoTodayCounters(now: Date = new Date()): Promise<PlutoTodayCounters> {
  const todayIso = easternDateIso(now);
  const [actions, calls] = await Promise.all([
    db("pluto_actions")
      .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?", [todayIso])
      .whereIn("outcome", actionOutcomesThatCount)
      .count<{ count: string }[]>("* as count")
      .then((rows) => Number(rows[0]?.count ?? 0)),
    db("pluto_decisions")
      .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?", [todayIso])
      .select(db.raw("count(*)::int as calls"), db.raw("coalesce(sum(cost_usd), 0)::float as cost"))
      .first(),
  ]);
  return { actionsToday: actions, modelCallsToday: Number(calls?.calls ?? 0), costTodayUsd: Number(calls?.cost ?? 0) };
}

/** Consecutive model failures at the tail of today's decisions — the breaker input. */
export async function countTrailingModelFailures(now: Date = new Date()): Promise<number> {
  const todayIso = easternDateIso(now);
  const rows: { error: string | null; schema_valid: boolean }[] = await db("pluto_decisions")
    .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?", [todayIso])
    .orderBy("created_at", "desc")
    .limit(20)
    .select("error", "schema_valid");
  let count = 0;
  for (const row of rows) {
    if (row.error !== null || !row.schema_valid) count += 1;
    else break;
  }
  return count;
}
