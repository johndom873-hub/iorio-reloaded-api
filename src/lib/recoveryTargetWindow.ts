import { db } from "../db/connection.js";

/** The Recovery Path scan's delta band and expiry window, from trading_settings (edited on Risk & Limits). */
export interface RecoveryTargetWindow {
  deltaTargetMin: number;
  deltaTargetMax: number;
  dteTargetMin: number;
  dteTargetMax: number;
}

/** The scan's target window, or null when trading_settings has no row. */
export async function loadRecoveryTargetWindow(): Promise<RecoveryTargetWindow | null> {
  const settingsRow = await db("trading_settings").first("delta_target_min", "delta_target_max", "recovery_dte_min", "recovery_dte_max");
  if (!settingsRow) return null;
  return {
    deltaTargetMin: Number(settingsRow.delta_target_min),
    deltaTargetMax: Number(settingsRow.delta_target_max),
    dteTargetMin: Number(settingsRow.recovery_dte_min),
    dteTargetMax: Number(settingsRow.recovery_dte_max),
  };
}
