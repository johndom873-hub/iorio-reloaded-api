import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";

export const signalSettingsRouter = Router();
signalSettingsRouter.use(requireAuth);

const settingsFields = [
  "max_delta_drift_pct",
  "min_annualized_yield_pct",
  "max_net_delta",
  "max_position_pct_of_portfolio",
  "max_concentration_per_ticker_pct",
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

  if (p.max_net_delta < 0 || p.max_net_delta > 1) return "max_net_delta must be between 0 and 1.";

  const percentageFields = [
    "max_delta_drift_pct",
    "min_annualized_yield_pct",
    "max_position_pct_of_portfolio",
    "max_concentration_per_ticker_pct",
    "min_cash_reserve_pct",
  ] as const;
  for (const field of percentageFields) {
    if (p[field] < 0 || p[field] > 100) return `${field} must be between 0 and 100.`;
  }

  return null;
}

signalSettingsRouter.get("/", async (_request, response) => {
  const row = await db("signal_settings as ss")
    .leftJoin("users as u", "u.id", "ss.updated_by_user_id")
    .select("ss.*", "u.display_name as updated_by_display_name")
    .first();
  response.json(row ?? null);
});

signalSettingsRouter.put("/", async (request, response) => {
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

  const [row] = await db("signal_settings")
    .update({ ...updatePayload, updated_at: db.fn.now(), updated_by_user_id: request.session.userId })
    .returning("*");

  if (!row) {
    response.status(404).json({ error: "No signal_settings row found." });
    return;
  }
  response.json(row);
});
