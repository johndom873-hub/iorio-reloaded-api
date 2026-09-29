import { db } from "../db/connection.js";

/** A strategy's configured delta/DTE target window (strategy_settings, edited on Risk Limits). */
export interface StrategyTargetWindow {
  deltaTargetMin: number;
  deltaTargetMax: number;
  dteTargetMin: number;
  dteTargetMax: number;
}

/** The strategy's delta/DTE target window, or null when strategy_settings has no row for it. */
export async function loadStrategyTargetWindow(strategyKey: string): Promise<StrategyTargetWindow | null> {
  const settingsRow = await db("strategy_settings").where({ strategy_key: strategyKey }).first("delta_target_min", "delta_target_max", "dte_target_min", "dte_target_max");
  if (!settingsRow) return null;
  return {
    deltaTargetMin: Number(settingsRow.delta_target_min),
    deltaTargetMax: Number(settingsRow.delta_target_max),
    dteTargetMin: Number(settingsRow.dte_target_min),
    dteTargetMax: Number(settingsRow.dte_target_max),
  };
}
