import { Router } from "express";
import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchNewTickerData } from "../ibkr/fetchNewTickerData.js";
import { fetchLiveGreeks, type GreeksContract } from "../ibkr/fetchLiveGreeks.js";

export const positionsRouter = Router();
positionsRouter.use(requireAuth);

// v1 strategy scope — matches screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];
const validStatuses = ["open", "closed"];

interface LegInput {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType?: "call" | "put";
  strikePrice?: number;
  expiryDate?: string;
  multiplier: number;
  entryPrice: number;
  entryAt: string;
}

// A "long" leg was bought to open (buy) and must be sold to close (sell); a
// "short" leg was sold to open (sell) and must be bought back to close (buy).
function openingTradeSide(legSide: "long" | "short"): "buy" | "sell" {
  return legSide === "long" ? "buy" : "sell";
}
function closingTradeSide(legSide: "long" | "short"): "buy" | "sell" {
  return legSide === "long" ? "sell" : "buy";
}

function validateLegInput(leg: LegInput): string | null {
  if (leg.legType !== "stock" && leg.legType !== "option") return "Invalid legType.";
  if (leg.side !== "long" && leg.side !== "short") return "Invalid side.";
  if (typeof leg.quantity !== "number" || leg.quantity <= 0) return "quantity must be a positive number.";
  if (typeof leg.multiplier !== "number" || leg.multiplier <= 0) return "multiplier must be a positive number.";
  if (typeof leg.entryPrice !== "number" || leg.entryPrice < 0) return "entryPrice must be a non-negative number.";
  if (!leg.entryAt) return "entryAt is required.";
  if (leg.legType === "option") {
    if (leg.optionType !== "call" && leg.optionType !== "put") return "optionType must be call or put for an option leg.";
    if (typeof leg.strikePrice !== "number" || leg.strikePrice <= 0) return "strikePrice must be a positive number for an option leg.";
    if (!leg.expiryDate) return "expiryDate is required for an option leg.";
  }
  return null;
}

// Aggregates legs as JSON per position — same raw-query style as screener.ts.
const positionSelect = `
  SELECT
    p.id,
    p.strategy_key AS "strategyKey",
    p.status,
    p.opened_at AS "openedAt",
    p.closed_at AS "closedAt",
    p.notes,
    p.price_target AS "priceTarget",
    p.close_trigger_notes AS "closeTriggerNotes",
    t.id AS "tickerId",
    t.symbol,
    t.company_name AS "companyName",
    t.sector,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'id', pl.id,
            'legType', pl.leg_type,
            'side', pl.side,
            'quantity', pl.quantity,
            'optionType', pl.option_type,
            'strikePrice', pl.strike_price,
            'expiryDate', pl.expiry_date,
            'multiplier', pl.multiplier,
            'ibkrContractId', pl.ibkr_contract_id,
            'entryPrice', pl.entry_price,
            'entryAt', pl.entry_at,
            'exitPrice', pl.exit_price,
            'exitAt', pl.exit_at
          ) ORDER BY pl.leg_type, pl.strike_price
        )
        FROM position_legs pl
        WHERE pl.position_id = p.id
      ),
      '[]'
    ) AS legs
  FROM positions p
  JOIN tickers t ON t.id = p.ticker_id
`;

positionsRouter.get("/", async (request, response) => {
  const status = (request.query.status as string | undefined) ?? "open";
  const strategyKey = request.query.strategy as string | undefined;

  if (!validStatuses.includes(status)) {
    response.status(400).json({ error: "status must be open or closed." });
    return;
  }
  if (strategyKey && !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategy." });
    return;
  }

  const conditions = ["p.status = ?"];
  const params: string[] = [status];
  if (strategyKey) {
    conditions.push("p.strategy_key = ?");
    params.push(strategyKey);
  }

  const result = await db.raw(
    `${positionSelect} WHERE ${conditions.join(" AND ")} ORDER BY p.opened_at DESC`,
    params,
  );
  response.json(result.rows);
});

positionsRouter.get("/greeks", async (request, response) => {
  const legIdsParam = request.query.legIds as string | undefined;
  if (!legIdsParam) {
    response.json({});
    return;
  }
  const legIds = legIdsParam.split(",").filter(Boolean);

  const rows = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .whereIn("pl.id", legIds)
    .andWhere("pl.leg_type", "option")
    .andWhere("p.status", "open")
    .select(
      "pl.id",
      "pl.option_type as optionType",
      "pl.strike_price as strikePrice",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as \"expiryDate\""),
      "t.symbol",
    );

  const contracts: GreeksContract[] = rows.map((row) => ({
    key: row.id,
    symbol: row.symbol,
    expiry: row.expiryDate,
    strike: Number(row.strikePrice),
    right: row.optionType === "call" ? OptionType.Call : OptionType.Put,
  }));

  const greeks = await fetchLiveGreeks(contracts);
  response.json(greeks);
});

positionsRouter.get("/:id", async (request, response) => {
  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [request.params.id]);
  const position = result.rows[0];
  if (!position) {
    response.status(404).json({ error: "Position not found." });
    return;
  }
  response.json(position);
});

