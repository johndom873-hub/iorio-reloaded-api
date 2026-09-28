import { OptionType } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { subscribeToPooledQuote, waitForFirstReading } from "../ibkr/marketDataPool.js";
import { checkDeltaCompliance, type DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// Server-side delta band (gap fix 5 for Pluto, 2026-09-28). The Order Review panel has gated
// Confirm on the option leg's live delta being inside the strategy's screening range since
// 2026-08-27, but only in the browser. This runs the same check at the real transmit point,
// with the panel's exact semantics: opening orders only, fail closed when the delta is not
// available, the same checkDeltaCompliance the quote stream feeds the panel.

export interface OrderRequestForDeltaBand {
  request_type: string;
  payload: OrderRequestPayload;
}

export function isDeltaBandGated(orderRequest: OrderRequestForDeltaBand): boolean {
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  return Boolean(orderRequest.payload.strategyKey) && orderRequest.request_type.startsWith("open_") && Boolean(optionLeg?.strike && optionLeg.expiry && optionLeg.right);
}

/** Null when the order is not delta-gated (closes, rolls, no option leg); otherwise the panel's verdict from a live pooled delta. */
export async function evaluateDeltaBandForOrderRequest(orderRequest: OrderRequestForDeltaBand): Promise<DeltaComplianceResult | null> {
  if (!isDeltaBandGated(orderRequest)) return null;
  const { payload } = orderRequest;
  const optionLeg = payload.legs.find((leg) => leg.role === "option")!;

  const strategySettings = await db("strategy_settings").where({ strategy_key: payload.strategyKey }).first();
  const deltaTargetMin = strategySettings?.delta_target_min !== undefined && strategySettings?.delta_target_min !== null ? Number(strategySettings.delta_target_min) : null;
  const deltaTargetMax = strategySettings?.delta_target_max !== undefined && strategySettings?.delta_target_max !== null ? Number(strategySettings.delta_target_max) : null;

  let delta: number | null = null;
  let unsubscribe: (() => void) | null = null;
  const { settled, check } = waitForFirstReading(() => delta !== null);
  try {
    unsubscribe = await subscribeToPooledQuote(
      { key: "delta-band", legType: "option", symbol: payload.symbol, expiry: optionLeg.expiry, strike: optionLeg.strike, right: optionLeg.right === "C" ? OptionType.Call : OptionType.Put },
      (quote) => {
        if (quote.delta !== null) delta = quote.delta;
        check();
      },
    );
    await settled;
  } catch (error) {
    return { compliant: false, reason: `Live delta could not be read (${error instanceof Error ? error.message : String(error)}) — can't verify this trade against the strategy's screening range.` };
  } finally {
    unsubscribe?.();
  }
  return checkDeltaCompliance(delta, deltaTargetMin, deltaTargetMax);
}
