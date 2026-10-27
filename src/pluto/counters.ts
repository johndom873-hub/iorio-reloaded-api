import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Today's session counters, straight from the ledger in Eastern time. Read by the screen's
// state endpoint and by the agent's system checks (the action cap).

export interface PlutoTodayCounters {
  actionsToday: number;
}

const actionOutcomesThatCount = ["order_built", "confirmed", "filled", "partially_filled", "cancelled", "cancelled_partially_filled", "rejected", "error"];

export async function loadPlutoTodayCounters(now: Date = new Date()): Promise<PlutoTodayCounters> {
  const todayIso = easternIsoDate(now);
  const actionsToday = await db("pluto_actions")
    .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?", [todayIso])
    .whereIn("outcome", actionOutcomesThatCount)
    .count<{ count: string }[]>("* as count")
    .then((rows) => Number(rows[0]?.count ?? 0));
  return { actionsToday };
}

/** Today's orders by where they got to, for the screen's "Orders today" figure: sent = every order that reached the routes (the action cap's count). */
export interface PlutoOrdersTodayBreakdown {
  sent: number;
  filled: number;
  working: number;
  blocked: number;
}

export async function loadPlutoOrdersTodayBreakdown(now: Date = new Date(), connection: Knex = db): Promise<PlutoOrdersTodayBreakdown> {
  const todayIso = easternIsoDate(now);
  const rows: { outcome: string; count: string }[] = await connection("pluto_actions")
    .whereRaw("(created_at AT TIME ZONE 'America/New_York')::date = ?", [todayIso])
    .groupBy("outcome")
    .select("outcome")
    .count("* as count");
  const breakdown: PlutoOrdersTodayBreakdown = { sent: 0, filled: 0, working: 0, blocked: 0 };
  for (const row of rows) {
    const count = Number(row.count);
    if (actionOutcomesThatCount.includes(row.outcome)) breakdown.sent += count;
    if (row.outcome === "filled" || row.outcome === "partially_filled" || row.outcome === "cancelled_partially_filled") breakdown.filled += count;
    if (row.outcome === "order_built" || row.outcome === "confirmed") breakdown.working += count;
    if (row.outcome === "blocked") breakdown.blocked += count;
  }
  return breakdown;
}
