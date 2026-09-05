import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computePositionExposures, type PositionExposureRow } from "../lib/positionExposure.js";

export const riskLimitsRouter = Router();
riskLimitsRouter.use(requireAuth);

// v1 strategy scope — matches shortlist.ts.
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

// Only meaningful for covered_call — governs delta selection when the
// account already owns enough shares of the ticker to write against (see
// fetchAvailableUncoveredShares). cash_secured_put has no "existing
// position" concept and leaves these columns null.
const existingPositionDeltaFields = ["delta_target_min_existing_position", "delta_target_max_existing_position"] as const;

function validateSettingsPayload(strategyKey: string, payload: Record<string, unknown>): string | null {
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

  if (strategyKey === "covered_call") {
    for (const field of existingPositionDeltaFields) {
      const value = payload[field];
      if (typeof value !== "number" || Number.isNaN(value)) {
        return `${field} must be a number.`;
      }
    }
    const pe = payload as Record<(typeof existingPositionDeltaFields)[number], number>;
    if (pe.delta_target_min_existing_position < 0 || pe.delta_target_max_existing_position > 1) {
      return "Existing-position delta targets must be between 0 and 1.";
    }
    if (pe.delta_target_min_existing_position > pe.delta_target_max_existing_position) {
      return "delta_target_min_existing_position cannot exceed delta_target_max_existing_position.";
    }
  }

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

  const validationError = validateSettingsPayload(strategyKey, request.body ?? {});
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }

  const body = request.body as Record<string, number>;
  const updatePayload: Record<string, number> = {};
  for (const field of settingsFields) {
    updatePayload[field] = body[field] as number;
  }
  if (strategyKey === "covered_call") {
    for (const field of existingPositionDeltaFields) {
      updatePayload[field] = body[field] as number;
    }
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

function groupByKey<K extends string>(
  rows: PositionExposureRow[],
  keyOf: (row: PositionExposureRow) => K,
): { key: K; notionalValue: string }[] {
  const totals = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    totals.set(key, (totals.get(key) ?? 0) + row.exposure);
  }
  return [...totals.entries()]
    .map(([key, notionalValue]) => ({ key, notionalValue: String(notionalValue) }))
    .sort((a, b) => Number(b.notionalValue) - Number(a.notionalValue));
}

riskLimitsRouter.get("/exposure", async (_request, response) => {
  const [exposures, accountResult] = await Promise.all([
    computePositionExposures(),
    fetchAccountSummary()
      .then((account) => ({ account, accountDataError: null as string | null }))
      .catch((error) => ({
        account: null,
        accountDataError: error instanceof Error ? error.message : "Failed to fetch live account data from IBKR.",
      })),
  ]);

  const { account, accountDataError } = accountResult;
  const totalAccountValue = account?.netLiquidationValue ?? null;

  const concentrationByTicker = groupByKey(exposures, (row) => row.symbol).map((row) => ({
    symbol: row.key,
    notionalValue: row.notionalValue,
  }));
  const concentrationBySector = groupByKey(exposures, (row) => row.sector).map((row) => ({
    sector: row.key,
    notionalValue: row.notionalValue,
  }));
  const strategyAllocation = groupByKey(exposures, (row) => row.strategyKey).map((row) => ({
    strategyKey: row.key,
    notionalValue: row.notionalValue,
  }));
  const topPositions = [...exposures]
    .sort((a, b) => b.exposure - a.exposure)
    .slice(0, 5)
    .map((row) => ({ positionId: row.positionId, symbol: row.symbol, strategyKey: row.strategyKey, notionalValue: String(row.exposure) }));

  response.json({
    account,
    accountDataError,
    totalAccountValue,
    concentrationByTicker,
    concentrationBySector: withUnallocated(concentrationBySector, totalAccountValue, {
      sector: "Unallocated",
      notionalValue: "0",
    }),
    strategyAllocation: withUnallocated(strategyAllocation, totalAccountValue, {
      strategyKey: "unallocated",
      notionalValue: "0",
    }),
    topPositions,
  });
});
