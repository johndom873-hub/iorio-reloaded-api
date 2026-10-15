import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { PositionFigures, PositionLegFigures } from "../lib/positionSelectors.js";

// What the CC + Put Ladder's look book (ladderLookBook.ts) reads from the database for one ticker.

type LegRow = {
  positionId: string;
  strategyKey: string;
  id: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: string | number;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  multiplier: string | number;
  entryPrice: string | number;
  entryAt: Date;
  exitPrice: string | null;
  exitAt: Date | null;
};

/** The ticker's open positions with every leg (closed legs included, as positionSelect reads them). */
export async function loadOpenPositionFigures(tickerId: string, connection: Knex = db): Promise<PositionFigures[]> {
  const rows: LegRow[] = await connection("positions as p")
    .join("position_legs as pl", "pl.position_id", "p.id")
    .where({ "p.ticker_id": tickerId, "p.status": "open" })
    .orderBy([{ column: "p.opened_at", order: "asc" }, { column: "pl.entry_at", order: "asc" }])
    .select(
      "p.id as positionId",
      "p.strategy_key as strategyKey",
      "pl.id",
      "pl.leg_type as legType",
      "pl.side",
      "pl.quantity",
      "pl.option_type as optionType",
      "pl.strike_price as strikePrice",
      connection.raw('pl.expiry_date::text as "expiryDate"'),
      "pl.multiplier",
      "pl.entry_price as entryPrice",
      "pl.entry_at as entryAt",
      "pl.exit_price as exitPrice",
      "pl.exit_at as exitAt",
    );
  const byPosition = new Map<string, { strategyKey: string; legs: PositionLegFigures[] }>();
  for (const row of rows) {
    const position = byPosition.get(row.positionId) ?? { strategyKey: row.strategyKey, legs: [] };
    position.legs.push({
      id: row.id,
      legType: row.legType,
      side: row.side,
      quantity: Number(row.quantity),
      optionType: row.optionType,
      strikePrice: row.strikePrice === null ? null : Number(row.strikePrice),
      expiryDate: row.expiryDate,
      multiplier: Number(row.multiplier),
      entryPrice: Number(row.entryPrice),
      entryAt: new Date(row.entryAt),
      exitPrice: row.exitPrice === null ? null : Number(row.exitPrice),
      exitAt: row.exitAt === null ? null : new Date(row.exitAt),
    });
    byPosition.set(row.positionId, position);
  }
  return [...byPosition.values()].map((position) => ({ strategyKey: position.strategyKey, status: "open", legs: position.legs }));
}
