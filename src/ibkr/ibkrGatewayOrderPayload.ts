import { OptionType, OrderAction, SecType } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";

// Shared between src/routes/positions.ts (builds these payloads into
// order_requests rows) and src/ibkrGatewayWorker.ts (consumes them to place real IBKR
// orders). Deliberately its own module, not exported from ibkrGatewayWorker.ts —
// ibkrGatewayWorker.ts's top-level main() starts a persistent IBKR connection as a
// side effect of being imported, which must never happen inside the web
// process.

export interface OrderLegPayload {
  role: "stock" | "option";
  action: OrderAction.BUY | OrderAction.SELL;
  symbol: string;
  quantity: number; // shares for a stock leg, contracts for an option leg
  // Per-share (stock) or per-contract (option) limit price for this leg,
  // in the same units brokers normally quote (e.g. an option premium of
  // $2.50, not $250) — used only to derive the combo's net limit price via
  // computeNetLimitPrice; never sent to IBKR per-leg.
  unitPrice: number;
  strike?: number;
  expiry?: string; // YYYYMMDD
  right?: "C" | "P";
  ibkrContractId?: number; // pre-resolved when closing/rolling an already-tracked leg
  positionLegId?: string; // ties a closing leg back to its position_legs row
}

export interface OrderRequestPayload {
  symbol: string;
  strategyKey: string;
  legs: OrderLegPayload[];
}

export function buildLegContract(leg: OrderLegPayload): Contract {
  if (leg.role === "stock") {
    return { symbol: leg.symbol, secType: SecType.STK, exchange: "SMART", currency: "USD" };
  }
  return {
    symbol: leg.symbol,
    secType: SecType.OPT,
    exchange: "SMART",
    currency: "USD",
    lastTradeDateOrContractMonth: leg.expiry,
    strike: leg.strike,
    right: leg.right === "C" ? OptionType.Call : OptionType.Put,
    multiplier: 100,
  };
}

/**
 * Canonical net-limit-price convention for a combo (BAG) order placed with
 * top-level `order.action = OrderAction.BUY` (see ibkrGatewayWorker.ts's buildOrder):
 * sum each leg's unitPrice, positive for a BUY leg (money you pay) and
 * negative for a SELL leg (money you receive). A large negative result
 * means the combo is a net credit (you require IBKR to pay you at least
 * that much) — this is expected and correct for e.g. closing a covered
 * call (SELL stock dominates BUY-back-the-call).
 *
 * NEEDS REAL PAPER-ACCOUNT VERIFICATION before being trusted for an actual
 * trade — this is a best-effort implementation of IBKR's combo pricing
 * convention (per-share/contract unit prices summing to a net "per combo
 * unit" price), not something confirmed against a real fill yet. See the
 * plan doc's verification step 3.
 */
export function computeNetLimitPrice(legs: OrderLegPayload[]): number {
  return legs.reduce((sum, leg) => sum + (leg.action === OrderAction.BUY ? leg.unitPrice : -leg.unitPrice), 0);
}
