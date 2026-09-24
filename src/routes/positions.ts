import { fetchTradingBlockedReason } from "../lib/tradingGate.js";
import { Router, type Request, type Response } from "express";
import { OptionType, OrderAction } from "@stoqey/ib";
import { db } from "../db/connection.js";
import type { Knex } from "knex";
import { requireAuth } from "../middleware/requireAuth.js";
import { positionSelect, fetchAvailableUncoveredShares } from "../lib/positionQueries.js";
import { revertSourceAlertToPending } from "../lib/revertSourceAlertToPending.js";
import { publishNotification } from "../lib/notificationChannel.js";
import type { Greeks, GreeksContract } from "../ibkr/fetchLiveGreeks.js";
import { fetchGreeksPoolFirst } from "../ibkr/greeksPool.js";
import { streamPooledGreeks } from "../ibkr/greeksPool.js";
import { fetchCyclesForTickers } from "../lib/cycleQueries.js";
import { fetchBreakEvenByPositionId, type PositionBreakEven } from "../lib/cycleBreakEvenQueries.js";
import { getRiskFreeRate } from "../lib/riskFreeRate.js";
import { computeLegSuccessProbabilities, type SuccessProbabilityLeg } from "../lib/positionSuccessProbability.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { fetchPricesPoolFirst, streamPooledPrices, subscribeToPooledPrice } from "../ibkr/pricePool.js";
import type { PositionExposureRow } from "../lib/positionExposure.js";
import { respondWithStreamedResult } from "../lib/streamedResponse.js";
import { streamOrderLegQuote, checkDeltaCompliance } from "../ibkr/streamOrderLegQuote.js";
import type { OrderLegPayload, OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchEconomicCalendarWarningEvents, formatEconomicCalendarWarning } from "../ibkr/calendarConflict.js";
import { evaluateRollForPosition } from "../ibkr/evaluateRollForPosition.js";
import { evaluateRecoveryPathForPosition } from "../ibkr/evaluateRecoveryPathForPosition.js";
import { serializeAsyncCalls } from "../lib/serializeAsyncCalls.js";
import { recordUnrealizedPnlSample, recordLegDeltaSample } from "../lib/pulseChartSampleCollector.js";
import { evaluateSignalOrderLimits } from "../lib/signalOrderLimits.js";

export const positionsRouter = Router();
positionsRouter.use(requireAuth);

// v1 strategy scope — matches shortlist.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];
// Reading (not creating) also covers "unstructured": bare stock and anything
// fitting neither strategy is a real open holding (Genosuke filters by it).
const validListStrategyKeys = [...validStrategyKeys, "unstructured"];
const validStatuses = ["open", "closed"];
const orderRequestsChannel = "order_requests_channel";

// Knex's `.returning("*")`/`.first()` return the raw order_requests row
// (snake_case columns) — the frontend's OrderRequest type is camelCase, so
// every response site below must go through this rather than
// `response.json(row)` directly. Found 2026-08-25: every response site
// WAS returning the raw row, meaning order.errorMessage/requestType/
// ibkrOrderId/etc. have always been undefined on the frontend — most
// visibly, a real IBKR rejection's error message never actually displayed
// in OrderReviewPanel, it just silently wasn't there.
function serializeOrderRequest(row: Record<string, unknown>) {
  return {
    id: row.id,
    requestType: row.request_type,
    payload: row.payload,
    relatedPositionId: row.related_position_id,
    sourceAlertId: row.source_alert_id,
    status: row.status,
    ibkrOrderId: row.ibkr_order_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requestedByUserId: row.requested_by_user_id,
    requestedByDisplayName: row.requested_by_display_name,
    cancelledByUserId: row.cancelled_by_user_id,
    cancelledByDisplayName: row.cancelled_by_display_name,
  };
}

// Joins in the requester/canceller's display name (e.g. "Marce", "Genosuke")
// so the frontend never has to resolve a raw user id itself — see
// PROGRESS.md's user-attribution audit, 2026-08-28.
function orderRequestsWithNames() {
  return db("order_requests as orq")
    .leftJoin("users as ru", "ru.id", "orq.requested_by_user_id")
    .leftJoin("users as cu", "cu.id", "orq.cancelled_by_user_id")
    .select("orq.*", "ru.display_name as requested_by_display_name", "cu.display_name as cancelled_by_display_name");
}

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

// IBKR's minimum price variation is a penny for both US equities and
// equity options priced under $3 (nickels above that, but this codebase
// hasn't needed to special-case it yet). A combo/BAG order's net limit
// price is the sum of its legs' unitPrices (computeNetLimitPrice), so a
// leg with a stray third decimal (e.g. a $0.375 option premium) silently
// produces an invalid net price even when each leg looks fine on its own.
// Real bug found 2026-08-24: a DRAM buy-write was rejected with IBKR error
// 110 because the option leg's model-picked mid-price (0.375) pushed the
// combo's net price to 52.885.
function roundToCents(price: number): number {
  return Math.round(price * 100) / 100;
}

// Real bug found 2026-08-24: a manual AAOI order was submitted with
// expiryDate "2026-08-28" (dashes) instead of the "YYYYMMDD" the IBKR
// contract lookup requires — resolveLegContractIds silently failed to
// resolve the contract and the order died with a generic "could not
// resolve one or more contract ids" error, well after the human had
// already confirmed it. Normalize (strip separators) and validate up
// front so a malformed date is rejected immediately with a clear message.
function normalizeExpiryDate(raw: string): string | null {
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(digitsOnly) ? digitsOnly : null;
}

// realizedPnl/capitalAtRisk formulas approved 2026-08-21:
//   realizedPnl = sum over all exited legs of (exit - entry) * qty * multiplier
//     * (short ? -1 : 1) — same shape as the Trade Blotter's approved formula
//     (2026-08-20), aggregated per position. Includes a rolled-away leg's
//     locked-in gain even while the position is still open.
//   capitalAtRisk = entry-time capital committed, same definition as Trade
//     Alerts' approved capitalAtRisk (spot for covered calls, strike for
//     CSPs) but from entry actuals rather than a scan-time estimate. Keyed
//     on leg composition (open stock leg present?), not strategy_key, so a
//     bare-stock unstructured (N/S) position — e.g. leftover shares after a
//     covered call's short call expired/was assigned away — still gets a
//     real capitalAtRisk instead of null (fixed 2026-09-24).
// Shared with ibkrGatewayWorker.ts's post-close Telegram notification, so
// both agree on the same realizedPnl/capitalAtRisk numbers — see
// lib/positionQueries.ts.

