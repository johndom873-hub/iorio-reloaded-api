import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { legRealizedPnlSql } from "../lib/legRealizedPnlSql.js";

// Realized P&L for Pluto actions, derived at read time (Marcelo, 2026-09-28: read-time join, no
// stored copy; knex.raw reads ":name:" as an identifier, hence the positional binding). Attribution rule: a leg's realized P&L belongs to the Pluto action whose order
// OPENED it; a leg Pluto only closed (a human opened it, e.g. Formula P1 shares) belongs to the
// closing action. Rolls therefore split by leg: the roll action owns the leg it opened, the
// closed leg stays with whichever action opened it. Legs still open contribute nothing yet.

export interface PlutoActionRealizedPnl {
  realizedPnl: number | null;
  closedLegCount: number;
  openLegCount: number;
}

export async function loadRealizedPnlByActionId(actionIds: string[], connection: Knex = db): Promise<Map<string, PlutoActionRealizedPnl>> {
  const result = new Map<string, PlutoActionRealizedPnl>();
  if (actionIds.length === 0) return result;
  const rows = await connection.raw(
    `
    WITH action_orders AS (
      SELECT a.id AS action_id, a.order_request_id
      FROM pluto_actions a
      WHERE a.id = ANY(?::uuid[]) AND a.order_request_id IS NOT NULL
    ),
    opened AS (
      SELECT DISTINCT ao.action_id, tr.position_leg_id
      FROM action_orders ao
      JOIN trades tr ON tr.source_order_request_id = ao.order_request_id AND NOT tr.is_closing_trade
    ),
    closed_by_pluto_only AS (
      SELECT DISTINCT ao.action_id, tr.position_leg_id
      FROM action_orders ao
      JOIN trades tr ON tr.source_order_request_id = ao.order_request_id AND tr.is_closing_trade
      WHERE NOT EXISTS (
        SELECT 1
        FROM trades opening
        JOIN pluto_actions opener ON opener.order_request_id = opening.source_order_request_id
        WHERE opening.position_leg_id = tr.position_leg_id AND NOT opening.is_closing_trade
      )
    ),
    owned_legs AS (
      SELECT action_id, position_leg_id FROM opened
      UNION
      SELECT action_id, position_leg_id FROM closed_by_pluto_only
    )
    SELECT
      owned.action_id,
      COUNT(*) FILTER (WHERE pl.exit_price IS NULL) AS open_leg_count,
      COUNT(*) FILTER (WHERE pl.exit_price IS NOT NULL) AS closed_leg_count,
      SUM(CASE WHEN pl.exit_price IS NOT NULL THEN ${legRealizedPnlSql("pl")} END) AS realized_pnl
    FROM owned_legs owned
    JOIN position_legs pl ON pl.id = owned.position_leg_id
    GROUP BY owned.action_id
    `,
    [actionIds],
  );
  for (const row of rows.rows as { action_id: string; open_leg_count: string; closed_leg_count: string; realized_pnl: string | null }[]) {
    result.set(row.action_id, {
      realizedPnl: row.realized_pnl === null ? null : Math.round(Number(row.realized_pnl) * 100) / 100,
      closedLegCount: Number(row.closed_leg_count),
      openLegCount: Number(row.open_leg_count),
    });
  }
  return result;
}
