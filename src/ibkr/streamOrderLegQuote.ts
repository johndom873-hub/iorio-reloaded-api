import type { OptionType } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { requestRealtimeMarketData } from "./requestMarketData.js";
import { fetchQuotesForContracts, type OptionQuote } from "./fetchOptionChain.js";

export interface DeltaComplianceResult {
  compliant: boolean;
  reason: string | null;
}

// Same Math.abs()/inclusive-bounds convention as generateTradeAlertCandidates.ts's
// rankCandidates (approved 2026-08-20) — reused, not reimplemented, so "in band"
// means the same thing here as it does for trade-alert screening. There it's a
// silent filter (out-of-band candidates are just skipped); here the result drives
// a user-facing block, so null/missing-threshold cases need an explicit reason
// rather than silently failing closed with no explanation.
export function checkDeltaCompliance(
  delta: number | null,
  deltaTargetMin: number | null,
  deltaTargetMax: number | null,
): DeltaComplianceResult {
  if (deltaTargetMin === null || deltaTargetMax === null) {
    return { compliant: false, reason: "No delta screening range is configured for this strategy." };
  }
  if (delta === null) {
    return {
      compliant: false,
      reason: "Live delta isn't available yet — can't verify this trade against the strategy's screening range.",
    };
  }
  const magnitude = Math.abs(delta);
  if (magnitude < deltaTargetMin) {
    return {
      compliant: false,
      reason: `Delta has drifted to ${magnitude.toFixed(2)}, below the strategy's ${deltaTargetMin}–${deltaTargetMax} target range.`,
    };
  }
  if (magnitude > deltaTargetMax) {
    return {
      compliant: false,
      reason: `Delta has drifted to ${magnitude.toFixed(2)}, above the strategy's ${deltaTargetMin}–${deltaTargetMax} target range.`,
    };
  }
  return { compliant: true, reason: null };
}

/**
 * Order Review panel's live bid/ask/Greeks for a single not-yet-confirmed
 * order's option leg (approved 2026-08-27, replacing the one-shot
 * fetchOrderLegQuote.ts) — streams for as long as `signal` stays unaborted,
 * same shape as streamTickerDetail.ts's live pricing/option-chain tasks:
 * connect once, keep the reqMktData subscription open via fetchQuotesForContracts's
 * `live` mode, and don't disconnect until the caller aborts (the route aborts
 * this the moment the SSE client disconnects).
 */
export async function streamOrderLegQuote(
  symbol: string,
  expiry: string,
  strike: number,
  right: OptionType,
  onQuote: (quote: OptionQuote) => void,
  signal: AbortSignal,
): Promise<void> {
  const connection = await connectToIbkrGateway();
  try {
    requestRealtimeMarketData(connection.ib);
    const [quote] = await fetchQuotesForContracts(connection.ib, symbol, [{ expiry, strike, right }], {
      onUpdate: (quotes) => onQuote(quotes[0]!),
      signal,
    });
    onQuote(quote!);
    if (!signal.aborted) {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  } finally {
    connection.disconnect();
  }
}