positionsRouter.get("/", async (request, response) => {
  const status = (request.query.status as string | undefined) ?? "open";
  const strategyKey = request.query.strategy as string | undefined;
  const symbol = request.query.symbol as string | undefined;

  // "all" added 2026-08-31 for the consolidated ticker/position modal, which
  // needs both open positions (actionable) and closed ones (history) for a
  // symbol in one call rather than two requests to stitch together.
  if (!validStatuses.includes(status) && status !== "all") {
    response.status(400).json({ error: "status must be open, closed, or all." });
    return;
  }
  if (strategyKey && !validListStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategy." });
    return;
  }

  const conditions: string[] = [];
  const params: string[] = [];
  if (status !== "all") {
    conditions.push("p.status = ?");
    params.push(status);
  }
  if (strategyKey) {
    conditions.push("p.strategy_key = ?");
    params.push(strategyKey);
  }
  if (symbol) {
    conditions.push("t.symbol = ?");
    params.push(symbol.trim().toUpperCase());
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await db.raw(`${positionSelect} ${whereClause} ORDER BY p.opened_at DESC`, params);

  // Cycle break-even (approved 2026-09-19, see cycleBreakEven.ts) — open positions only. A failure here must
  // never take the whole list down: rows just come back without a break-even.
  const openRows = result.rows.filter((row: { status: string }) => row.status === "open");
  let breakEvenByPositionId = new Map<string, PositionBreakEven>();
  if (openRows.length > 0) {
    try {
      breakEvenByPositionId = await fetchBreakEvenByPositionId(openRows.map((row: { tickerId: string }) => row.tickerId));
    } catch (error) {
      console.error("positions: break-even computation failed, returning positions without it", error);
    }
  }
  response.json(
    result.rows.map((row: { id: string }) => {
      const breakEven = breakEvenByPositionId.get(row.id);
      return { ...row, breakEven: breakEven?.breakEven ?? null, breakEvenUnavailableReason: breakEven?.breakEvenUnavailableReason ?? null };
    }),
  );
});

// Wheel cycles (approved 2026-09-19, see cycles.ts): every cycle of one symbol, newest first — the Ticker Detail
// "Cycle" card. Registered before GET /:id so the wildcard doesn't swallow "cycles".
positionsRouter.get("/cycles", async (request, response) => {
  const symbol = String(request.query.symbol ?? "").trim().toUpperCase();
  if (!symbol) {
    response.status(400).json({ error: "symbol is required" });
    return;
  }
  const ticker = await db("tickers").where({ symbol }).first("id");
  if (!ticker) {
    response.json({ symbol, cycles: [] });
    return;
  }
  const [symbolCycles] = await fetchCyclesForTickers([ticker.id]);
  response.json({ symbol, cycles: [...(symbolCycles?.cycles ?? [])].reverse() });
});

// Fair strategy scoreboard (approved 2026-09-19): every cycle of every symbol attributed to the CSP / Unstructured /
// CC buckets. Cycles whose ledger can't be trusted (dataFlags) are left out of the totals and counted instead.
positionsRouter.get("/cycles/scoreboard", async (_request, response) => {
  const all = await fetchCyclesForTickers("all");
  const zero = () => ({ premium: 0, stock: 0, total: 0, capital: 0 });
  const buckets = { csp: zero(), unstructured: zero(), cc: zero() };
  let cyclesIncluded = 0;
  const excluded: { symbol: string; reason: string }[] = [];
  for (const { symbol, cycles } of all) {
    for (const cycle of cycles) {
      if (cycle.dataFlags.length > 0) {
        excluded.push({ symbol, reason: cycle.dataFlags[0]! });
        continue;
      }
      cyclesIncluded += 1;
      for (const key of ["csp", "unstructured", "cc"] as const) {
        buckets[key].premium += cycle.buckets[key].premium;
        buckets[key].stock += cycle.buckets[key].stock;
        buckets[key].total += cycle.buckets[key].total;
        buckets[key].capital += cycle.buckets[key].capital;
      }
    }
  }
  const withReturn = (bucket: ReturnType<typeof zero>) => ({ ...bucket, returnOnCapital: bucket.capital > 0 ? bucket.total / bucket.capital : null });
  response.json({
    buckets: { csp: withReturn(buckets.csp), unstructured: withReturn(buckets.unstructured), cc: withReturn(buckets.cc) },
    total: buckets.csp.total + buckets.unstructured.total + buckets.cc.total,
    cyclesIncluded,
    cyclesExcluded: excluded,
  });
});

// Set only when the greeks came from position_leg_greeks_snapshots instead
// of a live IBKR quote — see the fallback note below — the date that
// snapshot was captured, mirroring UnrealizedPnlResult.asOfDate.
export interface GreeksResult extends Greeks {
  asOfDate: string | null;
  // Streamed only (see positionSuccessProbability.ts); absent from GET /greeks.
  probabilityByDelta?: number | null;
  probabilityByD2?: number | null;
}

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

  // Same fix as /positions/pnl and /price-performance/current-prices
  // (2026-08-30): a total connection failure (Gateway unreachable) must
  // degrade to null greeks per contract, not 500 the whole route or leave
  // the frontend's per-leg "loading" spinner stuck forever waiting for a
  // key that will never arrive.
  let greeks: Record<string, Greeks> = {};
  try {
    greeks = await fetchGreeksPoolFirst(contracts);
  } catch (error) {
    console.error("positions/greeks: fetchLiveGreeks failed, returning null greeks for every contract", error);
  }

  // Same fallback shape as /positions/pnl (added 2026-09-08): a leg with no
  // live greeks (Gateway down, or up but never got a tickOptionComputation
  // for this contract — e.g. outside market hours, per fetchLiveGreeks's
  // placeholder-then-fill pattern) falls back to its most recent row in
  // position_leg_greeks_snapshots, written nightly by the daily P&L
  // snapshot job.
  function isLiveGreeksEmpty(value: Greeks | undefined): boolean {
    return !value || (value.delta === null && value.gamma === null && value.vega === null && value.theta === null);
  }
  const legIdsMissingLive = contracts.filter((contract) => isLiveGreeksEmpty(greeks[contract.key])).map((contract) => contract.key);
  const fallbackByLegId = new Map<string, { delta: string | null; gamma: string | null; vega: string | null; theta: string | null; snapshotDate: string }>();
  if (legIdsMissingLive.length > 0) {
    const latestSnapshotRows = await db.raw(
      `
      SELECT DISTINCT ON (position_leg_id)
        position_leg_id AS "positionLegId",
        delta,
        gamma,
        vega,
        theta,
        to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate"
      FROM position_leg_greeks_snapshots
      WHERE position_leg_id = ANY(?)
      ORDER BY position_leg_id, snapshot_date DESC
      `,
      [legIdsMissingLive],
    );
    for (const row of latestSnapshotRows.rows) {
      fallbackByLegId.set(row.positionLegId, row);
    }
  }

  const result: Record<string, GreeksResult> = {};
  for (const contract of contracts) {
    const live = greeks[contract.key];
    if (!isLiveGreeksEmpty(live)) {
      result[contract.key] = { ...live!, asOfDate: null };
      continue;
    }
    const fallback = fallbackByLegId.get(contract.key);
    result[contract.key] = fallback
      ? {
          delta: fallback.delta === null ? null : Number(fallback.delta),
          gamma: fallback.gamma === null ? null : Number(fallback.gamma),
          vega: fallback.vega === null ? null : Number(fallback.vega),
          theta: fallback.theta === null ? null : Number(fallback.theta),
          asOfDate: fallback.snapshotDate,
        }
      : { delta: null, gamma: null, vega: null, theta: null, asOfDate: null };
  }
  response.json(result);
});

