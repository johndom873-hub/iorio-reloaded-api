import { Router } from "express";
import { OptionType, OrderAction } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchLiveGreeks, type GreeksContract } from "../ibkr/fetchLiveGreeks.js";
import { fetchLivePrices, type PriceContract } from "../ibkr/fetchLivePrices.js";
import type { OrderLegPayload, OrderRequestPayload } from "../ibkr/orderPayload.js";

export const positionsRouter = Router();
positionsRouter.use(requireAuth);

// v1 strategy scope — matches screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];
const validStatuses = ["open", "closed"];
const orderRequestsChannel = "order_requests_channel";

// Guards against a naked covered call — a short call leg must never cover
// more shares than the position actually holds long. Approved 2026-08-24
// after a real prod position (AAOI) was entered with a short call quantity
// of 100 (contracts) against only 100 shares of stock — 99 contracts naked.
// Over-coverage (more stock than the short calls need) is allowed; it's
// conservative, not risky. Only applies to covered_call — cash_secured_put
// has no stock leg to cover against.
function validateCoveredCallCoverage(stockShares: number, shortCallCoveredShares: number): string | null {
  if (shortCallCoveredShares > stockShares) {
    return `Short call coverage (${shortCallCoveredShares} shares) exceeds stock held (${stockShares} shares) — this would leave the position naked.`;
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

export interface UnrealizedPnlResult {
  unrealizedPnl: number | null;
  // Set only when unrealizedPnl came from position_pnl_snapshots instead of
  // a live IBKR quote (see the fallback note below) — the date that
  // snapshot was captured, so the UI can label it "as of <date>" rather
  // than implying a live number.
  asOfDate: string | null;
}

// On-demand unrealized P&L for open positions — mirrors /greeks's shape
// (batch lookup by id, live IBKR round-trip). Unrealized-only: the SQL in
// positionSelect above already covers realizedPnl/capitalAtRisk from
// stored data with no live call needed. unrealizedPnl only marks
// currently-open legs (exit_at IS NULL) to market — an already-rolled-away
// leg's gain is locked in and already counted in realizedPnl, so it isn't
// re-priced live here.
//
// Fallback (approved 2026-08-24): when live IBKR pricing is unavailable
// for a position (e.g. outside market hours), fall back to that
// position's most recent row in position_pnl_snapshots — written nightly
// by the daily P&L snapshot job (9:30 PM UTC, ~5:30 PM ET, after close) —
// rather than reusing reqHistoricalData at request time. reqHistoricalData
// has its own strict IBKR pacing limiter shared with the nightly capture
// jobs; calling it per-request from this route risks locking out those
// jobs under normal page-view traffic. position_pnl_snapshots already
// stores the correctly-computed whole-position figure (both legs,
// multiplier/quantity/sign already applied) as a plain DB read. A position
// opened after that night's job already ran has no snapshot yet and stays
// unavailable until the next run.
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

  const positionIdsMissingLive = positionIds.filter((id) => unrealizedByPositionId[id] === null);
  const fallbackByPositionId = new Map<string, { unrealizedPnl: string; snapshotDate: string }>();
  if (positionIdsMissingLive.length > 0) {
    const latestSnapshotRows = await db.raw(
      `
      SELECT DISTINCT ON (position_id)
        position_id AS "positionId",
        unrealized_pnl AS "unrealizedPnl",
        to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate"
      FROM position_pnl_snapshots
      WHERE position_id = ANY(?)
      ORDER BY position_id, snapshot_date DESC
      `,
      [positionIdsMissingLive],
    );
    for (const row of latestSnapshotRows.rows) {
      fallbackByPositionId.set(row.positionId, { unrealizedPnl: row.unrealizedPnl, snapshotDate: row.snapshotDate });
    }
  }

  const result: Record<string, UnrealizedPnlResult> = {};
  for (const positionId of positionIds) {
    const unrealizedPnl = unrealizedByPositionId[positionId] ?? null;
    if (unrealizedPnl !== null) {
      result[positionId] = { unrealizedPnl, asOfDate: null };
      continue;
    }
    const fallback = fallbackByPositionId.get(positionId);
    result[positionId] = fallback
      ? { unrealizedPnl: Number(fallback.unrealizedPnl), asOfDate: fallback.snapshotDate }
      : { unrealizedPnl: null, asOfDate: null };
  }

  response.json(result);
});

// --- Order placement (approved 2026-08-24 — see the plan doc) ---
// The web dyno never writes positions/position_legs/trades directly for a
// new/closed/rolled leg anymore. It only ever builds an order_requests row
// and, on confirm, NOTIFYs the worker (src/worker.ts) to actually place the
// order with IBKR. Only the worker writes those three tables now, and only
// from data IBKR itself reported (a real fill, a real position) — see
// "IBKR is the source of truth" in PROGRESS.md.
//
// Registered here, before GET /:id, so Express's registration-order route
// matching doesn't let GET /:id's wildcard segment swallow "/orders" as an
// id value.

