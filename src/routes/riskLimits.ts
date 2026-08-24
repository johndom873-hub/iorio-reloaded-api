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
  const rows = await db("strategy_settings").select("*").orderBy("strategy_key");
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
    .update({ ...updatePayload, updated_at: db.fn.now() })
    .returning("*");

  if (!row) {
    response.status(404).json({ error: "No strategy_settings row for this strategyKey." });
    return;
  }
  response.json(row);
});

// Notional-value proxy from entry price × quantity × multiplier — not
// live-repriced. Good enough for a concentration cap (relative weighting
// across the book), revisit if precise live valuation is ever needed here.
riskLimitsRouter.get("/exposure", async (_request, response) => {
  const concentrationByTicker = await db.raw(`
    SELECT
      t.symbol,
      SUM(ABS(pl.quantity) * pl.entry_price * pl.multiplier) AS "notionalValue"
    FROM position_legs pl
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    WHERE p.status = 'open'
    GROUP BY t.symbol
    ORDER BY "notionalValue" DESC
  `);

  const concentrationBySector = await db.raw(`
    SELECT
      COALESCE(NULLIF(t.sector, ''), 'Unknown') AS sector,
      SUM(ABS(pl.quantity) * pl.entry_price * pl.multiplier) AS "notionalValue"
    FROM position_legs pl
    JOIN positions p ON p.id = pl.position_id
    JOIN tickers t ON t.id = p.ticker_id
    WHERE p.status = 'open'
    GROUP BY COALESCE(NULLIF(t.sector, ''), 'Unknown')
    ORDER BY "notionalValue" DESC
  `);

  let account: Awaited<ReturnType<typeof fetchAccountSummary>> | null = null;
  let accountDataError: string | null = null;
  try {
    account = await fetchAccountSummary();
  } catch (error) {
    accountDataError = error instanceof Error ? error.message : "Failed to fetch live account data from IBKR.";
  }

  response.json({
    account,
    accountDataError,
    concentrationByTicker: concentrationByTicker.rows,
    concentrationBySector: concentrationBySector.rows,
  });
});