// SSE live-upgrading sibling of GET /greeks (approved 2026-09-09 — see
// streamLiveGreeks.ts's header comment). Sends a FROZEN reading immediately
// as the first event (fast, not gated on live market activity), then keeps
// streaming and sends again every time the greeks genuinely change, until
// the client disconnects. Same leg-resolution query and
// position_leg_greeks_snapshots fallback as GET /greeks, applied once to
// the first (frozen) event only — a value already resolved from frozen/live
// data doesn't need re-checking against the nightly snapshot on every
// subsequent update.
export async function streamGreeksHandler(request: Request, response: Response): Promise<void> {
  const legIdsParam = request.query.legIds as string | undefined;
  const legIds = legIdsParam ? legIdsParam.split(",").filter(Boolean) : [];

  const rows = legIds.length
    ? await db("position_legs as pl")
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
          db.raw("to_char(pl.expiry_date, 'YYYY-MM-DD') as \"expiryIsoDate\""),
          "pl.side",
          db.raw(
            `(SELECT SUM(s.entry_price * s.quantity) / NULLIF(SUM(s.quantity), 0) FROM position_legs s
              WHERE s.position_id = pl.position_id AND s.leg_type = 'stock' AND s.exit_at IS NULL) AS "stockCostBasisPerShare"`,
          ),
          "t.symbol",
        )
    : [];

  const successLegByKey = new Map<string, SuccessProbabilityLeg>(
    rows.map((row) => [
      row.id,
      {
        side: row.side,
        optionType: row.optionType,
        strike: Number(row.strikePrice),
        expiryIsoDate: row.expiryIsoDate,
        stockCostBasisPerShare: row.stockCostBasisPerShare === null ? null : Number(row.stockCostBasisPerShare),
      },
    ]),
  );

  const contracts: GreeksContract[] = rows.map((row) => ({
    key: row.id,
    symbol: row.symbol,
    expiry: row.expiryDate,
    strike: Number(row.strikePrice),
    right: row.optionType === "call" ? OptionType.Call : OptionType.Put,
  }));

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  if (contracts.length === 0) {
    send({});
    clearInterval(heartbeat);
    response.end();
    return;
  }

  function isLiveGreeksEmpty(value: Greeks | undefined): boolean {
    return !value || (value.delta === null && value.gamma === null && value.vega === null && value.theta === null);
  }

  let isFirstEvent = true;

  // Holds whatever's the best-known result per leg so far (fallback or
  // live) — sent in full on every update, never regresses. Same bug class
  // and fix as /pnl/stream's lastGoodResult — see its comment for the full
  // reasoning (found live-testing 2026-09-09: a fallback-derived value
  // shown on the first event was getting overwritten by a still-incomplete
  // live computation on the next one).
  const lastGoodResult: Record<string, GreeksResult> = {};

  // Null when FRED has never succeeded — P(d2) then shows "—", never a
  // silently assumed 0% rate.
  const riskFreeRate = await getRiskFreeRate().catch(() => null);
  const sendWithProbabilities = () => {
    const enriched: Record<string, GreeksResult> = {};
    for (const [legId, result] of Object.entries(lastGoodResult)) {
      const leg = successLegByKey.get(legId);
      enriched[legId] = leg ? { ...result, ...computeLegSuccessProbabilities(leg, result, riskFreeRate) } : result;
    }
    send(enriched);
    for (const [legId, result] of Object.entries(enriched)) recordLegDeltaSample(legId, result.delta ?? null);
  };

  try {
    await streamPooledGreeks(
      contracts,
      serializeAsyncCalls(async (greeksByKey) => {
        if (!isFirstEvent) {
          for (const contract of contracts) {
            const live = greeksByKey[contract.key];
            if (isLiveGreeksEmpty(live)) continue; // keep whatever's already in lastGoodResult
            lastGoodResult[contract.key] = { ...live!, asOfDate: null };
          }
          sendWithProbabilities();
          return;
        }
        isFirstEvent = false;

        // Same position_leg_greeks_snapshots fallback as GET /greeks,
        // applied only to this first event.
        const legIdsMissingLive = contracts.filter((contract) => isLiveGreeksEmpty(greeksByKey[contract.key])).map((contract) => contract.key);
        const fallbackByLegId = new Map<string, { delta: string | null; gamma: string | null; vega: string | null; theta: string | null; snapshotDate: string }>();
        if (legIdsMissingLive.length > 0) {
          const latestSnapshotRows = await db.raw(
            `
            SELECT DISTINCT ON (position_leg_id)
              position_leg_id AS "positionLegId",
              delta,
              gamma,
              vega,
              theta,
              to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate"
            FROM position_leg_greeks_snapshots
            WHERE position_leg_id = ANY(?)
            ORDER BY position_leg_id, snapshot_date DESC
            `,
            [legIdsMissingLive],
          );
          for (const row of latestSnapshotRows.rows) fallbackByLegId.set(row.positionLegId, row);
        }

        for (const contract of contracts) {
          const live = greeksByKey[contract.key];
          if (!isLiveGreeksEmpty(live)) {
            lastGoodResult[contract.key] = { ...live!, asOfDate: null };
            continue;
          }
          const fallback = fallbackByLegId.get(contract.key);
          lastGoodResult[contract.key] = fallback
            ? {
                delta: fallback.delta === null ? null : Number(fallback.delta),
                gamma: fallback.gamma === null ? null : Number(fallback.gamma),
                vega: fallback.vega === null ? null : Number(fallback.vega),
                theta: fallback.theta === null ? null : Number(fallback.theta),
                asOfDate: fallback.snapshotDate,
              }
            : { delta: null, gamma: null, vega: null, theta: null, asOfDate: null };
        }
        sendWithProbabilities();
      }),
      abortController.signal,
    );
  } catch (error) {
    console.error("positions/greeks/stream: streamPooledGreeks failed", error);
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

positionsRouter.get("/greeks/stream", streamGreeksHandler);

export interface UnrealizedPnlResult {
  unrealizedPnl: number | null;
  // Premium P/L: sum of open option leg(s) only. Stock P/L: the open stock leg
  // only (covered calls only — always 0 for CSP, which has no stock leg).
  // Both null when unrealizedPnl itself is null (live pricing unavailable and
  // no snapshot), or when the position_pnl_snapshots fallback below is used
  // and predates the split being captured (added 2026-09-08).
  unrealizedPremiumPnl: number | null;
  unrealizedStockPnl: number | null;
  // Current market value of the open stock leg only (covered calls hold
  // shares; CSPs have no stock leg, so this is always 0 for them) — for
  // Iorio Pulse's "Total equity" (total value held in stocks) aggregate.
  // Unlike the PnL fields above, this has no position_pnl_snapshots
  // fallback (that table only stores PnL deltas, not market value), so it's
  // null whenever live pricing is unavailable, even if unrealizedPnl itself
  // fell back to a snapshot.
  stockMarketValue: number | null;
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
  // A total connection failure (Gateway unreachable) must fall through to
  // the position_pnl_snapshots fallback below, same as a per-contract null
  // price does -- not 500 the whole route. fetchLivePrices throws instead
  // of returning per-key nulls when connectToIbkrGateway itself can't
  // connect, so that failure mode has to be caught explicitly here.
  let pricesByLegId: Record<string, number | null> = {};
  try {
    pricesByLegId = await fetchPricesPoolFirst(priceContracts);
  } catch (error) {
    console.error("positions/pnl: fetchLivePrices failed, falling back to position_pnl_snapshots", error);
  }

  const unrealizedByPositionId: Record<string, number | null> = {};
  const premiumByPositionId: Record<string, number | null> = {};
  const stockByPositionId: Record<string, number | null> = {};
  const stockMarketValueByPositionId: Record<string, number | null> = {};
  for (const positionId of positionIds) {
    unrealizedByPositionId[positionId] = 0;
    premiumByPositionId[positionId] = 0;
    stockByPositionId[positionId] = 0;
    stockMarketValueByPositionId[positionId] = 0;
  }

  for (const leg of legRows) {
    if (unrealizedByPositionId[leg.positionId] === null) continue;
    const currentPrice = pricesByLegId[leg.id];
    if (currentPrice === null || currentPrice === undefined) {
      unrealizedByPositionId[leg.positionId] = null;
      premiumByPositionId[leg.positionId] = null;
      stockByPositionId[leg.positionId] = null;
      stockMarketValueByPositionId[leg.positionId] = null;
      continue;
    }
    const sign = leg.side === "short" ? -1 : 1;
    const entryPrice = Number(leg.entryPrice);
    const legPnl = (currentPrice - entryPrice) * leg.quantity * leg.multiplier * sign;
    unrealizedByPositionId[leg.positionId] = (unrealizedByPositionId[leg.positionId] ?? 0) + legPnl;
    if (leg.legType === "option") {
      premiumByPositionId[leg.positionId] = (premiumByPositionId[leg.positionId] ?? 0) + legPnl;
    } else {
      stockByPositionId[leg.positionId] = (stockByPositionId[leg.positionId] ?? 0) + legPnl;
      stockMarketValueByPositionId[leg.positionId] = (stockMarketValueByPositionId[leg.positionId] ?? 0) + currentPrice * leg.quantity;
    }
  }

  const positionIdsMissingLive = positionIds.filter((id) => unrealizedByPositionId[id] === null);
  const fallbackByPositionId = new Map<
    string,
    { unrealizedPnl: string; premiumPnl: string | null; stockPnl: string | null; snapshotDate: string }
  >();
  if (positionIdsMissingLive.length > 0) {
    const latestSnapshotRows = await db.raw(
      `
      SELECT DISTINCT ON (position_id)
        position_id AS "positionId",
        unrealized_pnl AS "unrealizedPnl",
        premium_pnl AS "premiumPnl",
        stock_pnl AS "stockPnl",
        to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate"
      FROM position_pnl_snapshots
      WHERE position_id = ANY(?)
      ORDER BY position_id, snapshot_date DESC
      `,
      [positionIdsMissingLive],
    );
    for (const row of latestSnapshotRows.rows) {
      fallbackByPositionId.set(row.positionId, {
        unrealizedPnl: row.unrealizedPnl,
        premiumPnl: row.premiumPnl,
        stockPnl: row.stockPnl,
        snapshotDate: row.snapshotDate,
      });
    }
  }

  const result: Record<string, UnrealizedPnlResult> = {};
  for (const positionId of positionIds) {
    const unrealizedPnl = unrealizedByPositionId[positionId] ?? null;
    if (unrealizedPnl !== null) {
      result[positionId] = {
        unrealizedPnl,
        unrealizedPremiumPnl: premiumByPositionId[positionId] ?? null,
        unrealizedStockPnl: stockByPositionId[positionId] ?? null,
        stockMarketValue: stockMarketValueByPositionId[positionId] ?? null,
        asOfDate: null,
      };
      continue;
    }
    const fallback = fallbackByPositionId.get(positionId);
    result[positionId] = fallback
      ? {
          unrealizedPnl: Number(fallback.unrealizedPnl),
          // Older snapshots (written before 2026-09-08) never captured this
          // split — null here just means "no split available for this
          // snapshot", same as the whole-position figure being unavailable.
          unrealizedPremiumPnl: fallback.premiumPnl === null ? null : Number(fallback.premiumPnl),
          unrealizedStockPnl: fallback.stockPnl === null ? null : Number(fallback.stockPnl),
          // position_pnl_snapshots stores PnL deltas only, never market value.
          stockMarketValue: null,
          asOfDate: fallback.snapshotDate,
        }
      : { unrealizedPnl: null, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: null };
  }

  response.json(result);
});

