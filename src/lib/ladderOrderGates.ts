import { OptionType } from "@stoqey/ib";
import { subscribeToPooledQuote, waitForFirstReading } from "../ibkr/marketDataPool.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import type { DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import { yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { daysToExpiry } from "./optionContractLabel.js";
import { deltaFromQuoteMidOnForward, forwardFromAnchor, yearsToSessionClose } from "./quoteOwnDelta.js";
import type { OrderRequestForGates } from "./orderGates.js";
import type { LadderBookInput } from "./orderLimits.js";

// The order gates' rules for a CC + Put Ladder order (approved by Marcelo 2026-10-15), in place of the platform's delta
// band and its max-position and max-concentration limits (the cash reserve still applies):
//   delta  the contract's own delta from its live bid/ask (the mid's IV on the expiry's forward: Pluto's 10:00 parity
//          forward moved with the live price, as the ladder chose it), inside the ticker's ladder range, no tolerance
//          (|delta| 0.305 is refused against 0.30); every opening Call, a call on held shares included, and a Cash-Secured
//          Put entry (the backtest keeps entry Puts inside the range). The ladder's Puts have no |delta| range (Marcelo
//          2026-10-16): the rung's cap bounds them, so their delta is recorded, never checked
//   pot    the ticker's exposure after the order (open positions, orders still working, this order) at most its pot:
//          allocation × Pluto's capital budget × the account's net liquidation value
//   book   every ladder ticker's exposure and working orders together, after the order, at most Pluto's capital budget ×
//          the net liquidation value (Marcelo 2026-10-21; orderLimits.ts ladderBookCapitalVerdict)
// The route reads this context for an order whose Pluto action was taken under the ladder (ladderOrderGateContext.ts).

export interface LadderOrderGateContext {
  /** The ticker's pot as a share of the account: its effective allocation × Pluto's capital budget (0.25 = 25%). */
  potFraction: number;
  /** The ladder's book: Pluto's enabled tickers and its capital budget as a share of the account. */
  book: LadderBookInput;
  /** The order is a Cash-Secured Put entry (its Pluto action's sale step): its own delta is held to the range like a Call's. */
  isEntryPut: boolean;
  /** The ticker's ladder |delta| range for Calls and entry Puts (its override, else the strategy's). */
  minAbsDelta: number;
  maxAbsDelta: number;
  /** Today's 10:00 forward for the order's expiry and the stock price it was fitted at; null without one. */
  forwardAnchor: { forward: number; spotPrice: number } | null;
  /** As a fraction (0.04 = 4%). */
  riskFreeRate: number;
  todayIso: string;
  /** Today's close, minutes after midnight Eastern. */
  closeMinutesEt: number;
}