async function requireExistingTicker(symbolInput: string): Promise<{ id: string; symbol: string } | null> {
  const normalizedSymbol = symbolInput.trim().toUpperCase();
  return (await db("tickers").where({ symbol: normalizedSymbol }).first()) ?? null;
}

interface OpenOrderRequestBody {
  symbol?: string;
  strategyKey?: string;
  stock?: { quantity: number; limitPrice: number };
  option?: { quantity: number; limitPrice: number; strikePrice: number; expiryDate: string };
  notes?: string | null;
  priceTarget?: number | null;
  sourceAlertId?: string;
}

positionsRouter.post("/orders", async (request, response) => {
  const { symbol, strategyKey, stock, option, sourceAlertId } = request.body as OpenOrderRequestBody;

  if (!symbol || !symbol.trim()) {
    response.status(400).json({ error: "Symbol is required." });
    return;
  }
  if (!strategyKey || !validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "A valid strategyKey is required." });
    return;
  }
  if (!option || typeof option.quantity !== "number" || option.quantity <= 0) {
    response.status(400).json({ error: "A positive option contract quantity is required." });
    return;
  }
  if (typeof option.limitPrice !== "number" || option.limitPrice < 0) {
    response.status(400).json({ error: "option.limitPrice must be a non-negative number." });
    return;
  }
  if (typeof option.strikePrice !== "number" || option.strikePrice <= 0 || !option.expiryDate) {
    response.status(400).json({ error: "option.strikePrice and option.expiryDate are required." });
    return;
  }
  if (strategyKey === "covered_call") {
    if (!stock || typeof stock.quantity !== "number" || stock.quantity <= 0) {
      response.status(400).json({ error: "A positive stock quantity is required for a covered call." });
      return;
    }
    if (typeof stock.limitPrice !== "number" || stock.limitPrice < 0) {
      response.status(400).json({ error: "stock.limitPrice must be a non-negative number." });
      return;
    }
    const coverageError = validateCoveredCallCoverage(stock.quantity, option.quantity * 100);
    if (coverageError) {
      response.status(400).json({ error: coverageError });
      return;
    }
  }

  const ticker = await requireExistingTicker(symbol);
  if (!ticker) {
    response.status(400).json({ error: "Unknown symbol — add it via the Screener first." });
    return;
  }

  const legs: OrderLegPayload[] = [];
  if (strategyKey === "covered_call") {
    legs.push({ role: "stock", action: OrderAction.BUY, symbol: ticker.symbol, quantity: stock!.quantity, unitPrice: stock!.limitPrice });
  }
  legs.push({
    role: "option",
    action: OrderAction.SELL,
    symbol: ticker.symbol,
    quantity: option.quantity,
    unitPrice: option.limitPrice,
    strike: option.strikePrice,
    expiry: option.expiryDate,
    right: strategyKey === "covered_call" ? "C" : "P",
  });

  const payload: OrderRequestPayload = { symbol: ticker.symbol, strategyKey, legs };

  if (sourceAlertId) {
    const alert = await db("trade_alerts").where({ id: sourceAlertId, status: "pending" }).first();
    if (!alert) {
      response.status(404).json({ error: "Pending trade alert not found for sourceAlertId." });
      return;
    }
    if (alert.ticker_id !== ticker.id || alert.strategy_key !== strategyKey) {
      response.status(400).json({ error: "sourceAlertId does not match this symbol/strategy." });
      return;
    }
  }

  const [orderRequest] = await db("order_requests")
    .insert({
      requested_by_user_id: request.session.userId,
      request_type: strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put",
      payload: JSON.stringify(payload),
      source_alert_id: sourceAlertId ?? null,
    })
    .returning("*");

  response.status(201).json(orderRequest);
});

positionsRouter.get("/orders", async (request, response) => {
  const status = request.query.status as string | undefined;
  const query = db("order_requests").orderBy("created_at", "desc");
  if (status) query.where({ status });
  response.json(await query);
});

positionsRouter.get("/orders/:id", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }
  response.json(orderRequest);
});

