import type { OrderLimitsResult } from "../../lib/orderLimits.js";
import type { PlutoGateResult } from "../../pluto/ledger.js";
import type { SizingRoom } from "../../pluto/postModelGates.js";

// What a refused open means for the rest of its look when the session chooses again after a refusal
// (afterBlockedChoice: try_next; Marcelo 2026-10-12). A refusal that is about the chosen contract lets the next candidate
// be tried. A refusal that says the account has no room stops further opens where there is none: on the ticker when the
// limit is the ticker's, on every ticker when it is the book's. Rolls and closes are never stopped by it.

/** How far a refusal reaches: this contract only, every open on the ticker, or every open on the book. */
export type OpenRefusalScope = "candidate" | "ticker" | "book";

export interface OpenRefusal {
  scope: OpenRefusalScope;
  /** What there is no room in, for the day's summary; null for a refusal about the contract itself. */
  reason: string | null;
}

/** The limits of the order gate that an order broke. */
export interface OrderLimitBreaches {
  maxOrderSize: boolean;
  tickerConcentration: boolean;
  cashReserve: boolean;
}

/** Which of the order gate's three limits a refused order broke, from the figures it reports (the dollar comparisons of evaluateOrderLimitFigures). */
export function orderLimitBreachesOf(limits: OrderLimitsResult): OrderLimitBreaches {
  const details = limits.details;
  if (!limits.blocked || !details) return { maxOrderSize: false, tickerConcentration: false, cashReserve: false };
  const limitInDollars = (limitPercent: number) => (limitPercent * details.totalPortfolioValue) / 100;
  return {
    maxOrderSize: details.orderNotional > limitInDollars(details.limits.maxOrderPctOfPortfolio),
    tickerConcentration: details.concentrationAfterPct * details.totalPortfolioValue > limitInDollars(details.limits.maxConcentrationPerTickerPct),
    cashReserve: details.cashReserveAfterPct * details.totalPortfolioValue < limitInDollars(details.limits.minCashReservePct),
  };
}

export interface OpenRefusalInput {
  /** The gates that refused the open (PlutoGateResult.gate of each failed one). */
  failedGates: readonly Pick<PlutoGateResult, "gate">[];
  /** The book's room when the open was sized, and what one more contract would commit; null for a call on shares already held (it commits nothing). */
  sizing: { room: SizingRoom; dollarsPerContract: number } | null;
  /** The order gate's broken limits; null when the open did not reach it. */
  orderLimitBreaches: OrderLimitBreaches | null;
}

const widerOf = (a: OpenRefusal, b: OpenRefusal): OpenRefusal => {
  const rank: Record<OpenRefusalScope, number> = { candidate: 0, ticker: 1, book: 2 };
  return rank[b.scope] > rank[a.scope] ? b : a;
};

const aboutTheContract: OpenRefusal = { scope: "candidate", reason: null };

/** The sizing gate sized the open to zero: because the book has no room for one contract, or because of the contract's own caps. */
function classifySizingRefusal(sizing: OpenRefusalInput["sizing"]): OpenRefusal {
  // A call on held shares uses no room: only its own volume cap can size it to zero.
  if (sizing === null) return aboutTheContract;
  const { room, dollarsPerContract } = sizing;
  const fits = (roomDollars: number) => Math.floor(Math.max(0, roomDollars) / dollarsPerContract) >= 1;
  // The account's own limits first: no other ticker has room either.
  if (!fits(room.budgetRoom)) return { scope: "book", reason: "no capital budget left" };
  if (!fits(room.cashRoom)) return { scope: "book", reason: "no cash above the reserve" };
  // The ticker's: its exposure limit and its sector's (another ticker of the sector meets it on its own turn).
  if (!fits(room.tickerRoom)) return { scope: "ticker", reason: "no ticker room" };
  if (!fits(room.sectorRoom)) return { scope: "ticker", reason: "no sector room" };
  // About the contract: one contract larger than the order size (a lower strike may fit; Marcelo 2026-10-12), or room
  // for one but its own stress, Kelly or volume cap sized it to zero. Another contract may pass.
  return aboutTheContract;
}

/** Each gate an open can fail at, and how far its refusal reaches. */
function classifyGate(gate: string, input: OpenRefusalInput): OpenRefusal {
  switch (gate) {
    // The book is full: no ticker can add a position.
    case "open_positions_cap":
      return { scope: "book", reason: "the open-positions cap is reached" };
    // The ticker is waiting after a fill, or has an order working: no other contract of it passes.
    case "ticker_cooldown":
      return { scope: "ticker", reason: "the ticker is cooling down after a fill" };
    case "working_order":
      return { scope: "ticker", reason: "an order on the ticker is working" };
    case "sizing":
      return classifySizingRefusal(input.sizing);
    case "order_limits": {
      const breaches = input.orderLimitBreaches;
      // The cash reserve is the account's; the concentration limit the ticker's; the maximum position size is about
      // this order (a smaller contract may fit).
      if (breaches?.cashReserve) return { scope: "book", reason: "the order gate's cash reserve" };
      if (breaches?.tickerConcentration) return { scope: "ticker", reason: "the order gate's ticker concentration limit" };
      return aboutTheContract;
    }
    // About the chosen contract: its fresh re-score, its edge since the decision, a position already on it, the
    // break-even of the shares it covers, its limit price, a quote to build the order from. Another contract may pass.
    case "candidate_fresh":
    case "candidate_present":
    case "edge_drift":
    case "same_contract":
    case "break_even":
    case "limit_price":
    case "order_build":
    // The stand-in for the model always says trade, with full confidence: these never refuse.
    case "verdict":
    case "confidence_floor":
      return aboutTheContract;
    default:
      throw new Error(`The gate "${gate}" refused an open and has no rule for what the refusal stops.`);
  }
}

/** How far a refused open reaches: the widest of its failed gates. */
export function classifyOpenRefusal(input: OpenRefusalInput): OpenRefusal {
  return input.failedGates.map((failed) => classifyGate(failed.gate, input)).reduce(widerOf, aboutTheContract);
}
