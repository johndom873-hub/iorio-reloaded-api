import { db } from "../db/connection.js";

// Reconstructs a human-readable position lifecycle feed from data that's
// already persisted (positions/position_legs/trades) — no new events table
// needed, confirmed 2026-08-28 (see PROGRESS.md). close_reason and
// unstructured_reason (added the same day) are what make this possible:
// without them, "assigned vs expired worthless" was only ever computed
// transiently by the worker and never stored.
export interface PositionEvent {
  positionId: string;
  eventType: "opened" | "closed" | "unstructured";
  eventAt: string;
  symbol: string;
  strategyKey: string;
  closeReason: string | null;
  unstructuredReason: string | null;
  // Realized P&L for a "closed" event; null (not 0) when the position's
  // legs don't have enough data to trust a sum — e.g. a leg exited before
  // close_reason/exit_price tracking existed and has exit_at but no
  // exit_price, which used to silently render as a misleading "$0.00".
  realizedPnl: number | null;
  // Net cash effect for an "opened" event (premium collected minus stock
  // bought) — not meaningful for "closed"/"unstructured" events, null there.
  netCashEffect: number | null;
  // Full market value across both legs for covered_call/cash_secured_put
  // (same standard as Portfolio/Allocation — see
  // project_position_valuation_full_market_value), priced at entry for an
  // "opened" event and at exit for a "closed" event. Requested 2026-08-28
  // to replace netCashEffect/realizedPnl in the events feed's Value column
  // — those two remain above for their own distinct meanings. Null for
  // "unstructured" (no clean cash-lock rule to apply) and for a "closed"
  // event with an ambiguous exit (same null-not-zero reasoning as
  // realizedPnl above).
  fullMarketValue: number | null;
  // Best-effort, not exhaustive — the full user-attribution audit flagged
  // in PROGRESS.md (2026-08-28) hasn't happened yet. Determinable today:
  // closes/rolls (order_requests.related_position_id is always set for
  // those) and alert-sourced opens (via trade_alerts.resulting_position_id).
  // A manually-entered new position with no source alert has no link back
  // to an order_request at all yet, so this is null there — an honest gap,
  // not a guess. Genosuke acts as a real users row (see
  // project_internal_api_client_pattern), so bot-initiated trades already
  // attribute correctly through the same join, no separate bot detection.
  attributedTo: string | null;
  legs: {
    legType: "stock" | "option";
    side: "long" | "short";
    quantity: number;
    optionType: "call" | "put" | null;
    strikePrice: number | null;
    expiryDate: string | null;
    entryPrice: number;
    exitPrice: number | null;
  }[];
}

interface PositionRow {
  id: string;
  symbol: string;
  strategyKey: string;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  unstructuredReason: string | null;
}

interface LegRow {
  positionId: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  multiplier: number;
  optionType: "call" | "put" | null;
  strikePrice: string | null;
  expiryDate: string | null;
  entryPrice: string;
  exitPrice: string | null;
  exitAt: string | null;
}

