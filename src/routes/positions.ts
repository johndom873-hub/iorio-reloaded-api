import { Router } from "express";
import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchNewTickerData } from "../ibkr/fetchNewTickerData.js";
import { fetchLiveGreeks, type GreeksContract } from "../ibkr/fetchLiveGreeks.js";
import { fetchLivePrices, type PriceContract } from "../ibkr/fetchLivePrices.js";

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
// realizedPnl/capitalAtRisk formulas approved 2026-08-21:
//   realizedPnl = sum over all exited legs of (exit - entry) * qty * multiplier
//     * (short ? -1 : 1) — same shape as the Trade Blotter's approved formula
//     (2026-08-20), aggregated per position. Includes a rolled-away leg's
//     locked-in gain even while the position is still open.
//   capitalAtRisk = entry-time capital committed, same definition as Trade
//     Alerts' approved capitalAtRisk (spot for covered calls, strike for
//     CSPs) but from entry actuals rather than a scan-time estimate.
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
    NULLIF(t.sector, '') AS sector,
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
    ) AS legs,
    COALESCE(
      (
        SELECT SUM((pl.exit_price - pl.entry_price) * pl.quantity * pl.multiplier * (CASE WHEN pl.side = 'short' THEN -1 ELSE 1 END))
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.exit_price IS NOT NULL
      ),
      0
    ) AS "realizedPnl",
    CASE
      WHEN p.strategy_key = 'covered_call' THEN (
        SELECT pl.entry_price * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'stock'
        LIMIT 1
      )
      ELSE (
        -- Cash-secured puts have no stock leg — collateral is the option
        -- leg's strike. Prefers the currently-open leg (still-live
        -- collateral) over an already-rolled-away one, falling back to the
        -- most recent by entry date for closed positions.
        SELECT pl.strike_price * pl.multiplier * pl.quantity
        FROM position_legs pl
        WHERE pl.position_id = p.id AND pl.leg_type = 'option'
        ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
        LIMIT 1
      )
    END AS "capitalAtRisk"
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

