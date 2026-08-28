import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";

export const riskLimitsRouter = Router();
riskLimitsRouter.use(requireAuth);

// v1 strategy scope — matches screener.ts.
const validStrategyKeys = ["covered_call", "cash_secured_put"];

const settingsFields = [
  "delta_target_min",
  "delta_target_max",
  "dte_target_min",
  "dte_target_max",
  "max_position_pct_of_portfolio",
  "max_aggregate_collateral_pct",
  "max_concentration_per_ticker_pct",
  "max_concentration_per_sector_pct",
  "min_cash_reserve_pct",
] as const;

function validateSettingsPayload(payload: Record<string, unknown>): string | null {
  for (const field of settingsFields) {
    const value = payload[field];
    if (typeof value !== "number" || Number.isNaN(value)) {
      return `${field} must be a number.`;
    }
  }
  const p = payload as Record<(typeof settingsFields)[number], number>;

  if (p.delta_target_min < 0 || p.delta_target_max > 1) return "Delta targets must be between 0 and 1.";
  if (p.delta_target_min > p.delta_target_max) return "delta_target_min cannot exceed delta_target_max.";
  if (p.dte_target_min < 0) return "dte_target_min cannot be negative.";
  if (p.dte_target_min > p.dte_target_max) return "dte_target_min cannot exceed dte_target_max.";

  const percentageFields = [
    "max_position_pct_of_portfolio",
    "max_aggregate_collateral_pct",
    "max_concentration_per_ticker_pct",
    "max_concentration_per_sector_pct",
    "min_cash_reserve_pct",
  ] as const;
  for (const field of percentageFields) {
    if (p[field] < 0 || p[field] > 100) return `${field} must be between 0 and 100.`;
  }

  return null;
}

riskLimitsRouter.get("/settings", async (_request, response) => {
  const rows = await db("strategy_settings as ss")
    .leftJoin("users as u", "u.id", "ss.updated_by_user_id")
    .select("ss.*", "u.display_name as updated_by_display_name")
    .orderBy("ss.strategy_key");
  response.json(rows);
});

riskLimitsRouter.put("/settings/:strategyKey", async (request, response) => {
  const { strategyKey } = request.params;
  if (!validStrategyKeys.includes(strategyKey)) {
    response.status(400).json({ error: "Unknown strategyKey." });
    return;
  }

  const validationError = validateSettingsPayload(request.body ?? {});
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  const body = request.body as Record<string, number>;
  const updatePayload: Record<string, number> = {};
  for (const field of settingsFields) {
    updatePayload[field] = body[field] as number;
  }

  const [row] = await db("strategy_settings")
    .where({ strategy_key: strategyKey })
    .update({ ...updatePayload, updated_at: db.fn.now(), updated_by_user_id: request.session.userId })
    .returning("*");

  if (!row) {
    response.status(404).json({ error: "No strategy_settings row for this strategyKey." });
    return;
  }
  response.json(row);
});

// Per-open-position exposure — same "capital actually committed" concept
// as positions.ts's capitalAtRisk (stock leg's entry cost for covered
// calls; the option leg's strike × multiplier × quantity for cash-secured
// puts, since that's the cash reserved to cover assignment), not a raw
// sum-of-all-legs notional. Kept as one CTE and reused for every grouping
// below so ticker/sector/strategy/top-position figures are always
// mutually consistent with each other and with what Positions shows.
const positionExposureCte = `
  WITH position_exposure AS (
    SELECT
      p.id AS position_id,
      p.strategy_key,
      t.symbol,
      COALESCE(NULLIF(t.sector, ''), 'Unknown') AS sector,
      CASE
        WHEN p.strategy_key = 'covered_call' THEN (
          SELECT pl.entry_price * pl.quantity
          FROM position_legs pl
          WHERE pl.position_id = p.id AND pl.leg_type = 'stock'
          LIMIT 1
        )
        ELSE (
          SELECT pl.strike_price * pl.multiplier * pl.quantity
          FROM position_legs pl
          WHERE pl.position_id = p.id AND pl.leg_type = 'option'
          ORDER BY (pl.exit_at IS NULL) DESC, pl.entry_at DESC
          LIMIT 1
        )
      END AS exposure
    FROM positions p
    JOIN tickers t ON t.id = p.ticker_id
    WHERE p.status = 'open'
  )
`;

// Approved 2026-08-25: every concentration/allocation % on this page and
// on the Dashboard is against total account value (net liquidation value,
// i.e. positions + cash), not against the sum of open positions — so an
// under-deployed account doesn't read as "concentrated" just because
// whatever's invested happens to cluster. Sector/strategy groupings get an
// explicit "Unallocated" row for whatever isn't in any open position,
// rather than silently omitting cash from the picture.
function withUnallocated<T extends { notionalValue: string }>(
  rows: T[],
  totalAccountValue: number | null,
  unallocatedRow: T,
): T[] {
  if (totalAccountValue === null || totalAccountValue === undefined) return rows;
  const allocated = rows.reduce((sum, row) => sum + Number(row.notionalValue), 0);
  const unallocated = totalAccountValue - allocated;
  if (unallocated <= 0) return rows;
  return [...rows, { ...unallocatedRow, notionalValue: String(unallocated) }];
}

riskLimitsRouter.get("/exposure", async (_request, response) => {
  const [concentrationByTicker, concentrationBySector, strategyAllocation, topPositions] = await Promise.all([
    db.raw(`${positionExposureCte}
      SELECT symbol, SUM(exposure) AS "notionalValue"
      FROM position_exposure
      GROUP BY symbol
      ORDER BY "notionalValue" DESC
    `),
    db.raw(`${positionExposureCte}
      SELECT sector, SUM(exposure) AS "notionalValue"
      FROM position_exposure
      GROUP BY sector
      ORDER BY "notionalValue" DESC
    `),
    db.raw(`${positionExposureCte}
      SELECT strategy_key AS "strategyKey", SUM(exposure) AS "notionalValue"
      FROM position_exposure
      GROUP BY strategy_key
      ORDER BY "notionalValue" DESC
    `),
    db.raw(`${positionExposureCte}
      SELECT position_id AS "positionId", symbol, strategy_key AS "strategyKey", exposure AS "notionalValue"
      FROM position_exposure
      ORDER BY exposure DESC
      LIMIT 5
    `),
  ]);

  let account: Awaited<ReturnType<typeof fetchAccountSummary>> | null = null;
  let accountDataError: string | null = null;
  try {
    account = await fetchAccountSummary();
  } catch (error) {
    accountDataError = error instanceof Error ? error.message : "Failed to fetch live account data from IBKR.";
  }

  const totalAccountValue = account?.netLiquidationValue ?? null;

  response.json({
    account,
    accountDataError,
    totalAccountValue,
    concentrationByTicker: concentrationByTicker.rows,
    concentrationBySector: withUnallocated(concentrationBySector.rows, totalAccountValue, {
      sector: "Unallocated",
      notionalValue: "0",
    }),
    strategyAllocation: withUnallocated(strategyAllocation.rows, totalAccountValue, {
      strategyKey: "unallocated",
      notionalValue: "0",
    }),
    topPositions: topPositions.rows,
  });
});