// The explicit confirmation gate (approved 2026-08-24) — building an order
// above never transmits it; only this endpoint does, by NOTIFYing the
// worker. Every order-placing UI flow (New Position, Roll, Close, and the
// Genosuke financial-write tools) must call this as a separate step after
// showing the user exactly what will be submitted.
positionsRouter.post("/orders/:id/confirm", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id, status: "pending_confirmation" }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "No pending order found with that id." });
    return;
  }

  await db.transaction(async (trx) => {
    await trx("order_requests").where({ id: orderRequest.id }).update({ status: "confirmed", updated_at: trx.fn.now() });

    if (orderRequest.source_alert_id) {
      // resulting_position_id for a brand-new position isn't known yet at
      // confirm time (the worker creates/matches it once IBKR actually
      // fills the order) — left null here for a new_trade alert. For a
      // roll, related_position_id is already the right answer since a roll
      // never creates a new position.
      await trx("trade_alerts")
        .where({ id: orderRequest.source_alert_id })
        .update({
          status: "approved",
          resulting_position_id: orderRequest.related_position_id ?? null,
          reviewed_by_user_id: request.session.userId,
          reviewed_at: trx.fn.now(),
        });
    }

    await trx.raw("SELECT pg_notify(?, ?)", [orderRequestsChannel, orderRequest.id]);
  });

  const updated = await db("order_requests").where({ id: orderRequest.id }).first();
  response.json(updated);
});

positionsRouter.post("/orders/:id/cancel", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }
  if (orderRequest.status !== "pending_confirmation" && orderRequest.status !== "confirmed") {
    response.status(409).json({
      error: "This order has already been submitted to IBKR — cancel it directly in TWS/IBKR for now.",
    });
    return;
  }

  const [updated] = await db("order_requests")
    .where({ id: orderRequest.id })
    .update({ status: "cancelled", updated_at: db.fn.now() })
    .returning("*");
  response.json(updated);
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

// Rolls one short option leg on an open position: builds an order_requests
// row (request_type "roll_leg") for a combo order — BUY back the existing
// leg, SELL the new one, as one atomic order — rather than writing
// position_legs/trades directly. Same idea as POST /orders above; only the
// worker writes those tables now, once IBKR actually fills the order.
positionsRouter.post("/:id/roll", async (request, response) => {
  const { sourceAlertId, closeLegId, closeLimitPrice, newLeg } = request.body as {
    sourceAlertId?: string;
    closeLegId?: string;
    closeLimitPrice?: number;
    newLeg?: { strikePrice: number; expiryDate: string; quantity: number; limitPrice: number };
  };

  if (!sourceAlertId) {
    response.status(400).json({ error: "sourceAlertId is required." });
    return;
  }
  if (!closeLegId || typeof closeLimitPrice !== "number" || closeLimitPrice < 0) {
    response.status(400).json({ error: "closeLegId and a non-negative closeLimitPrice are required." });
    return;
  }
  if (
    !newLeg ||
    typeof newLeg.strikePrice !== "number" ||
    newLeg.strikePrice <= 0 ||
    !newLeg.expiryDate ||
    typeof newLeg.quantity !== "number" ||
    newLeg.quantity <= 0 ||
    typeof newLeg.limitPrice !== "number" ||
    newLeg.limitPrice < 0
  ) {
    response.status(400).json({ error: "newLeg requires strikePrice, expiryDate, quantity, and limitPrice." });
    return;
  }

  const position = await db("positions").where({ id: request.params.id }).first();
  if (!position) {
    response.status(404).json({ error: "Position not found." });
    return;
  }
  if (position.status !== "open") {
    response.status(409).json({ error: "Position is already closed." });
    return;
  }

  const alert = await db("trade_alerts").where({ id: sourceAlertId, status: "pending" }).first();
  if (!alert) {
    response.status(404).json({ error: "Pending trade alert not found for sourceAlertId." });
    return;
  }
  if (alert.alert_type !== "roll") {
    response.status(400).json({ error: "sourceAlertId is not a roll alert." });
    return;
  }
  if (alert.related_position_id !== position.id) {
    response.status(400).json({ error: "sourceAlertId does not match this position." });
    return;
  }

  const closingLeg = await db("position_legs").where({ id: closeLegId, position_id: position.id }).first();
  if (!closingLeg) {
    response.status(404).json({ error: "Leg not found on this position." });
    return;
  }
  if (closingLeg.leg_type !== "option") {
    response.status(400).json({ error: "Only option legs can be rolled." });
    return;
  }
  if (closingLeg.exit_at) {
    response.status(409).json({ error: "Leg is already closed." });
    return;
  }

  // Same naked-coverage guard as POST /orders — a roll must not leave a
  // covered call under-covered either.
  if (position.strategy_key === "covered_call" && closingLeg.option_type === "call" && closingLeg.side === "short") {
    const openLegs = await db("position_legs").where({ position_id: position.id, exit_at: null });
    const stockShares = openLegs
      .filter((leg) => leg.leg_type === "stock" && leg.side === "long")
      .reduce((sum, leg) => sum + Number(leg.quantity), 0);
    const otherOpenShortCallShares = openLegs
      .filter((leg) => leg.id !== closingLeg.id && leg.leg_type === "option" && leg.option_type === "call" && leg.side === "short")
      .reduce((sum, leg) => sum + Number(leg.quantity) * Number(leg.multiplier), 0);
    const coverageError = validateCoveredCallCoverage(stockShares, otherOpenShortCallShares + newLeg.quantity * 100);
    if (coverageError) {
      response.status(400).json({ error: coverageError });
      return;
    }
  }

  const ticker = await db("tickers").where({ id: position.ticker_id }).first();
  // A roll always reopens the same side it closed — short call rolls to a
  // new short call, short put rolls to a new short put.
  const closeAction = closingLeg.side === "short" ? OrderAction.BUY : OrderAction.SELL;
  const openAction = closingLeg.side === "short" ? OrderAction.SELL : OrderAction.BUY;
  const right = closingLeg.option_type === "call" ? "C" : "P";

  const legs: OrderLegPayload[] = [
    {
      role: "option",
      action: closeAction,
      symbol: ticker.symbol,
      quantity: closingLeg.quantity,
      unitPrice: closeLimitPrice,
      strike: Number(closingLeg.strike_price),
      expiry: closingLeg.expiry_date,
      right,
      ibkrContractId: closingLeg.ibkr_contract_id ?? undefined,
      positionLegId: closingLeg.id,
    },
    {
      role: "option",
      action: openAction,
      symbol: ticker.symbol,
      quantity: newLeg.quantity,
      unitPrice: newLeg.limitPrice,
      strike: newLeg.strikePrice,
      expiry: newLeg.expiryDate,
      right,
    },
  ];
  const payload: OrderRequestPayload = { symbol: ticker.symbol, strategyKey: position.strategy_key, legs };

  const [orderRequest] = await db("order_requests")
    .insert({
      requested_by_user_id: request.session.userId,
      request_type: "roll_leg",
      payload: JSON.stringify(payload),
      related_position_id: position.id,
      source_alert_id: sourceAlertId,
    })
    .returning("*");

  response.status(201).json(orderRequest);
});

