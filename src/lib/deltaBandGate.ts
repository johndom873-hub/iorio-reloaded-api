import { OptionType } from "@stoqey/ib";
import { subscribeToPooledQuote, waitForFirstReading } from "../ibkr/marketDataPool.js";
import { checkDeltaCompliance, type DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { loadRecoveryTargetWindow } from "./recoveryTargetWindow.js";

// The delta band at the real transmit point (and at order preview, for every origin). The Order Review panel has
// gated Confirm on the option leg's live delta being inside the band since 2026-08-27, but only in the browser;
// this runs the same check on the server with the panel's exact semantics: opening orders only, fail closed when
// the delta is not available, the same checkDeltaCompliance the quote stream feeds the panel. The band is the
// single one in trading_settings (the same band Signals and the Recovery Path scan use).

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

  let band: { deltaTargetMin: number; deltaTargetMax: number } | null;
  try {
    band = await loadRecoveryTargetWindow();
  } catch {
    band = null;
  }

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
    return { compliant: false, reason: `Live delta could not be read (${error instanceof Error ? error.message : String(error)}) — can't verify this trade against the delta band.` };
  } finally {
    unsubscribe?.();
  }
  return checkDeltaCompliance(delta, band?.deltaTargetMin ?? null, band?.deltaTargetMax ?? null);
}
