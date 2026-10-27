import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// Today's Pluto orders, straight from the ledger in Eastern time, for the screen's "Orders today" figure.

const actionOutcomesThatCount = ["order_built", "confirmed", "filled", "partially_filled", "cancelled", "cancelled_partially_filled", "rejected", "error"];

/** Today's orders by where they got to, for the screen's "Orders today" figure: sent = every order that reached the routes. */
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
