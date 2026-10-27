import { db } from "../db/connection.js";

// Open short option legs on covered-call and cash-secured-put positions: the
// Ticker modal's rolls and the assignment-risk alert's legs.

/** An open short option leg as read from position_legs. */
export interface OpenShortLeg {
  legId: string;
  positionId: string;
  strategyKey: "covered_call" | "cash_secured_put";
  expiry: string; // ISO date
  strike: number;
  right: "C" | "P";
  quantity: number;
  /** Credit collected per share when the leg was opened. */
  entryPrice: number;
  entryAtIso: string;
}

export function openShortLegPositionsQuery() {
  return db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .where({ "p.status": "open", "pl.leg_type": "option", "pl.side": "short" })
    .whereIn("p.strategy_key", ["covered_call", "cash_secured_put"])
    .whereNull("pl.exit_at");
}

/** Every open short option leg on a covered-call or cash-secured-put position of this ticker (Roll Signals' A side). */
export async function loadOpenShortLegs(tickerId: string): Promise<OpenShortLeg[]> {
  const rows: { legId: string; positionId: string; strategyKey: string; expiry: string; strike: string; optionType: "call" | "put"; quantity: number; entryPrice: string; entryAt: Date }[] = await openShortLegPositionsQuery()
    .where("p.ticker_id", tickerId)
    .select("pl.id as legId", "p.id as positionId", "p.strategy_key as strategyKey", db.raw('pl.expiry_date::text as expiry'), "pl.strike_price as strike", "pl.option_type as optionType", "pl.quantity", "pl.entry_price as entryPrice", "pl.entry_at as entryAt")
    .orderBy(["pl.expiry_date", "pl.strike_price"]);
  return rows.map((row) => ({
    legId: row.legId,
    positionId: row.positionId,
    strategyKey: row.strategyKey as OpenShortLeg["strategyKey"],
    expiry: row.expiry,
    strike: Number(row.strike),
    right: row.optionType === "call" ? "C" : "P",
    quantity: Number(row.quantity),
    entryPrice: Number(row.entryPrice),
    entryAtIso: new Date(row.entryAt).toISOString(),
  }));
}