// SSE live-upgrading sibling of GET /pnl (approved 2026-09-09 — see
// streamLivePrices.ts's header comment). Sends a FROZEN reading immediately
// as the first event, then keeps streaming and recomputes/resends P&L every
// time a leg's price genuinely changes, until the client disconnects. Same
// leg-resolution query, P&L math, and position_pnl_snapshots fallback as GET
// /pnl, with the fallback applied once to the first (frozen) event only.
export async function streamPnlHandler(request: Request, response: Response): Promise<void> {
  const positionIdsParam = request.query.positionIds as string | undefined;
  const positionIds = positionIdsParam ? positionIdsParam.split(",").filter(Boolean) : [];

  const legRows = positionIds.length
    ? await db("position_legs as pl")
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
        )
    : [];

  const priceContracts: PriceContract[] = legRows.map((leg) => ({
    key: leg.id,
    legType: leg.legType,
    symbol: leg.symbol,
    expiry: leg.expiryDate ?? undefined,
    strike: leg.strikePrice ? Number(leg.strikePrice) : undefined,
    right: leg.optionType === "call" ? OptionType.Call : leg.optionType === "put" ? OptionType.Put : undefined,
  }));

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  if (positionIds.length === 0) {
    send({});
    clearInterval(heartbeat);
    response.end();
    return;
  }

  // Same P&L math as GET /pnl above, parameterized by whatever prices are
  // known so far — called on every streamLivePrices update, including the
  // frozen one.
  function computeUnrealized(pricesByLegId: Record<string, number | null>) {
    const unrealizedByPositionId: Record<string, number | null> = {};
    const premiumByPositionId: Record<string, number | null> = {};
    const stockByPositionId: Record<string, number | null> = {};
    const stockMarketValueByPositionId: Record<string, number | null> = {};
    for (const positionId of positionIds) {
      unrealizedByPositionId[positionId] = 0;
      premiumByPositionId[positionId] = 0;
      stockByPositionId[positionId] = 0;
      stockMarketValueByPositionId[positionId] = 0;
    }
    for (const leg of legRows) {
      if (unrealizedByPositionId[leg.positionId] === null) continue;
      const currentPrice = pricesByLegId[leg.id];
      if (currentPrice === null || currentPrice === undefined) {
        unrealizedByPositionId[leg.positionId] = null;
        premiumByPositionId[leg.positionId] = null;
        stockByPositionId[leg.positionId] = null;
        stockMarketValueByPositionId[leg.positionId] = null;
        continue;
      }
      const sign = leg.side === "short" ? -1 : 1;
      const entryPrice = Number(leg.entryPrice);
      const legPnl = (currentPrice - entryPrice) * leg.quantity * leg.multiplier * sign;
      unrealizedByPositionId[leg.positionId] = (unrealizedByPositionId[leg.positionId] ?? 0) + legPnl;
      if (leg.legType === "option") {
        premiumByPositionId[leg.positionId] = (premiumByPositionId[leg.positionId] ?? 0) + legPnl;
      } else {
        stockByPositionId[leg.positionId] = (stockByPositionId[leg.positionId] ?? 0) + legPnl;
        stockMarketValueByPositionId[leg.positionId] = (stockMarketValueByPositionId[leg.positionId] ?? 0) + currentPrice * leg.quantity;
      }
    }
    return { unrealizedByPositionId, premiumByPositionId, stockByPositionId, stockMarketValueByPositionId };
  }

  let isFirstEvent = true;

  // Holds whatever's the best-known result per position so far (fallback or
  // live) — sent in full on every update. Found 2026-09-09 live-testing:
  // the first event correctly applied the position_pnl_snapshots fallback
  // and showed a real (stale) number, but the very next live-price update
  // recomputed purely from live prices — which hadn't all arrived yet — and
  // overwrote that good fallback value with null. A position's entry here
  // only ever gets replaced by a NEW non-null result (fallback initially,
  // then whichever live computation first has every one of that position's
  // legs priced); it never regresses to null once something real is shown.
  const lastGoodResult: Record<string, UnrealizedPnlResult> = {};

  try {
    await streamPooledPrices(
      priceContracts,
      serializeAsyncCalls(async (pricesByLegId) => {
        const { unrealizedByPositionId, premiumByPositionId, stockByPositionId, stockMarketValueByPositionId } = computeUnrealized(pricesByLegId);

        if (!isFirstEvent) {
          for (const positionId of positionIds) {
            const unrealizedPnl = unrealizedByPositionId[positionId] ?? null;
            if (unrealizedPnl === null) continue; // keep whatever's already in lastGoodResult
            lastGoodResult[positionId] = {
              unrealizedPnl,
              unrealizedPremiumPnl: premiumByPositionId[positionId] ?? null,
              unrealizedStockPnl: stockByPositionId[positionId] ?? null,
              stockMarketValue: stockMarketValueByPositionId[positionId] ?? null,
              asOfDate: null,
            };
          }
          send(lastGoodResult);
          for (const [positionId, result] of Object.entries(lastGoodResult)) recordUnrealizedPnlSample(positionId, result.unrealizedPnl);
          return;
        }
        isFirstEvent = false;

        // Same position_pnl_snapshots fallback as GET /pnl, applied only to
        // this first event.
        const positionIdsMissingLive = positionIds.filter((id) => unrealizedByPositionId[id] === null);
        const fallbackByPositionId = new Map<string, { unrealizedPnl: string; premiumPnl: string | null; stockPnl: string | null; snapshotDate: string }>();
        if (positionIdsMissingLive.length > 0) {
          const latestSnapshotRows = await db.raw(
            `
            SELECT DISTINCT ON (position_id)
              position_id AS "positionId",
              unrealized_pnl AS "unrealizedPnl",
              premium_pnl AS "premiumPnl",
              stock_pnl AS "stockPnl",
              to_char(snapshot_date, 'YYYY-MM-DD') AS "snapshotDate"
            FROM position_pnl_snapshots
            WHERE position_id = ANY(?)
            ORDER BY position_id, snapshot_date DESC
            `,
            [positionIdsMissingLive],
          );
          for (const row of latestSnapshotRows.rows) {
            fallbackByPositionId.set(row.positionId, {
              unrealizedPnl: row.unrealizedPnl,
              premiumPnl: row.premiumPnl,
              stockPnl: row.stockPnl,
              snapshotDate: row.snapshotDate,
            });
          }
        }

        for (const positionId of positionIds) {
          const unrealizedPnl = unrealizedByPositionId[positionId] ?? null;
          if (unrealizedPnl !== null) {
            lastGoodResult[positionId] = {
              unrealizedPnl,
              unrealizedPremiumPnl: premiumByPositionId[positionId] ?? null,
              unrealizedStockPnl: stockByPositionId[positionId] ?? null,
              stockMarketValue: stockMarketValueByPositionId[positionId] ?? null,
              asOfDate: null,
            };
            continue;
          }
          const fallback = fallbackByPositionId.get(positionId);
          lastGoodResult[positionId] = fallback
            ? {
                unrealizedPnl: Number(fallback.unrealizedPnl),
                unrealizedPremiumPnl: fallback.premiumPnl === null ? null : Number(fallback.premiumPnl),
                unrealizedStockPnl: fallback.stockPnl === null ? null : Number(fallback.stockPnl),
                stockMarketValue: null,
                asOfDate: fallback.snapshotDate,
              }
            : { unrealizedPnl: null, unrealizedPremiumPnl: null, unrealizedStockPnl: null, stockMarketValue: null, asOfDate: null };
        }
        send(lastGoodResult);
        for (const [positionId, result] of Object.entries(lastGoodResult)) recordUnrealizedPnlSample(positionId, result.unrealizedPnl);
      }),
      abortController.signal,
    );
  } catch (error) {
    console.error("positions/pnl/stream: streamPooledPrices failed", error);
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

positionsRouter.get("/pnl/stream", streamPnlHandler);

// Backfills Pulse's two charts (approved 2026-09-23) from
// pulseChartSampleCollector.ts's rolling 8h buffer, for continuity across a
// refresh or a brief live-stream outage. Only open positions — matches what
// the live streams above would show; the frontend applies the same
// CC/CSP-only filter to the delta series it already applies live.
positionsRouter.get("/pulse-chart-history", async (_request, response) => {
  const [pnlRows, deltaRows] = await Promise.all([
    db("pulse_unrealized_pnl_samples as s")
      .join("positions as p", "p.id", "s.position_id")
      .where("p.status", "open")
      .groupBy("s.sampled_at")
      .orderBy("s.sampled_at", "asc")
      .select("s.sampled_at as sampledAt", db.raw("SUM(COALESCE(s.unrealized_pnl, 0)) as \"totalUnrealizedPnl\"")),
    db("pulse_leg_delta_samples as s")
      .join("position_legs as pl", "pl.id", "s.position_leg_id")
      .join("positions as p", "p.id", "pl.position_id")
      .where("p.status", "open")
      .whereNotNull("s.leg_delta")
      .orderBy("s.sampled_at", "asc")
      .select("pl.position_id as positionId", "s.sampled_at as sampledAt", "s.leg_delta as legDelta"),
  ]);

  const deltaSamplesByPositionId: Record<string, { sampledAtMs: number; delta: number }[]> = {};
  for (const row of deltaRows) {
    (deltaSamplesByPositionId[row.positionId] ??= []).push({ sampledAtMs: new Date(row.sampledAt).getTime(), delta: Number(row.legDelta) });
  }

  response.json({
    pnlSamples: pnlRows.map((row) => ({ sampledAtMs: new Date(row.sampledAt).getTime(), totalUnrealizedPnl: Number(row.totalUnrealizedPnl) })),
    deltaSamplesByPositionId,
  });
});

// --- Order placement (approved 2026-08-24 — see the plan doc) ---
// The web dyno never writes positions/position_legs/trades directly for a
// new/closed/rolled leg anymore. It only ever builds an order_requests row
// and, on confirm, NOTIFYs the worker (src/ibkrGatewayWorker.ts) to actually place the
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

// Shared by the confirm-step hard gate and the order's live quote-stream
// compliance check below -- only ever runs for an order that actually came
// from the Signals order-setup flow (signal_snapshot is only ever set
// there), never for a Trade Alerts order, which has its own separate,
// still-unenforced copy of these same-named settings (see PROGRESS.md).
async function evaluateSignalOrderLimitsForOrderRequest(
  orderRequest: { signal_snapshot: unknown; payload: OrderRequestPayload; request_type: string },
  live: { exposures?: PositionExposureRow[]; spotPrice?: number } = {},
): Promise<{ blocked: boolean; reasons: string[] } | null> {
  if (orderRequest.signal_snapshot === null || orderRequest.signal_snapshot === undefined) return null;
  const requestType = orderRequest.request_type as string;
  const isRoll = requestType === "roll_leg";
  if (!requestType.startsWith("open_") && !isRoll) return null;
  const payload = orderRequest.payload;
  if (payload.strategyKey !== "covered_call" && payload.strategyKey !== "cash_secured_put") return null;
  // A Signals roll (Roll Signals, 2026-09-24) is one combo with two option legs: the close leg carries
  // positionLegId, the open leg does not. Only the strike difference adds notional (signalOrderLimits.ts).
  const optionLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && !leg.positionLegId) : payload.legs.find((leg) => leg.role === "option");
  const closeLeg = isRoll ? payload.legs.find((leg) => leg.role === "option" && leg.positionLegId) : undefined;
  if (!optionLeg || !optionLeg.strike || (isRoll && !closeLeg?.strike)) return null;
  const ticker = await requireExistingTicker(payload.symbol);
  if (!ticker) return null;
  return evaluateSignalOrderLimits({
    strategyKey: payload.strategyKey,
    symbol: ticker.symbol,
    tickerId: ticker.id,
    quantity: optionLeg.quantity,
    strike: optionLeg.strike,
    spotPrice: live.spotPrice,
    exposures: live.exposures,
    rollFromStrike: closeLeg?.strike,
  });
}

