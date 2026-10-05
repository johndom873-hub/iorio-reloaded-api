import type { OptionType } from "@stoqey/ib";
import { streamPooledOptionQuotes } from "./pooledOptionQuotes.js";
import type { OptionQuote } from "./fetchOptionChain.js";

export interface DeltaComplianceResult {
  compliant: boolean;
  reason: string | null;
}

// Math.abs() of the delta against inclusive bounds (the convention approved
// 2026-08-20, same as the recovery-path candidate scan). The result drives a
// user-facing block, so null/missing-threshold cases need an explicit reason
// rather than silently failing closed with no explanation.
export function checkDeltaCompliance(
  delta: number | null,
  deltaTargetMin: number | null,
  deltaTargetMax: number | null,
): DeltaComplianceResult {
  if (deltaTargetMin === null || deltaTargetMax === null) {
    return { compliant: false, reason: "No delta band is configured in the trading settings." };
  }
  if (delta === null) {
    return {
      compliant: false,
      reason: "Live delta isn't available yet — can't verify this trade against the delta band.",
    };
  }
  const magnitude = Math.abs(delta);
  if (magnitude < deltaTargetMin) {
    return {
      compliant: false,
      reason: `Delta has drifted to ${magnitude.toFixed(2)}, below the ${deltaTargetMin}–${deltaTargetMax} delta band.`,
    };
  }
  if (magnitude > deltaTargetMax) {
    return {
      compliant: false,
      reason: `Delta has drifted to ${magnitude.toFixed(2)}, above the ${deltaTargetMin}–${deltaTargetMax} delta band.`,
    };
  }
  return { compliant: true, reason: null };
}

/**
 * Order Review panel's live bid/ask/Greeks for a single not-yet-confirmed
 * order's option leg (approved 2026-08-27, replacing the one-shot
 * fetchOrderLegQuote.ts) — streams for as long as `signal` stays unaborted,
 * via marketDataPool.ts's shared subscription (approved 2026-09-24 — the
 * same contract watched elsewhere, e.g. a held position in Pulse, now shares
 * this one line instead of opening a second).
 */
export async function streamOrderLegQuote(
  symbol: string,
  expiry: string,
  strike: number,
  right: OptionType,
  onQuote: (quote: OptionQuote) => void,
  signal: AbortSignal,
): Promise<void> {
  const [quote] = await streamPooledOptionQuotes([{ symbol, expiry, strike, right }], (quotes) => onQuote(quotes[0]!), signal);
  onQuote(quote!);
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}
