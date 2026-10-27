import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// Which orders the delta band gates (deltaBandGate.ts), kept free of market-data imports so routes can ask without a feed.
// Opening orders with a strategy and a complete option leg. A covered call written entirely on shares already held (no
// stock leg) is not gated, whatever the origin (Marcelo, 2026-10-12): it adds no exposure, so the band's job of choosing
// which risk to take on does not apply. Nor is a LEAPS buy (Marcelo, 2026-10-27): the band is for the options sold.

export interface OrderRequestForDeltaBand {
  request_type: string;
  payload: OrderRequestPayload;
}

/** A covered call that buys no shares: every contract is written on shares the account already holds. */
export function writesCallOnHeldSharesOnly(payload: Pick<OrderRequestPayload, "strategyKey" | "legs">): boolean {
  return payload.strategyKey === "covered_call" && payload.legs.some((leg) => leg.role === "option") && !payload.legs.some((leg) => leg.role === "stock");
}

export function isDeltaBandGated(orderRequest: OrderRequestForDeltaBand): boolean {
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  return Boolean(orderRequest.payload.strategyKey) && orderRequest.payload.strategyKey !== "leaps" && orderRequest.request_type.startsWith("open_") && Boolean(optionLeg?.strike && optionLeg.expiry && optionLeg.right) && !writesCallOnHeldSharesOnly(orderRequest.payload);
}