export async function fetchPositionEvents(limit = 40): Promise<PositionEvent[]> {
  const positions: PositionRow[] = await db("positions as p")
    .join("tickers as t", "t.id", "p.ticker_id")
    .orderBy(db.raw("GREATEST(p.opened_at, COALESCE(p.closed_at, p.opened_at))"), "desc")
    .limit(limit)
    .select(
      "p.id",
      "t.symbol",
      "p.strategy_key as strategyKey",
      "p.opened_at as openedAt",
      "p.closed_at as closedAt",
      "p.close_reason as closeReason",
      "p.unstructured_reason as unstructuredReason",
    );

  if (positions.length === 0) return [];

  const positionIds = positions.map((p) => p.id);

  const [openAttributions, closeAttributions] = await Promise.all([
    db("trade_alerts as ta")
      .join("order_requests as orq", (join) => join.on("orq.source_alert_id", "ta.id").andOnVal("orq.status", "filled"))
      .join("users as u", "u.id", "orq.requested_by_user_id")
      .whereIn("ta.resulting_position_id", positionIds)
      .orderBy("orq.created_at", "asc")
      .select("ta.resulting_position_id as positionId", "u.display_name as displayName"),
    db("order_requests as orq")
      .join("users as u", "u.id", "orq.requested_by_user_id")
      .where("orq.status", "filled")
      .whereIn("orq.related_position_id", positionIds)
      .orderBy("orq.created_at", "desc")
      .select("orq.related_position_id as positionId", "u.display_name as displayName"),
  ]);
  // First match wins per position — openAttributions ordered earliest-first
  // (the alert that originally led to this position), closeAttributions
  // ordered latest-first (the most recent close/roll confirmation).
  const openAttributionByPositionId = new Map<string, string>();
  for (const row of openAttributions) if (!openAttributionByPositionId.has(row.positionId)) openAttributionByPositionId.set(row.positionId, row.displayName);
  const closeAttributionByPositionId = new Map<string, string>();
  for (const row of closeAttributions) if (!closeAttributionByPositionId.has(row.positionId)) closeAttributionByPositionId.set(row.positionId, row.displayName);

  const legs: LegRow[] = await db("position_legs")
    .whereIn(
      "position_id",
      positions.map((p) => p.id),
    )
    .select(
      "position_id as positionId",
      "leg_type as legType",
      "side",
      "quantity",
      "multiplier",
      "option_type as optionType",
      "strike_price as strikePrice",
      db.raw("to_char(expiry_date, 'YYYY-MM-DD') as \"expiryDate\""),
      "entry_price as entryPrice",
      "exit_price as exitPrice",
      "exit_at as exitAt",
    );

  const legsByPositionId = new Map<string, LegRow[]>();
  for (const leg of legs) {
    const list = legsByPositionId.get(leg.positionId) ?? [];
    list.push(leg);
    legsByPositionId.set(leg.positionId, list);
  }

  function legSummaries(positionLegs: LegRow[]) {
    return positionLegs.map((leg) => ({
      legType: leg.legType,
      side: leg.side,
      quantity: leg.quantity,
      optionType: leg.optionType,
      strikePrice: leg.strikePrice === null ? null : Number(leg.strikePrice),
      expiryDate: leg.expiryDate,
      entryPrice: Number(leg.entryPrice),
      exitPrice: leg.exitPrice === null ? null : Number(leg.exitPrice),
    }));
  }

  // null (not a possibly-wrong partial sum) when any leg exited without a
  // recorded exit_price — a real data gap from before exit_price tracking
  // was reliable for every close path, not a genuine $0 outcome.
  function realizedPnlFor(positionLegs: LegRow[]): number | null {
    const hasAmbiguousExit = positionLegs.some((leg) => leg.exitAt !== null && leg.exitPrice === null);
    if (hasAmbiguousExit) return null;
    return positionLegs.reduce((sum, leg) => {
      if (leg.exitPrice === null) return sum;
      const sign = leg.side === "short" ? -1 : 1;
      return sum + (Number(leg.exitPrice) - Number(leg.entryPrice)) * leg.quantity * leg.multiplier * sign;
    }, 0);
  }

  // Premium collected minus stock bought at open — side="short" means sold
  // (cash in), side="long" means bought (cash out). Same sign convention as
  // realizedPnlFor, using entry_price instead of the exit/entry spread.
  function netCashEffectFor(positionLegs: LegRow[]): number {
    return positionLegs.reduce((sum, leg) => {
      const sign = leg.side === "short" ? 1 : -1;
      return sum + Number(leg.entryPrice) * leg.quantity * leg.multiplier * sign;
    }, 0);
  }

  // Same formula as positionExposure.ts's computePositionExposures, just
  // priced at entry (open) or exit (close) instead of a live quote — a
  // CSP's collateral (strike × multiplier × qty) is never its own
  // position_legs row, so it's added explicitly alongside the option leg's
  // own value.
  function fullMarketValueFor(positionLegs: LegRow[], strategyKey: string, atClose: boolean): number | null {
    if (strategyKey !== "covered_call" && strategyKey !== "cash_secured_put") return null;
    if (atClose && positionLegs.some((leg) => leg.exitPrice === null)) return null;

    return positionLegs.reduce((sum, leg) => {
      const price = atClose ? Number(leg.exitPrice) : Number(leg.entryPrice);
      const sign = leg.side === "short" ? -1 : 1;
      let value = price * leg.quantity * leg.multiplier * sign;
      if (strategyKey === "cash_secured_put" && leg.legType === "option" && leg.strikePrice !== null) {
        value += Number(leg.strikePrice) * leg.multiplier * leg.quantity;
      }
      return sum + value;
    }, 0);
  }

  const events: PositionEvent[] = [];
  for (const position of positions) {
    const positionLegs = legsByPositionId.get(position.id) ?? [];

    const isUnstructured = position.strategyKey === "unstructured";
    events.push({
      positionId: position.id,
      eventType: isUnstructured ? "unstructured" : "opened",
      eventAt: position.openedAt,
      symbol: position.symbol,
      strategyKey: position.strategyKey,
      closeReason: null,
      unstructuredReason: isUnstructured ? position.unstructuredReason : null,
      realizedPnl: null,
      netCashEffect: isUnstructured ? null : netCashEffectFor(positionLegs),
      fullMarketValue: fullMarketValueFor(positionLegs, position.strategyKey, false),
      attributedTo: openAttributionByPositionId.get(position.id) ?? null,
      legs: legSummaries(positionLegs),
    });

    if (position.closedAt) {
      events.push({
        positionId: position.id,
        eventType: "closed",
        eventAt: position.closedAt,
        symbol: position.symbol,
        strategyKey: position.strategyKey,
        closeReason: position.closeReason,
        unstructuredReason: null,
        realizedPnl: realizedPnlFor(positionLegs),
        netCashEffect: null,
        fullMarketValue: fullMarketValueFor(positionLegs, position.strategyKey, true),
        attributedTo: closeAttributionByPositionId.get(position.id) ?? null,
        legs: legSummaries(positionLegs),
      });
    }
  }

  return events.sort((a, b) => new Date(b.eventAt).getTime() - new Date(a.eventAt).getTime()).slice(0, limit);
}