positionsRouter.post("/", async (request, response) => {
  const { symbol, strategyKey, notes, priceTarget, legs } = request.body as {
    symbol?: string;
    strategyKey?: string;
    notes?: string | null;
    priceTarget?: number | null;
    legs?: LegInput[];
  };

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }
  if (!strategyKey || !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "A valid strategyKey is required." });
    return;
  }
  if (!legs || legs.length === 0) {
    response.status(400).json({ error: "At least one leg is required." });
    return;
  }
  for (const leg of legs) {
    const legError = validateLegInput(leg);
    if (legError) {
      response.status(400).json({ error: legError });
      return;
    }
  }

  const normalizedSymbol = symbol.trim().toUpperCase();

  let ticker = await db("tickers").where({ symbol: normalizedSymbol }).first();
  if (!ticker) {
    const tickerData = await fetchNewTickerData(normalizedSymbol);
    [ticker] = await db("tickers")
      .insert({ symbol: normalizedSymbol, company_name: tickerData.companyName, sector: tickerData.sector })
      .returning("*");
  }

  const position = await db.transaction(async (trx) => {
    const [newPosition] = await trx("positions")
      .insert({
        strategy_key: strategyKey,
        ticker_id: ticker.id,
        status: "open",
        notes: notes ?? null,
        price_target: priceTarget ?? null,
      })
      .returning("*");

    const insertedLegs = await trx("position_legs")
      .insert(
        legs.map((leg) => ({
          position_id: newPosition.id,
          leg_type: leg.legType,
          side: leg.side,
          quantity: leg.quantity,
          option_type: leg.optionType ?? null,
          strike_price: leg.strikePrice ?? null,
          expiry_date: leg.expiryDate ?? null,
          multiplier: leg.multiplier,
          entry_price: leg.entryPrice,
          entry_at: leg.entryAt,
        })),
      )
      .returning(["id", "side", "quantity", "entry_price", "entry_at"]);

    // Manually-entered positions have no real IBKR fill behind them, so
    // ibkr_order_id/ibkr_exec_id/commission/raw_ibkr_payload stay null —
    // see the Trade Blotter data-source decision (2026-08-20).
    await trx("trades").insert(
      insertedLegs.map((leg) => ({
        position_leg_id: leg.id,
        side: openingTradeSide(leg.side),
        quantity: leg.quantity,
        price: leg.entry_price,
        executed_at: leg.entry_at,
        is_closing_trade: false,
      })),
    );

    return newPosition;
  });

  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [position.id]);
  response.status(201).json(result.rows[0]);
});

positionsRouter.patch("/:id", async (request, response) => {
  const { notes, priceTarget, closeTriggerNotes } = request.body as {
    notes?: string | null;
    priceTarget?: number | null;
    closeTriggerNotes?: string | null;
  };

  const updatePayload: Record<string, unknown> = {};
  if (notes !== undefined) updatePayload.notes = notes;
  if (priceTarget !== undefined) updatePayload.price_target = priceTarget;
  if (closeTriggerNotes !== undefined) updatePayload.close_trigger_notes = closeTriggerNotes;

  const [updated] = await db("positions").where({ id: request.params.id }).update(updatePayload).returning("*");
  if (!updated) {
    response.status(404).json({ error: "Position not found." });
    return;
  }

  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [request.params.id]);
  response.json(result.rows[0]);
});

positionsRouter.post("/:id/close", async (request, response) => {
  const { legs } = request.body as { legs?: { legId: string; exitPrice: number; exitAt: string }[] };

  if (!legs || legs.length === 0) {
    response.status(400).json({ error: "At least one leg exit is required." });
    return;
  }
  for (const leg of legs) {
    if (!leg.legId || typeof leg.exitPrice !== "number" || !leg.exitAt) {
      response.status(400).json({ error: "Each leg requires legId, exitPrice, and exitAt." });
      return;
    }
  }

  try {
    await db.transaction(async (trx) => {
      const position = await trx("positions").where({ id: request.params.id }).first();
      if (!position) throw Object.assign(new Error("Position not found."), { statusCode: 404 });
      if (position.status !== "open") throw Object.assign(new Error("Position is already closed."), { statusCode: 409 });

      const existingLegs = await trx("position_legs").where({ position_id: position.id });
      const existingLegIds = new Set(existingLegs.map((leg) => leg.id));
      const providedLegIds = new Set(legs.map((leg) => leg.legId));
      const allLegsCovered =
        existingLegIds.size === providedLegIds.size && [...existingLegIds].every((id) => providedLegIds.has(id));
      if (!allLegsCovered) {
        throw Object.assign(new Error("All legs of this position must be included when closing it."), { statusCode: 400 });
      }

      const existingLegById = new Map(existingLegs.map((leg) => [leg.id, leg]));

      for (const leg of legs) {
        await trx("position_legs")
          .where({ id: leg.legId, position_id: position.id })
          .update({ exit_price: leg.exitPrice, exit_at: leg.exitAt });

        const existingLeg = existingLegById.get(leg.legId);
        await trx("trades").insert({
          position_leg_id: leg.legId,
          side: closingTradeSide(existingLeg.side),
          quantity: existingLeg.quantity,
          price: leg.exitPrice,
          executed_at: leg.exitAt,
          is_closing_trade: true,
        });
      }

      await trx("positions").where({ id: position.id }).update({ status: "closed", closed_at: trx.fn.now() });
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      response.status(statusCode).json({ error: (error as Error).message });
      return;
    }
    throw error;
  }

  const result = await db.raw(`${positionSelect} WHERE p.id = ?`, [request.params.id]);
  response.json(result.rows[0]);
});
