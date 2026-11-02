import { OptionType } from "@stoqey/ib";
import { subscribeToPooledQuote, waitForFirstReading } from "../ibkr/marketDataPool.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import type { DeltaComplianceResult } from "../ibkr/streamOrderLegQuote.js";
import { yearsBetweenIsoDates } from "./impliedVolatilitySurface.js";
import { daysToExpiry } from "./optionContractLabel.js";
import { deltaFromQuoteMidOnForward, forwardFromAnchor, yearsToSessionClose } from "./quoteOwnDelta.js";
import type { OrderRequestForGates } from "./orderGates.js";
import type { StrategyBookInput } from "./orderLimits.js";

// The order gates' rules for a Pluto strategy order, Vol Farmer v4's (approved by Marcelo 2026-10-15 for the CC + Put
// Ladder, retired 2026-11-02; v4's ranges 2026-10-27), in place of the platform's delta band and its max-position and
// max-concentration limits (the cash reserve still applies):
//   delta  the contract's own delta from its live bid/ask (the mid's IV on the expiry's forward: the forward from the
//          band's own quotes moved with the live price, as the round chose it), inside the strategy's range, no tolerance
//          (|delta| 0.305 is refused against 0.30): a Call inside the Calls' |delta| range, a Put at most the Put |delta|.
//          A LEAPS has no |delta| check
//   pot    the ticker's exposure after the order (open positions, orders still working, this order) at most its pot:
//          allocation × Pluto's capital budget × the account's net liquidation value
//   book   every Pluto ticker's exposure and working orders together, after the order, at most Pluto's capital budget ×
//          the net liquidation value (Marcelo 2026-10-21; orderLimits.ts strategyBookCapitalVerdict)
// The route reads this context for an order whose Pluto action was taken under Vol Farmer v4 (strategyOrderGateContext.ts).

export interface StrategyOrderGateContext {
  /** The ticker's pot as a share of the account: its effective allocation × Pluto's capital budget (0.25 = 25%); null: no pot cap (Vol Farmer v4's LEAPS). */
  potFraction: number | null;
  /** False for an order with no |delta| range (Vol Farmer v4's LEAPS). */
  deltaChecked: boolean;
  /** Pluto's book: its enabled tickers and its capital budget as a share of the account. */
  book: StrategyBookInput;
  /** The order sells a Put: its own delta is held to the range like a Call's. */
  isEntryPut: boolean;
  /** The strategy's |delta| range for the order's right: the Calls' range, or 0 to the Put |delta|. */
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
const formatRange = (context: Pick<StrategyDeltaContext, "minAbsDelta" | "maxAbsDelta">) => `${context.minAbsDelta}–${context.maxAbsDelta}`;

/** The part of the context the delta verdict reads. */
export type StrategyDeltaContext = Pick<StrategyOrderGateContext, "minAbsDelta" | "maxAbsDelta" | "forwardAnchor" | "riskFreeRate" | "todayIso" | "closeMinutesEt">;

/** Pure: the verdict on one live quote. A Call, or a Put held to the range, must be inside it; a Put not held to it has its delta only recorded. */
export function strategyDeltaVerdict(input: { bid: number | null; ask: number | null; stockPrice: number | null; strike: number; expiryIso: string; isCall: boolean; putHeldToRange?: boolean; now: Date; context: StrategyDeltaContext }): DeltaComplianceResult & { delta: number | null } {
  const { context } = input;
  const heldToRange = input.isCall || input.putHeldToRange === true;
  if (input.stockPrice === null || !(input.stockPrice > 0)) {
    if (!heldToRange) return { compliant: true, delta: null, reason: null };
    return { compliant: false, delta: null, reason: "No live stock price to work out the contract's own delta, so the strategy's delta range can't be verified." };
  }
  const years = daysToExpiry(input.expiryIso, context.todayIso) <= 0 ? yearsToSessionClose(input.now, context.closeMinutesEt) : yearsBetweenIsoDates(context.todayIso, input.expiryIso);
  const forward = forwardFromAnchor(context.forwardAnchor ?? undefined, input.stockPrice, years, context.riskFreeRate);
  const delta = deltaFromQuoteMidOnForward({ bid: input.bid, ask: input.ask, spotPrice: input.stockPrice, forward, strike: input.strike, isCall: input.isCall, yearsToExpiry: years, riskFreeRate: context.riskFreeRate });
  if (!heldToRange) return { compliant: true, delta, reason: null };
  if (delta === null) return { compliant: false, delta: null, reason: `The contract's own delta can't be worked out from its live quote (bid ${input.bid ?? "none"}, ask ${input.ask ?? "none"}), so the strategy's ${formatRange(context)} delta range can't be verified.` };
  const magnitude = Math.abs(delta);
  if (magnitude < context.minAbsDelta) return { compliant: false, delta, reason: `The contract's own delta is ${magnitude.toFixed(3)}, below the strategy's ${formatRange(context)} delta range.` };
  if (magnitude > context.maxAbsDelta) return { compliant: false, delta, reason: `The contract's own delta is ${magnitude.toFixed(3)}, above the strategy's ${formatRange(context)} delta range.` };
  return { compliant: true, delta, reason: null };
}

export interface StrategyDeltaQuoteReader {
  /** The option's live bid and ask, waiting briefly for both. */
  optionQuote(contract: { symbol: string; expiry: string; strike: number; right: "C" | "P" }): Promise<{ bid: number | null; ask: number | null }>;
  stockPrice(symbol: string): Promise<number | null>;
  now(): Date;
}

export const pooledStrategyDeltaQuoteReader: StrategyDeltaQuoteReader = {
  async optionQuote(contract) {
    let quote: { bid: number | null; ask: number | null } = { bid: null, ask: null };
    let unsubscribe: (() => void) | null = null;
    const { settled, check } = waitForFirstReading(() => quote.bid !== null && quote.ask !== null);
    try {
      unsubscribe = await subscribeToPooledQuote({ key: "strategy-delta", legType: "option", symbol: contract.symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put }, (pooled) => {
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

/** The delta verdict of a strategy order's option leg; null for an order with no opening option leg (closes, rolls). */
export async function evaluateStrategyDeltaForOrderRequest(orderRequest: Pick<OrderRequestForGates, "request_type" | "payload">, context: StrategyOrderGateContext, reader: StrategyDeltaQuoteReader = pooledStrategyDeltaQuoteReader): Promise<DeltaComplianceResult | null> {
  if (!orderRequest.request_type.startsWith("open_") || !context.deltaChecked) return null;
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  if (!optionLeg?.strike || !optionLeg.expiry || !optionLeg.right) return null;
  // A Put not held to the range has nothing to read the live quote for.
  if (optionLeg.right === "P" && !context.isEntryPut) return { compliant: true, reason: null };
  try {
    const [quote, stockPrice] = await Promise.all([reader.optionQuote({ symbol: orderRequest.payload.symbol, expiry: optionLeg.expiry, strike: optionLeg.strike, right: optionLeg.right }), reader.stockPrice(orderRequest.payload.symbol)]);
    const { compliant, reason } = strategyDeltaVerdict({ ...quote, stockPrice, strike: optionLeg.strike, expiryIso: ibkrExpiryToIso(optionLeg.expiry), isCall: optionLeg.right === "C", putHeldToRange: context.isEntryPut, now: reader.now(), context });
    return { compliant, reason };
  } catch (error) {
    return { compliant: false, reason: `The live quote could not be read (${error instanceof Error ? error.message : String(error)}), so the strategy's ${formatRange(context)} delta range can't be verified.` };
  }
}