interface OpenOrderRequestBody {
  symbol?: string;
  strategyKey?: string;
  stock?: { quantity: number; limitPrice: number };
  option?: { quantity: number; limitPrice: number; strikePrice: number; expiryDate: string };
  sourceAlertId?: string;
  /** Signals modal only: the scores at the moment the order was built (stored as-is in order_requests.signal_snapshot). */
  signalSnapshot?: unknown;
}

// A snapshot is a plain object of modest size; the shape itself is the app's (SignalOrderSnapshot) and is not re-validated here.
const maximumSignalSnapshotBytes = 16_384;
function readSignalSnapshot(raw: unknown): { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "signalSnapshot must be an object." };
  if (JSON.stringify(raw).length > maximumSignalSnapshotBytes) return { ok: false, error: "signalSnapshot is too large." };
  return { ok: true, value: raw as Record<string, unknown> };
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
  if (typeof option.limitPrice !== "number" || !(option.limitPrice > 0)) {
    response.status(400).json({ error: "option.limitPrice must be a positive number — a short option is never sold for $0." });
    return;
  }
  if (typeof option.strikePrice !== "number" || option.strikePrice <= 0 || !option.expiryDate) {
    response.status(400).json({ error: "option.strikePrice and option.expiryDate are required." });
    return;
  }
  const normalizedExpiry = normalizeExpiryDate(option.expiryDate);
  if (!normalizedExpiry) {
    response.status(400).json({ error: `option.expiryDate must be a YYYYMMDD date, got "${option.expiryDate}".` });
    return;
  }
  // Only covered_call ever uses a stock leg (see comment below) — a stock
  // object sent alongside cash_secured_put is ignored rather than validated,
  // so a caller that includes a zeroed-out/placeholder stock leg for a
  // strategy that doesn't need one isn't rejected for it.
  if (strategyKey === "covered_call" && stock !== undefined) {
    if (typeof stock.quantity !== "number" || stock.quantity <= 0) {
      response.status(400).json({ error: "stock.quantity must be a positive number when stock is provided." });
      return;
    }
    if (typeof stock.limitPrice !== "number" || stock.limitPrice < 0) {
      response.status(400).json({ error: "stock.limitPrice must be a non-negative number." });
      return;
    }
  }

  const ticker = await requireExistingTicker(symbol);
  if (!ticker) {
    response.status(400).json({ error: "Unknown symbol — add it via the Shortlist first." });
    return;
  }

  // A covered call's stock leg is a standard 100-shares-per-contract
  // buy-write unless the caller explicitly overrides it (e.g. deliberate
  // over-coverage or a specific stock limit) — approved 2026-08-24 so
  // Genosuke stops asking "how many shares?" for the common case. Only
  // covered_call needs a stock leg at all; cash_secured_put never does.
  //
  // Auto-fill nets against shares already sitting uncovered on this symbol
  // (e.g. leftover stock from a covered call whose short call expired
  // worthless, or a cash-secured put assignment) rather than always buying a
  // fresh full lot — approved 2026-08-31, see PROGRESS.md's "re-write a
  // covered call after non-assignment" note. Only the auto-fill path nets;
  // an explicit `stock` override is used exactly as given (unchanged from
  // 2026-08-24 — the whole point of an override is caller-controlled
  // quantity, e.g. deliberate over-coverage).
  let resolvedStock = stock;
  let excessUncoveredShares = 0;
  if (strategyKey === "covered_call" && !resolvedStock) {
    const requiredShares = option.quantity * 100;
    // Shares already committed by in-flight covered-call orders on this
    // symbol (2026-09-24) — two builds could otherwise both skip the stock
    // leg against the same uncovered shares and leave the second call naked.
    const availableUncovered = Math.max(0, (await fetchAvailableUncoveredShares(ticker.id)) - (await sharesCommittedByInFlightCoveredCalls(ticker.symbol)));
    const shortfall = Math.max(0, requiredShares - availableUncovered);
    excessUncoveredShares = Math.max(0, availableUncovered - requiredShares);

    if (shortfall > 0) {
      const livePrices = await fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol: ticker.symbol }]);
      const price = livePrices["stock"];
      if (price === null || price === undefined) {
        response.status(400).json({
          error: "Could not fetch a live stock price to auto-fill the stock leg (markets may be closed) — pass stock.quantity/stock.limitPrice explicitly.",
        });
        return;
      }
      resolvedStock = { quantity: shortfall, limitPrice: roundToCents(price) };
    }
    // else: already-held uncovered shares fully cover this contract count — no stock leg needed at all.
  }

  if (strategyKey === "covered_call" && stock) {
    // Explicit-override path only — auto-fill above is correct by
    // construction (shortfall is exactly requiredShares - availableUncovered).
    const coverageError = validateCoveredCallCoverage(resolvedStock!.quantity, option.quantity * 100);
    if (coverageError) {
      response.status(400).json({ error: coverageError });
      return;
    }
  }

  const legs: OrderLegPayload[] = [];
  if (strategyKey === "covered_call" && resolvedStock) {
    legs.push({
      role: "stock",
      action: OrderAction.BUY,
      symbol: ticker.symbol,
      quantity: resolvedStock.quantity,
      unitPrice: roundToCents(resolvedStock.limitPrice),
    });
  }
  legs.push({
    role: "option",
    action: OrderAction.SELL,
    symbol: ticker.symbol,
    quantity: option.quantity,
    unitPrice: roundToCents(option.limitPrice),
    strike: option.strikePrice,
    expiry: normalizedExpiry,
    right: strategyKey === "covered_call" ? "C" : "P",
  });

  const payload: OrderRequestPayload = { symbol: ticker.symbol, strategyKey, legs };

  if (sourceAlertId) {
    const alert = await db("trade_alerts").where({ id: sourceAlertId, status: "pending" }).first();
    if (!alert) {
      response.status(404).json({ error: "Pending trade alert not found for sourceAlertId." });
      return;
    }
    const conflict = await findActiveOrderConflict(db, { sourceAlertId });
    if (conflict) {
      response.status(409).json({ error: describeActiveOrderConflict(conflict) });
      return;
    }
    if (alert.ticker_id !== ticker.id || alert.strategy_key !== strategyKey) {
      response.status(400).json({ error: "sourceAlertId does not match this symbol/strategy." });
      return;
    }
  }

  const signalSnapshot = readSignalSnapshot((request.body as OpenOrderRequestBody).signalSnapshot);
  if (!signalSnapshot.ok) {
    response.status(400).json({ error: signalSnapshot.error });
    return;
  }

  const [orderRequest] = await db("order_requests")
    .insert({
      requested_by_user_id: request.session.userId,
      request_type: strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put",
      payload: JSON.stringify(payload),
      // sourceAlertId can arrive as "" (e.g. Genosuke's manual-entry path,
      // not omitted) rather than undefined — ?? only catches null/undefined,
      // and an empty string fails Postgres's uuid parser outright.
      source_alert_id: sourceAlertId || null,
      signal_snapshot: signalSnapshot.value === null ? null : JSON.stringify(signalSnapshot.value),
    })
    .returning("*");

  await publishNotification({ type: "order_status", orderId: orderRequest.id });
  const note =
    excessUncoveredShares > 0
      ? `${excessUncoveredShares} uncovered share(s) of ${ticker.symbol} remain beyond what this order uses — worth checking whether an additional contract is worth selling.`
      : null;
  const [calendarWarning, riskFreeRate] = await Promise.all([
    fetchEconomicCalendarWarningEvents(normalizedExpiry).then(formatEconomicCalendarWarning),
    getRiskFreeRate().catch(() => null), // Order Review's probability of profit uses the same FRED rate as the alerts (approved 2026-09-24)
  ]);
  response.status(201).json({ ...serializeOrderRequest(orderRequest), note, calendarWarning, riskFreeRate });
});

positionsRouter.get("/orders", async (request, response) => {
  const status = request.query.status as string | undefined;
  const query = orderRequestsWithNames().orderBy("orq.created_at", "desc");
  if (status) query.where({ status });
  response.json((await query).map(serializeOrderRequest));
});

positionsRouter.get("/orders/:id", async (request, response) => {
  const orderRequest = await orderRequestsWithNames().where("orq.id", request.params.id).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }
  response.json(serializeOrderRequest(orderRequest));
});

