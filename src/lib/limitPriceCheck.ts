// The limit-price check (Marcelo 2026-10-05: mid-based, thresholds editable on Risk & Limits).
//
// Formula, per leg, against that leg's own live two-sided quote:
//   mid       = (bid + ask) / 2
//   allowance = max(maxDeviationPct / 100 * mid, minToleranceDollars)
//   a SELL leg is refused when its limit is below  mid - allowance  (selling too cheap)
//   a BUY  leg is refused when its limit is above  mid + allowance  (paying too much)
// Only the adverse direction is refused: selling above the mid or buying below it can only be a better price, and simply may not fill.
// Fails closed: a leg with no usable two-sided quote cannot be checked, so the order is refused. Each leg is judged on its own
// (stricter than a combo net, which a mispriced leg could hide in). Pure: the callers fetch the quotes (the web pool at confirm,
// an IBKR snapshot inside the worker at placement) and the tolerance (trading_settings).

export interface PriceCheckTolerance {
  maxDeviationPct: number;
  minToleranceDollars: number;
}

export interface PriceCheckLeg {
  /** How the leg reads in a refusal, e.g. "SELL 2 AAOI 2026-11-20 $100 put". */
  description: string;
  action: "BUY" | "SELL";
  limitPrice: number;
  /** The leg's live quote; null (or a side that is missing, negative, or crossed) means there is no usable two-sided quote. */
  quote: { bid: number | null; ask: number | null } | null;
}

export interface PriceCheckLegDetail {
  description: string;
  action: "BUY" | "SELL";
  limitPrice: number;
  bid: number | null;
  ask: number | null;
  mid: number | null;
  allowance: number | null;
  /** How much worse than the mid the limit is (0 when it is on the good side); null when there is no usable quote. */
  adverseDistance: number | null;
  ok: boolean;
}

export interface PriceCheckResult {
  blocked: boolean;
  reasons: string[];
  legs: PriceCheckLegDetail[];
}

const comparisonEpsilon = 1e-9;

function formatPrice(value: number): string {
  return value.toFixed(2);
}

export function usableQuote(quote: PriceCheckLeg["quote"]): { bid: number; ask: number } | null {
  if (!quote || quote.bid === null || quote.ask === null) return null;
  const { bid, ask } = quote;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid < 0 || ask <= 0 || ask < bid) return null;
  return { bid, ask };
}

export function evaluateLimitPrices(legs: PriceCheckLeg[], tolerance: PriceCheckTolerance): PriceCheckResult {
  const details: PriceCheckLegDetail[] = [];
  const reasons: string[] = [];
  for (const leg of legs) {
    const quote = usableQuote(leg.quote);
    if (!quote) {
      details.push({ description: leg.description, action: leg.action, limitPrice: leg.limitPrice, bid: leg.quote?.bid ?? null, ask: leg.quote?.ask ?? null, mid: null, allowance: null, adverseDistance: null, ok: false });
      reasons.push(`No live two-sided quote for ${leg.description}, so its limit price ${formatPrice(leg.limitPrice)} cannot be checked.`);
      continue;
    }
    const mid = (quote.bid + quote.ask) / 2;
    const allowance = Math.max((tolerance.maxDeviationPct / 100) * mid, tolerance.minToleranceDollars);
    const adverseDistance = Math.max(0, leg.action === "SELL" ? mid - leg.limitPrice : leg.limitPrice - mid);
    const ok = adverseDistance - allowance <= comparisonEpsilon;
    details.push({ description: leg.description, action: leg.action, limitPrice: leg.limitPrice, bid: quote.bid, ask: quote.ask, mid, allowance, adverseDistance, ok });
    if (!ok) {
      const direction = leg.action === "SELL" ? "below" : "above";
      reasons.push(
        `Limit price ${formatPrice(leg.limitPrice)} for ${leg.description} is ${formatPrice(adverseDistance)} ${direction} the live mid ${formatPrice(mid)} (bid ${formatPrice(quote.bid)}, ask ${formatPrice(quote.ask)}); at most ${formatPrice(allowance)} is allowed (${tolerance.maxDeviationPct}% of the mid, minimum $${formatPrice(tolerance.minToleranceDollars)}).`,
      );
    }
  }
  return { blocked: reasons.length > 0, reasons, legs: details };
}

/** The leg as an order line reads, from the stored payload leg: "SELL 2 AAOI 2026-11-20 $100 put" or "BUY 200 AAOI shares". */
export function describeOrderLegForPriceCheck(leg: { role: "stock" | "option"; action: string; symbol: string; quantity: number; strike?: number; expiry?: string; right?: "C" | "P" }): string {
  if (leg.role === "stock") return `${leg.action} ${leg.quantity} ${leg.symbol} shares`;
  const expiry = leg.expiry && /^\d{8}$/.test(leg.expiry) ? `${leg.expiry.slice(0, 4)}-${leg.expiry.slice(4, 6)}-${leg.expiry.slice(6, 8)}` : (leg.expiry ?? "?");
  return `${leg.action} ${leg.quantity} ${leg.symbol} ${expiry} $${leg.strike} ${leg.right === "C" ? "call" : "put"}`;
}