// Builds an order_requests row (request_type "close_position") for a combo
// order closing every currently-open leg at once — same "only the worker
// writes position_legs/trades" rule as everywhere else above. Every open
// leg needs a limit price (what you're willing to pay/receive to close it),
// same all-legs-at-once restriction as before (still no partial-quantity
// closes — see PROGRESS.md's open gap).
positionsRouter.post("/:id/close", async (request, response) => {
  const { legs } = request.body as { legs?: { legId: string; limitPrice: number }[] };

  if (!legs || legs.length === 0) {
    response.status(400).json({ error: "At least one leg is required." });
    return;
  }
  for (const leg of legs) {
    if (!leg.legId || typeof leg.limitPrice !== "number" || leg.limitPrice < 0) {
      response.status(400).json({ error: "Each leg requires legId and a non-negative limitPrice." });
      return;
    }
  }

  const position = await db("positions").where({ id: request.params.id }).first();
  if (!position) {
    response.status(404).json({ error: "Position not found." });
    return;
  }
  if (position.status !== "open") {
    response.status(409).json({ error: "Position is already closed." });
    return;
  }

  const existingLegs = await db("position_legs").where({ position_id: position.id, exit_at: null });
  const existingLegIds = new Set(existingLegs.map((leg) => leg.id));
  const providedLegIds = new Set(legs.map((leg) => leg.legId));
  const allLegsCovered = existingLegIds.size === providedLegIds.size && [...existingLegIds].every((id) => providedLegIds.has(id));
  if (!allLegsCovered) {
    response.status(400).json({ error: "All open legs of this position must be included when closing it." });
    return;
  }

  const ticker = await db("tickers").where({ id: position.ticker_id }).first();
  const limitPriceByLegId = new Map(legs.map((leg) => [leg.legId, leg.limitPrice]));

  const orderLegs: OrderLegPayload[] = existingLegs.map((leg) => ({
    role: leg.leg_type,
    action: leg.side === "long" ? OrderAction.SELL : OrderAction.BUY, // closing action is the inverse of how it was opened
    symbol: ticker.symbol,
    quantity: leg.quantity,
    unitPrice: limitPriceByLegId.get(leg.id)!,
    strike: leg.strike_price ? Number(leg.strike_price) : undefined,
    expiry: leg.expiry_date ?? undefined,
    right: leg.option_type === "call" ? "C" : leg.option_type === "put" ? "P" : undefined,
    ibkrContractId: leg.ibkr_contract_id ?? undefined,
    positionLegId: leg.id,
  }));
  const payload: OrderRequestPayload = { symbol: ticker.symbol, strategyKey: position.strategy_key, legs: orderLegs };

  const [orderRequest] = await db("order_requests")
    .insert({
      requested_by_user_id: request.session.userId,
      request_type: "close_position",
      payload: JSON.stringify(payload),
      related_position_id: position.id,
    })
    .returning("*");

  response.status(201).json(orderRequest);
});