// Order Review panel's live bid/ask/IV/Greeks (streaming since 2026-08-27,
// replacing a one-shot fetch -- see PROGRESS.md and streamOrderLegQuote.ts).
// Breakeven/max-gain/max-loss/capital-at-risk are pure math on the order's
// own proposed entry price/strike (no live data needed for those), so
// they're computed client-side instead -- this endpoint only covers the data
// that actually requires a live IBKR round-trip. For an opening order, each
// pushed quote also carries a live delta-vs-strategy-band compliance verdict
// so the frontend can gate "Confirm & Submit to IBKR" the moment a trade
// drifts out of the strategy's screening criteria. Same SSE shape as
// tickerDetail.ts's streams: headers + send() + heartbeat + finally cleanup,
// aborted the moment the client disconnects.
positionsRouter.get("/orders/:id/quote/stream", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }

  const payload = orderRequest.payload as OrderRequestPayload;
  const optionLeg = payload.legs.find((leg) => leg.role === "option");
  if (!optionLeg || !optionLeg.strike || !optionLeg.expiry || !optionLeg.right) {
    response.status(400).json({ error: "This order has no option leg to quote." });
    return;
  }

  const isOpeningOrder = Boolean(payload.strategyKey) && (orderRequest.request_type as string).startsWith("open_");
  const strategySettings = isOpeningOrder
    ? await db("strategy_settings").where({ strategy_key: payload.strategyKey }).first()
    : null;

  // Re-evaluated periodically, not on every quote tick -- 10s keeps the
  // Order Review panel's block/unblock verdict close to live without
  // hammering the account summary on every sub-second option quote. Only
  // ever set for a Signals order (see evaluateSignalOrderLimitsForOrderRequest);
  // null otherwise. The re-evaluations are fed from the market-data pool
  // (2026-09-24): every open leg and the order's underlying are pooled for
  // this stream's lifetime below, so no re-evaluation opens IBKR snapshots.
  const signalLimitsRefreshIntervalMs = 10_000;
  let latestSignalLimits = await evaluateSignalOrderLimitsForOrderRequest(orderRequest);

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  // Re-checks read exposures through computePositionExposures (pool first,
  // snapshot only for unpooled legs) rather than subscribing every open leg
  // for the panel's lifetime (2026-09-24). Only the order's underlying is
  // pooled here, for the covered-call shortfall notional.
  let latestSpotPrice: number | undefined;
  const signalLimitsTimer = latestSignalLimits
    ? setInterval(() => {
        evaluateSignalOrderLimitsForOrderRequest(orderRequest, { spotPrice: latestSpotPrice })
          .then((result) => {
            latestSignalLimits = result;
          })
          .catch((error) => console.error(`orders/${orderRequest.id}/quote/stream: signal limits refresh failed`, error));
      }, signalLimitsRefreshIntervalMs)
    : null;
  if (signalLimitsTimer) {
    abortController.signal.addEventListener("abort", () => clearInterval(signalLimitsTimer), { once: true });
    subscribeToPooledPrice({ key: "stock", legType: "stock", symbol: payload.symbol }, (price) => {
      if (price !== null) latestSpotPrice = price;
    })
      .then((unsubscribe) => abortController.signal.addEventListener("abort", unsubscribe, { once: true }))
      .catch((error) => console.error(`orders/${orderRequest.id}/quote/stream: spot subscription failed`, error));
  }

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  try {
    await streamOrderLegQuote(
      payload.symbol,
      optionLeg.expiry,
      optionLeg.strike,
      optionLeg.right === "C" ? OptionType.Call : OptionType.Put,
      (quote) => {
        const compliance = isOpeningOrder
          ? checkDeltaCompliance(
              quote.delta,
              strategySettings?.delta_target_min !== undefined && strategySettings?.delta_target_min !== null
                ? Number(strategySettings.delta_target_min)
                : null,
              strategySettings?.delta_target_max !== undefined && strategySettings?.delta_target_max !== null
                ? Number(strategySettings.delta_target_max)
                : null,
            )
          : null;
        send({ type: "quote", data: { ...quote, compliance, signalLimits: latestSignalLimits } });
      },
      abortController.signal,
    );
    send({ type: "done" });
  } catch (error) {
    send({ type: "streamError", message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    if (signalLimitsTimer) clearInterval(signalLimitsTimer);
    response.end();
  }
});