const ibkrExpiryToIso = (expiry: string) => `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
const formatRange = (context: Pick<LadderDeltaContext, "minAbsDelta" | "maxAbsDelta">) => `${context.minAbsDelta}–${context.maxAbsDelta}`;

/** The part of the context the delta verdict reads. */
export type LadderDeltaContext = Pick<LadderOrderGateContext, "minAbsDelta" | "maxAbsDelta" | "forwardAnchor" | "riskFreeRate" | "todayIso" | "closeMinutesEt">;

/** Pure: the verdict on one live quote. A Call, or a Put held to the range (an entry Put), must be inside it; a ladder Put's delta is only recorded. */
export function ladderDeltaVerdict(input: { bid: number | null; ask: number | null; stockPrice: number | null; strike: number; expiryIso: string; isCall: boolean; putHeldToRange?: boolean; now: Date; context: LadderDeltaContext }): DeltaComplianceResult & { delta: number | null } {
  const { context } = input;
  const heldToRange = input.isCall || input.putHeldToRange === true;
  if (input.stockPrice === null || !(input.stockPrice > 0)) {
    if (!heldToRange) return { compliant: true, delta: null, reason: null };
    return { compliant: false, delta: null, reason: "No live stock price to work out the contract's own delta, so the ladder's delta range can't be verified." };
  }
  const years = daysToExpiry(input.expiryIso, context.todayIso) <= 0 ? yearsToSessionClose(input.now, context.closeMinutesEt) : yearsBetweenIsoDates(context.todayIso, input.expiryIso);
  const forward = forwardFromAnchor(context.forwardAnchor ?? undefined, input.stockPrice, years, context.riskFreeRate);
  const delta = deltaFromQuoteMidOnForward({ bid: input.bid, ask: input.ask, spotPrice: input.stockPrice, forward, strike: input.strike, isCall: input.isCall, yearsToExpiry: years, riskFreeRate: context.riskFreeRate });
  if (!heldToRange) return { compliant: true, delta, reason: null };
  if (delta === null) return { compliant: false, delta: null, reason: `The contract's own delta can't be worked out from its live quote (bid ${input.bid ?? "none"}, ask ${input.ask ?? "none"}), so the ladder's ${formatRange(context)} delta range can't be verified.` };
  const magnitude = Math.abs(delta);
  if (magnitude < context.minAbsDelta) return { compliant: false, delta, reason: `The contract's own delta is ${magnitude.toFixed(3)}, below the ladder's ${formatRange(context)} delta range.` };
  if (magnitude > context.maxAbsDelta) return { compliant: false, delta, reason: `The contract's own delta is ${magnitude.toFixed(3)}, above the ladder's ${formatRange(context)} delta range.` };
  return { compliant: true, delta, reason: null };
}

export interface LadderDeltaQuoteReader {
  /** The option's live bid and ask, waiting briefly for both. */
  optionQuote(contract: { symbol: string; expiry: string; strike: number; right: "C" | "P" }): Promise<{ bid: number | null; ask: number | null }>;
  stockPrice(symbol: string): Promise<number | null>;
  now(): Date;
}

export const pooledLadderDeltaQuoteReader: LadderDeltaQuoteReader = {
  async optionQuote(contract) {
    let quote: { bid: number | null; ask: number | null } = { bid: null, ask: null };
    let unsubscribe: (() => void) | null = null;
    const { settled, check } = waitForFirstReading(() => quote.bid !== null && quote.ask !== null);
    try {
      unsubscribe = await subscribeToPooledQuote({ key: "ladder-delta", legType: "option", symbol: contract.symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }, (pooled) => {
        quote = { bid: pooled.bid, ask: pooled.ask };
        check();
      });
      await settled;
    } finally {
      unsubscribe?.();
    }
    return quote;
  },
  stockPrice: async (symbol) => (await fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol }]))["stock"] ?? null,
  now: () => new Date(),
};

/** The delta verdict of a ladder order's option leg; null for an order with no opening option leg (closes, rolls). */
export async function evaluateLadderDeltaForOrderRequest(orderRequest: Pick<OrderRequestForGates, "request_type" | "payload">, context: LadderOrderGateContext, reader: LadderDeltaQuoteReader = pooledLadderDeltaQuoteReader): Promise<DeltaComplianceResult | null> {
  if (!orderRequest.request_type.startsWith("open_")) return null;
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  if (!optionLeg?.strike || !optionLeg.expiry || !optionLeg.right) return null;
  // The ladder's Puts have no |delta| range: nothing to read the live quote for. An entry Put is held to it.
  if (optionLeg.right === "P" && !context.isEntryPut) return { compliant: true, reason: null };
  try {
    const [quote, stockPrice] = await Promise.all([reader.optionQuote({ symbol: orderRequest.payload.symbol, expiry: optionLeg.expiry, strike: optionLeg.strike, right: optionLeg.right }), reader.stockPrice(orderRequest.payload.symbol)]);
    const { compliant, reason } = ladderDeltaVerdict({ ...quote, stockPrice, strike: optionLeg.strike, expiryIso: ibkrExpiryToIso(optionLeg.expiry), isCall: optionLeg.right === "C", putHeldToRange: context.isEntryPut, now: reader.now(), context });
    return { compliant, reason };
  } catch (error) {
    return { compliant: false, reason: `The live quote could not be read (${error instanceof Error ? error.message : String(error)}), so the ladder's ${formatRange(context)} delta range can't be verified.` };
  }
}