// On-demand unrealized P&L for open positions — mirrors /greeks's shape
// (batch lookup by id, live IBKR round-trip). Unrealized-only: the SQL in
// positionSelect above already covers realizedPnl/capitalAtRisk from
// stored data with no live call needed. unrealizedPnl only marks
// currently-open legs (exit_at IS NULL) to market — an already-rolled-away
// leg's gain is locked in and already counted in realizedPnl, so it isn't
// re-priced live here.
positionsRouter.get("/pnl", async (request, response) => {
  const positionIdsParam = request.query.positionIds as string | undefined;
  if (!positionIdsParam) {
    response.json({});
    return;
  }
  const positionIds = positionIdsParam.split(",").filter(Boolean);

  const legRows = await db("position_legs as pl")
    .join("positions as p", "p.id", "pl.position_id")
    .join("tickers as t", "t.id", "p.ticker_id")
    .whereIn("pl.position_id", positionIds)
    .andWhere("p.status", "open")
    .andWhere("pl.exit_at", null)
    .select(
      "pl.id",
      "pl.position_id as positionId",
      "pl.leg_type as legType",
      "pl.side",
      "pl.quantity",
      "pl.multiplier",
      "pl.entry_price as entryPrice",
      "pl.option_type as optionType",
      "pl.strike_price as strikePrice",
      db.raw("to_char(pl.expiry_date, 'YYYYMMDD') as \"expiryDate\""),
      "t.symbol",
    );

  const priceContracts: PriceContract[] = legRows.map((leg) => ({
    key: leg.id,
    legType: leg.legType,
    symbol: leg.symbol,
    expiry: leg.expiryDate ?? undefined,
    strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
    right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
  }));
  const pricesByLegId = await fetchLivePrices(priceContracts);

  const unrealizedByPositionId: Record<string, number | null> = {};
  for (const positionId of positionIds) unrealizedByPositionId[positionId] = 0;

  for (const leg of legRows) {
    if (unrealizedByPositionId[leg.positionId] === null) continue;
    const currentPrice = pricesByLegId[leg.id];
    if (currentPrice === null || currentPrice === undefined) {
      unrealizedByPositionId[leg.positionId] = null;
      continue;
    }
    const sign = leg.side === "short" ? -1 : 1;
    const entryPrice = Number(leg.entryPrice);
    unrealizedByPositionId[leg.positionId] =
      (unrealizedByPositionId[leg.positionId] ?? 0) + (currentPrice - entryPrice) * leg.quantity * leg.multiplier * sign;
  }

  response.json(unrealizedByPositionId);
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
  const { symbol, strategyKey, notes, priceTarget, legs, sourceAlertId } = request.body as {
    symbol?: string;
    strategyKey?: string;
    notes?: string | null;
    priceTarget?: number | null;
    legs?: LegInput[];
    // If this position originated from a Trade Alert (approved, with or
    // without edits — see tradeAlerts.ts for why there's no separate
    // "modified" path), links the alert back to the resulting position.
    sourceAlertId?: string;
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

  let position: { id: string };
  try {
    position = await db.transaction(async (trx) => {
      if (sourceAlertId) {
        const alert = await trx("trade_alerts").where({ id: sourceAlertId, status: "pending" }).first();
        if (!alert) throw Object.assign(new Error("Pending trade alert not found for sourceAlertId."), { statusCode: 404 });
        if (alert.ticker_id !== ticker.id || alert.strategy_key !== strategyKey) {
          throw Object.assign(new Error("sourceAlertId does not match this symbol/strategy."), { statusCode: 400 });
        }
      }

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

      if (sourceAlertId) {
        await trx("trade_alerts").where({ id: sourceAlertId }).update({
          status: "approved",
          resulting_position_id: newPosition.id,
          reviewed_by_user_id: request.session.userId,
          reviewed_at: trx.fn.now(),
        });
      }

      return newPosition;
    });
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode) {
      response.status(statusCode).json({ error: (error as Error).message });
      return;
    }
    throw error;
  }

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

// Rolls one short option leg on an open position: closes it (exit_price/exit_at
// on that leg only, position stays open) and opens a new option leg on the
// same position — matches the schema comment on trade_alerts.related_position_id
// ("close the existing short option leg and open a new one, same position"),
// not a new-position creation like the sourceAlertId flow above. Deliberately
// narrower than a general partial-leg-close endpoint (still an open gap for
// other use cases, see PROGRESS.md) — this only ever closes exactly one
// existing option leg and opens exactly one new option leg, both validated
// against the same roll alert.
positionsRouter.post("/:id/roll", async (request, response) => {
  const { sourceAlertId, closeLegId, exitPrice, exitAt, newLeg } = request.body as {
    sourceAlertId?: string;
    closeLegId?: string;
    exitPrice?: number;
    exitAt?: string;
    newLeg?: {
      strikePrice: number;
      expiryDate: string;
      quantity: number;
      multiplier: number;
      entryPrice: number;
      entryAt: string;
    };
  };

  if (!sourceAlertId) {
    response.status(400).json({ error: "sourceAlertId is required." });
    return;
  }
  if (!closeLegId || typeof exitPrice !== "number" || exitPrice < 0 || !exitAt) {
    response.status(400).json({ error: "closeLegId, a non-negative exitPrice, and exitAt are required." });
    return;
  }
  if (
    !newLeg ||
    typeof newLeg.strikePrice !== "number" ||
    newLeg.strikePrice <= 0 ||
    !newLeg.expiryDate ||
    typeof newLeg.quantity !== "number" ||
    newLeg.quantity <= 0 ||
    typeof newLeg.multiplier !== "number" ||
    newLeg.multiplier <= 0 ||
    typeof newLeg.entryPrice !== "number" ||
    newLeg.entryPrice < 0 ||
    !newLeg.entryAt
  ) {
    response.status(400).json({ error: "newLeg requires strikePrice, expiryDate, quantity, multiplier, entryPrice, and entryAt." });
    return;
  }

  try {
    await db.transaction(async (trx) => {
      const position = await trx("positions").where({ id: request.params.id }).first();
      if (!position) throw Object.assign(new Error("Position not found."), { statusCode: 404 });
      if (position.status !== "open") throw Object.assign(new Error("Position is already closed."), { statusCode: 409 });

      const alert = await trx("trade_alerts").where({ id: sourceAlertId, status: "pending" }).first();
      if (!alert) throw Object.assign(new Error("Pending trade alert not found for sourceAlertId."), { statusCode: 404 });
      if (alert.alert_type !== "roll") throw Object.assign(new Error("sourceAlertId is not a roll alert."), { statusCode: 400 });
      if (alert.related_position_id !== position.id) {
        throw Object.assign(new Error("sourceAlertId does not match this position."), { statusCode: 400 });
      }

      const closingLeg = await trx("position_legs").where({ id: closeLegId, position_id: position.id }).first();
      if (!closingLeg) throw Object.assign(new Error("Leg not found on this position."), { statusCode: 404 });
      if (closingLeg.leg_type !== "option") throw Object.assign(new Error("Only option legs can be rolled."), { statusCode: 400 });
      if (closingLeg.exit_at) throw Object.assign(new Error("Leg is already closed."), { statusCode: 409 });

      await trx("position_legs").where({ id: closeLegId }).update({ exit_price: exitPrice, exit_at: exitAt });
      await trx("trades").insert({
        position_leg_id: closeLegId,
        side: closingTradeSide(closingLeg.side),
        quantity: closingLeg.quantity,
        price: exitPrice,
        executed_at: exitAt,
        is_closing_trade: true,
      });

      const [insertedLeg] = await trx("position_legs")
        .insert({
          position_id: position.id,
          leg_type: "option",
          side: closingLeg.side,
          quantity: newLeg.quantity,
          option_type: closingLeg.option_type,
          strike_price: newLeg.strikePrice,
          expiry_date: newLeg.expiryDate,
          multiplier: newLeg.multiplier,
          entry_price: newLeg.entryPrice,
          entry_at: newLeg.entryAt,
        })
        .returning(["id", "side", "quantity", "entry_price", "entry_at"]);

      await trx("trades").insert({
        position_leg_id: insertedLeg.id,
        side: openingTradeSide(insertedLeg.side),
        quantity: insertedLeg.quantity,
        price: insertedLeg.entry_price,
        executed_at: insertedLeg.entry_at,
        is_closing_trade: false,
      });

      await trx("trade_alerts").where({ id: sourceAlertId }).update({
        status: "approved",
        resulting_position_id: position.id,
        reviewed_by_user_id: request.session.userId,
        reviewed_at: trx.fn.now(),
      });
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