// Generic live quote stream for a single option contract, not tied to any
// order_requests row — used by RollPositionModal (added 2026-08-27), which
// needs live pricing for both the closing leg and the replacement leg
// *before* a roll order is ever built (buildRollOrder only runs once the
// user submits). streamOrderLegQuote itself already takes symbol/expiry/
// strike/right directly with no order dependency, so this is a thin route
// wrapper, not new IBKR logic. Never compliance-gated (same as a Close/Roll
// order's quote block on the order-scoped stream above) — rolling isn't
// subject to the opening-order delta-band check.
positionsRouter.get("/quote/stream", async (request, response) => {
  const symbol = request.query.symbol as string | undefined;
  const expiry = request.query.expiry as string | undefined;
  const strikeRaw = request.query.strike as string | undefined;
  const rightRaw = request.query.right as string | undefined;
  const strike = strikeRaw !== undefined ? Number(strikeRaw) : NaN;

  if (!symbol || !expiry || !strikeRaw || Number.isNaN(strike) || (rightRaw !== "C" && rightRaw !== "P")) {
    response.status(400).json({ error: "symbol, expiry, strike, and right (C or P) are all required." });
    return;
  }

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  try {
    await streamOrderLegQuote(
      symbol,
      expiry,
      strike,
      rightRaw === "C" ? OptionType.Call : OptionType.Put,
      (quote) => send({ type: "quote", data: { ...quote, compliance: null } }),
      abortController.signal,
    );
    send({ type: "done" });
  } catch (error) {
    send({ type: "streamError", message: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
});

// The explicit confirmation gate (approved 2026-08-24) — building an order
// above never transmits it; only this endpoint does, by NOTIFYing the
// worker. Every order-placing UI flow (New Position, Roll, Close, and the
// Genosuke financial-write tools) must call this as a separate step after
// showing the user exactly what will be submitted.
const adaptivePriorities = new Set(["Urgent", "Normal", "Patient"]);

// Approved 2026-09-24: a built order must be confirmed within this long.
export const pendingConfirmationMaxAgeMs = 15 * 60 * 1000;

// Statuses that mean an order is still on its way to, or working at, IBKR.
const activeOrderStatuses = ["pending_confirmation", "confirmed", "submitted", "partially_filled", "cancel_requested"] as const;

interface ActiveOrderConflict {
  orderId: string;
  status: string;
  requestType: string;
  symbol: string;
}

class ActiveOrderConflictError extends Error {
  constructor(public readonly conflict: ActiveOrderConflict) {
    super(describeActiveOrderConflict(conflict));
    this.name = "ActiveOrderConflictError";
  }
}

function describeActiveOrderConflict(conflict: ActiveOrderConflict): string {
  return `An order for this ${conflict.requestType.startsWith("open_") ? "alert" : "position"} is already in progress (${conflict.symbol}, ${conflict.status.replaceAll("_", " ")}) — cancel it first or wait for it to finish.`;
}

/**
 * The first still-active order_requests row that references the same
 * position (close/roll) or the same source alert (open) — or, for a close
 * or roll, any of the same position_legs (2026-09-24). Two working orders on
 * one position can sell the stock twice or buy the call back twice.
 */
async function findActiveOrderConflict(
  executor: Knex | Knex.Transaction,
  target: { excludeOrderId?: string; positionId?: string | null; sourceAlertId?: string | null; payload?: OrderRequestPayload },
): Promise<ActiveOrderConflict | null> {
  if (!target.positionId && !target.sourceAlertId) return null;
  const rows: { id: string; status: string; request_type: string; payload: OrderRequestPayload }[] = await executor("order_requests")
    .whereIn("status", [...activeOrderStatuses])
    .andWhere((builder) => {
      if (target.positionId) builder.orWhere({ related_position_id: target.positionId });
      if (target.sourceAlertId) builder.orWhere({ source_alert_id: target.sourceAlertId });
    })
    .modify((builder) => {
      if (target.excludeOrderId) builder.whereNot({ id: target.excludeOrderId });
    })
    .select("id", "status", "request_type", "payload");
  const first = rows[0];
  return first ? { orderId: first.id, status: first.status, requestType: first.request_type, symbol: first.payload.symbol } : null;
}

/** Shares that in-flight covered-call open orders on this symbol are already writing against without buying (option contracts × 100 minus their stock leg). */
async function sharesCommittedByInFlightCoveredCalls(symbol: string): Promise<number> {
  const rows: { payload: OrderRequestPayload }[] = await db("order_requests")
    .whereIn("status", [...activeOrderStatuses])
    .where("request_type", "like", "open_%")
    .whereRaw("payload->>'symbol' = ?", [symbol])
    .whereRaw("payload->>'strategyKey' = ?", ["covered_call"])
    .select("payload");
  let committed = 0;
  for (const { payload } of rows) {
    const optionContracts = payload.legs.filter((leg) => leg.role === "option").reduce((sum, leg) => sum + leg.quantity, 0);
    const stockShares = payload.legs.filter((leg) => leg.role === "stock").reduce((sum, leg) => sum + leg.quantity, 0);
    committed += Math.max(0, optionContracts * 100 - stockShares);
  }
  return committed;
}

positionsRouter.post("/orders/:id/confirm", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }

  // Adaptive priority is picked on the Order Review screen, at confirm time
  // — not at order-build time — so the same picker works for every order
  // type (open/close/roll) without threading it through three separate
  // build endpoints. Undefined/omitted leaves the payload as built, which
  // ibkrGatewayWorker.ts's buildOrder() already defaults to "Normal".
  const requestedPriority = request.body?.adaptivePriority;
  if (requestedPriority !== undefined && !adaptivePriorities.has(requestedPriority)) {
    response.status(400).json({ error: "adaptivePriority must be Urgent, Normal, or Patient." });
    return;
  }

  // Idempotency guard: if this row already moved past pending_confirmation —
  // either because an earlier call to this same endpoint committed but its
  // HTTP response never made it back to the client (e.g. the web dyno
  // restarted between the transaction commit and response.json below), or
  // because a second near-simultaneous call already won the race just below
  // — return the order's current state instead of erroring. Without this, a
  // client retry after a dropped response looks like "the confirm failed"
  // and can lead the user to build and confirm a second, duplicate order for
  // the same intent, when the first one is actually already on its way to
  // (or already at) IBKR.
  if (orderRequest.status !== "pending_confirmation") {
    const updated = await orderRequestsWithNames().where("orq.id", orderRequest.id).first();
    response.json(serializeOrderRequest(updated));
    return;
  }

  // A limit price built more than pendingConfirmationMaxAgeMs ago is stale
  // (approved 2026-09-24, 15 min): refuse, and the sweep in
  // stalePendingOrders.ts cancels such rows on its own.
  if (Date.now() - new Date(orderRequest.created_at).getTime() > pendingConfirmationMaxAgeMs) {
    response.status(409).json({ error: "This order was built more than 15 minutes ago — its limit prices are stale. Build it again at current prices." });
    return;
  }

  // Fail-closed account binding (Phase B WP2): no order is confirmed unless the trading worker recently
  // reported that it is bound to this environment's IBKR account. The order stays pending_confirmation.
  const tradingBlockedReason = await fetchTradingBlockedReason();
  if (tradingBlockedReason) {
    response.status(409).json({ error: tradingBlockedReason });
    return;
  }

  const signalLimits = await evaluateSignalOrderLimitsForOrderRequest(orderRequest);
  if (signalLimits?.blocked) {
    response.status(409).json({ error: signalLimits.reasons.join(" ") });
    return;
  }

  let wonRace: boolean;
  try {
    wonRace = await runConfirmTransaction();
  } catch (error) {
    if (error instanceof ActiveOrderConflictError) {
      response.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }

  const updated = await orderRequestsWithNames().where("orq.id", orderRequest.id).first();
  if (wonRace) await publishNotification({ type: "order_status", orderId: orderRequest.id });
  response.json(serializeOrderRequest(updated));

  function runConfirmTransaction(): Promise<boolean> {
  return db.transaction(async (trx) => {
    // Re-checked inside the transaction (2026-09-24): building already
    // refuses a second order for a position or alert with one in flight,
    // but two rows built before either was confirmed could both confirm.
    const conflict = await findActiveOrderConflict(trx, { excludeOrderId: orderRequest.id, positionId: orderRequest.related_position_id, sourceAlertId: orderRequest.source_alert_id, payload: orderRequest.payload });
    if (conflict) throw new ActiveOrderConflictError(conflict);
    const payload = requestedPriority ? { ...orderRequest.payload, adaptivePriority: requestedPriority } : orderRequest.payload;
    // Conditioned on status still being pending_confirmation, and read back
    // via .returning, so two near-simultaneous confirm calls for the same
    // order can't both fall through to the NOTIFY below — only the one that
    // actually flips the row does.
    const updatedRows = await trx("order_requests")
      .where({ id: orderRequest.id, status: "pending_confirmation" })
      .update({ status: "confirmed", payload, updated_at: trx.fn.now() })
      .returning(["id"]);
    if (updatedRows.length === 0) return false;

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
    return true;
  });
  }
});

positionsRouter.post("/orders/:id/cancel", async (request, response) => {
  const orderRequest = await db("order_requests").where({ id: request.params.id }).first();
  if (!orderRequest) {
    response.status(404).json({ error: "Order not found." });
    return;
  }

  if (orderRequest.status === "pending_confirmation" || orderRequest.status === "confirmed") {
    // Never reached IBKR — a pure local status flip, but CONDITIONED on the
    // status we read (2026-09-24): the worker may be turning "confirmed" into
    // "submitted" this very moment, and an unconditional update here left an
    // order live at IBKR while the app said "cancelled". Zero rows changed
    // means the worker won; fall through and treat it as already submitted.
    const flipped = await db("order_requests")
      .where({ id: orderRequest.id, status: orderRequest.status })
      .update({ status: "cancelled", updated_at: db.fn.now(), cancelled_by_user_id: request.session.userId })
      .returning("id");
    if (flipped.length > 0) {
      const updated = await orderRequestsWithNames().where("orq.id", orderRequest.id).first();
      await revertSourceAlertToPending(orderRequest.source_alert_id);
      await publishNotification({ type: "order_status", orderId: orderRequest.id });
      response.json(serializeOrderRequest(updated));
      return;
    }
    orderRequest.status = (await db("order_requests").where({ id: orderRequest.id }).first())?.status ?? orderRequest.status;
  }

  if (orderRequest.status === "submitted" || orderRequest.status === "partially_filled") {
    // Already at IBKR — the worker (the only process holding the IBKR
    // connection) has to call ib.cancelOrder() itself. This flips to a
    // transient status and NOTIFYs the worker; the existing orderStatus
    // listener flips it to "cancelled" once IBKR confirms, same as every
    // other terminal status. The frontend already polls GET
    // /positions/orders/:id until a terminal status, so this responds
    // immediately with the transient row rather than waiting.
    // Not reverting the linked alert here yet — the order hasn't actually
    // been cancelled at IBKR at this point (only requested), and it could
    // still fill before IBKR processes the cancel. Reverted from the
    // worker's orderStatus listener instead, once IBKR confirms the terminal
    // "cancelled" status — see revertSourceAlertToPending's doc comment.
    await db("order_requests")
      .where({ id: orderRequest.id })
      .update({ status: "cancel_requested", updated_at: db.fn.now(), cancelled_by_user_id: request.session.userId });
    const updated = await orderRequestsWithNames().where("orq.id", orderRequest.id).first();
    await db.raw("SELECT pg_notify(?, ?)", [orderRequestsChannel, orderRequest.id]);
    await publishNotification({ type: "order_status", orderId: orderRequest.id });
    response.json(serializeOrderRequest(updated));
    return;
  }

  response.status(409).json({
    error:
      orderRequest.status === "cancel_requested"
        ? "Cancellation already requested for this order."
        : "This order has already reached a final status and can't be cancelled.",
  });
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

// Rolls one short option leg on an open position: builds an order_requests
// row (request_type "roll_leg") for a combo order — BUY back the existing
// leg, SELL the new one, as one atomic order — rather than writing
// position_legs/trades directly. Same idea as POST /orders above; only the
// worker writes those tables now, once IBKR actually fills the order.
positionsRouter.post("/:id/roll", async (request, response) => {
  const { sourceAlertId, closeLegId, closeLimitPrice, newLeg, signalSnapshot } = request.body as {
    sourceAlertId?: string;
    closeLegId?: string;
    closeLimitPrice?: number;
    newLeg?: { strikePrice: number; expiryDate: string; quantity: number; limitPrice: number };
    /** Roll Signals only: both legs' scores at build time (stored as-is, like an open order's snapshot). */
    signalSnapshot?: unknown;
  };
  const snapshot = readSignalSnapshot(signalSnapshot);
  if (!snapshot.ok) {
    response.status(400).json({ error: snapshot.error });
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
    !(newLeg.limitPrice > 0)
  ) {
    response.status(400).json({ error: "newLeg requires strikePrice, expiryDate, quantity, and a positive limitPrice (the new leg is sold, never for $0)." });
    return;
  }
  const normalizedNewLegExpiry = normalizeExpiryDate(newLeg.expiryDate);
  if (!normalizedNewLegExpiry) {
    response.status(400).json({ error: `newLeg.expiryDate must be a YYYYMMDD date, got "${newLeg.expiryDate}".` });
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
  {
    const conflict = await findActiveOrderConflict(db, { positionId: position.id, sourceAlertId });
    if (conflict) {
      response.status(409).json({ error: describeActiveOrderConflict(conflict) });
      return;
    }
  }

  // Optional — a user-initiated roll built via the on-demand roll-candidate
  // endpoint (evaluateRollForPosition.ts) has no backing trade_alerts row.
  // When present, validated the same way POST /orders validates its own
  // sourceAlertId.
  if (sourceAlertId) {
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
      unitPrice: roundToCents(closeLimitPrice),
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
      unitPrice: roundToCents(newLeg.limitPrice),
      strike: newLeg.strikePrice,
      expiry: normalizedNewLegExpiry,
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
      source_alert_id: sourceAlertId || null,
      signal_snapshot: snapshot.value === null ? null : JSON.stringify(snapshot.value),
    })
    .returning("*");

  await publishNotification({ type: "order_status", orderId: orderRequest.id });
  const [calendarWarning, riskFreeRate] = await Promise.all([
    fetchEconomicCalendarWarningEvents(normalizedNewLegExpiry).then(formatEconomicCalendarWarning),
    getRiskFreeRate().catch(() => null),
  ]);
  response.status(201).json({ ...serializeOrderRequest(orderRequest), calendarWarning, riskFreeRate });
});

// Read-only preview: computes a roll candidate for one specific leg on
// demand (live IBKR quotes, no order/alert written) — added 2026-08-31 so
// a user-initiated "Roll" click works even when the scheduled trade-alert
// job hasn't (or never would) flag this leg as triggered. See
// evaluateRollForPosition.ts. The response shape mirrors a roll trade
// alert's suggestedStructure so the frontend can feed it straight into the
// same RollPositionModal used for real roll alerts. Streamed (2026-09-24,
// see streamedResponse.ts): a one-shot connect, contract details per expiry
// and an 8s quote ceiling can pass Heroku's 30s router timeout.
positionsRouter.post("/:id/roll-candidate", async (request, response) => {
  const { legId } = request.body as { legId?: string };
  if (!legId) {
    response.status(400).json({ error: "legId is required." });
    return;
  }

  await respondWithStreamedResult(response, async () => {
    let result: Awaited<ReturnType<typeof evaluateRollForPosition>>;
    try {
      result = await evaluateRollForPosition(request.params.id!, legId);
    } catch (error) {
      return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    switch (result.status) {
      case "not_found":
        return { status: 404, body: { error: "Leg not found on this position." } };
      case "not_rollable":
        return { status: 400, body: { error: result.reason } };
      case "no_settings":
        return { status: 409, body: { error: "No strategy settings configured for this position's strategy." } };
      case "no_quote":
        return { status: 422, body: { error: "No live quote for the current leg right now — try again during market hours." } };
      case "no_candidate":
        return { status: 422, body: { error: "No viable replacement contract found for this leg right now." } };
      case "ok":
        return {
          status: 200,
          body: {
            symbol: result.symbol,
            relatedPositionId: result.relatedPositionId,
            rationale: result.rationale,
            suggestedStructure: result.suggestedStructure,
          },
        };
    }
  });
});

// Read-only recovery-path projection for an unstructured bare-stock
// position — "Recovery Path Formula" proposal, approved by Marcelo
// 2026-08-31. See evaluateRecoveryPathForPosition.ts for the formula.
// Writes nothing; opens its own short-lived IBKR connection per call.
// Streamed (2026-09-24, see streamedResponse.ts) for the same reason as
// /:id/roll-candidate above.
positionsRouter.post("/:id/recovery-path", async (request, response) => {
  await respondWithStreamedResult(response, async () => {
    let result: Awaited<ReturnType<typeof evaluateRecoveryPathForPosition>>;
    try {
      result = await evaluateRecoveryPathForPosition(request.params.id!);
    } catch (error) {
      return { status: 502, body: { error: error instanceof Error ? error.message : String(error) } };
    }
    switch (result.status) {
      case "not_found":
        return { status: 404, body: { error: "Position not found." } };
      case "not_unstructured":
        return { status: 400, body: { error: result.reason } };
      case "no_shares":
        return { status: 422, body: { error: "No open stock shares held on this position." } };
      case "no_settings":
        return { status: 409, body: { error: "No strategy settings configured for covered calls." } };
      case "ok":
        return {
          status: 200,
          body: {
            symbol: result.symbol,
            shares: result.shares,
            entryPrice: result.entryPrice,
            currentPrice: result.currentPrice,
            unrealizedLoss: result.unrealizedLoss,
            contractsAvailable: result.contractsAvailable,
            candidate: result.candidate,
            monthlyPremium: result.monthlyPremium,
            monthsToRecover: result.monthsToRecover,
            rationale: result.rationale,
          },
        };
    }
  });
});

// Builds an order_requests row (request_type "close_position") for a combo
// order closing currently-open legs at once — same "only the worker writes
// position_legs/trades" rule as everywhere else above. Every included leg
// needs a limit price (what you're willing to pay/receive to close it).
//
// contractsToClose (added 2026-08-25 for downsizing, see PROGRESS.md)
// drives a partial close entirely off the option leg's contract count —
// the stock leg's quantity is always derived from it (contractsToClose *
// multiplier), never independently settable, so a partial close can't
// unbalance a covered call's coverage ratio. Omitting it closes every leg
// at full quantity, same as before. Only applies to structured positions
// (exactly one option leg) — see the "unstructured" branch below.
//
// Unstructured positions (2026-08-31, see PROGRESS.md "close an
// unstructured position") skip both of the above: their leg mix isn't a
// known strategy shape, so contractsToClose has nothing sensible to derive
// from. Instead each leg in `legs[]` carries its own explicit `quantity`,
// any subset of the position's open legs may be included (partial close),
// and the worker's existing reconciliation pass (not this route) is what
// decides whether the position is fully closed afterward.
positionsRouter.post("/:id/close", async (request, response) => {
  const { legs, contractsToClose } = request.body as {
    legs?: { legId: string; limitPrice: number; quantity?: number }[];
    contractsToClose?: number;
  };

  if (!legs || legs.length === 0) {
    response.status(400).json({ error: "At least one leg is required." });
    return;
  }
  for (const leg of legs) {
    if (!leg.legId || typeof leg.limitPrice !== "number" || leg.limitPrice < 0) {
      response.status(400).json({ error: "Each leg requires legId and a non-negative limitPrice." });
      return;
    }
    if (leg.quantity !== undefined && (!Number.isInteger(leg.quantity) || leg.quantity <= 0)) {
      response.status(400).json({ error: "Each leg's quantity, if provided, must be a positive integer." });
      return;
    }
  }
  if (contractsToClose !== undefined && (!Number.isInteger(contractsToClose) || contractsToClose <= 0)) {
    response.status(400).json({ error: "contractsToClose must be a positive integer." });
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
  {
    const conflict = await findActiveOrderConflict(db, { positionId: position.id });
    if (conflict) {
      response.status(409).json({ error: describeActiveOrderConflict(conflict) });
      return;
    }
  }

  const existingLegs = await db("position_legs").where({ position_id: position.id, exit_at: null });
  const existingLegIds = new Set(existingLegs.map((leg) => leg.id));
  const providedLegIds = new Set(legs.map((leg) => leg.legId));
  const isUnstructured = position.strategy_key === "unstructured";

  for (const legId of providedLegIds) {
    if (!existingLegIds.has(legId)) {
      response.status(400).json({ error: `Leg ${legId} is not an open leg of this position.` });
      return;
    }
  }
  if (!isUnstructured) {
    const allLegsCovered = existingLegIds.size === providedLegIds.size && [...existingLegIds].every((id) => providedLegIds.has(id));
    if (!allLegsCovered) {
      response.status(400).json({ error: "All open legs of this position must be included when closing it." });
      return;
    }
  }

  const legsToClose = existingLegs.filter((leg) => providedLegIds.has(leg.id));
  const optionLegs = legsToClose.filter((leg) => leg.leg_type === "option");
  if (contractsToClose !== undefined) {
    if (isUnstructured) {
      response.status(400).json({ error: "contractsToClose is not supported for unstructured positions — provide a quantity per leg instead." });
      return;
    }
    if (optionLegs.length !== 1) {
      response.status(400).json({ error: "Downsizing only supports positions with exactly one option leg." });
      return;
    }
    const [optionLeg] = optionLegs;
    if (contractsToClose > optionLeg!.quantity) {
      response.status(400).json({ error: `Cannot close ${contractsToClose} contracts — only ${optionLeg!.quantity} held.` });
      return;
    }
  }
  const optionLeg = optionLegs[0];
  const quantityByLegId = new Map(legs.map((leg) => [leg.legId, leg.quantity]));

  function quantityForLeg(leg: (typeof existingLegs)[number]): number {
    if (isUnstructured) {
      const requestedQuantity = quantityByLegId.get(leg.id);
      return requestedQuantity ?? leg.quantity;
    }
    if (contractsToClose === undefined) return leg.quantity;
    if (leg.id === optionLeg!.id) return contractsToClose;
    return contractsToClose * optionLeg!.multiplier; // stock leg — derived, never independently set
  }

  if (isUnstructured) {
    for (const leg of legsToClose) {
      if (quantityForLeg(leg) > leg.quantity) {
        response.status(400).json({
          error: `Cannot close ${quantityForLeg(leg)} units of leg ${leg.id} — only ${leg.quantity} held.`,
        });
        return;
      }
    }
  }

  // Defensive check: should always divide evenly for a well-formed covered
  // call, but a mismatch means the position's data is inconsistent, and
  // closing anyway risks leaving it unbalanced — a hard stop, not a clamp.
  if (contractsToClose !== undefined) {
    for (const leg of legsToClose) {
      if (leg.leg_type === "stock" && quantityForLeg(leg) > leg.quantity) {
        response.status(400).json({
          error: `Derived stock quantity (${quantityForLeg(leg)} shares) exceeds what's held (${leg.quantity} shares) — position data may be inconsistent.`,
        });
        return;
      }
    }
  }

  const ticker = await db("tickers").where({ id: position.ticker_id }).first();
  const limitPriceByLegId = new Map(legs.map((leg) => [leg.legId, leg.limitPrice]));

  const orderLegs: OrderLegPayload[] = legsToClose.map((leg) => ({
    role: leg.leg_type,
    action: leg.side === "long" ? OrderAction.SELL : OrderAction.BUY, // closing action is the inverse of how it was opened
    symbol: ticker.symbol,
    quantity: quantityForLeg(leg),
    unitPrice: roundToCents(limitPriceByLegId.get(leg.id)!),
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

  await publishNotification({ type: "order_status", orderId: orderRequest.id });
  response.status(201).json(serializeOrderRequest(orderRequest));
});
