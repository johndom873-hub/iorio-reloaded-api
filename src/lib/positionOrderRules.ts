import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";

// Pure rules behind the positions routes' order building and live P&L, kept apart from the router so they can be tested without a server.

/**
 * Guards against a naked covered call: the short call legs must never cover more shares than the position holds long.
 * Over-coverage (more stock than the short calls need) is allowed, it is conservative. Only meaningful for covered_call;
 * a cash-secured put has no stock leg to cover against. Returns the refusal message, or null when the coverage is enough.
 */
export function validateCoveredCallCoverage(stockShares: number, shortCallCoveredShares: number): string | null {
  if (shortCallCoveredShares > stockShares) {
    return `Short call coverage (${shortCallCoveredShares} shares) exceeds stock held (${stockShares} shares) — this would leave the position naked.`;
  }
  return null;
}

/**
 * Prices go to IBKR on a one-cent grid. SMART-routed US options and combos accept any cent price, also above $3 on
 * non-penny classes; the per-exchange rule tables that list nickels and dimes do not apply to SMART. A third decimal is
 * rejected with error 110, and a combo's net price is the sum of its legs' unitPrices (computeNetLimitPrice), so every
 * leg is rounded, not just the total.
 */
export function roundToCents(price: number): number {
  return Math.round(price * 100) / 100;
}

/**
 * An option expiry as IBKR's YYYYMMDD: separators are stripped ("2026-08-28", "2026/08/28" and "20260828" all become
 * "20260828"). Returns null unless exactly eight digits remain, so a malformed date is refused when the order is built
 * rather than failing at the contract lookup after the human has already confirmed.
 */
export function normalizeExpiryDate(raw: string): string | null {
  const digitsOnly = raw.replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(digitsOnly) ? digitsOnly : null;
}

/**
 * Shares that in-flight covered-call open orders are already writing against without buying them: per order, the option
 * contracts times 100 minus the shares its stock leg buys, never below zero. Summed over the given payloads.
 */
export function sumSharesCommittedByCoveredCallPayloads(payloads: OrderRequestPayload[]): number {
  let committed = 0;
  for (const payload of payloads) {
    const optionContracts = payload.legs.filter((leg) => leg.role === "option").reduce((sum, leg) => sum + leg.quantity, 0);
    const stockShares = payload.legs.filter((leg) => leg.role === "stock").reduce((sum, leg) => sum + leg.quantity, 0);
    committed += Math.max(0, optionContracts * 100 - stockShares);
  }
  return committed;
}

/** An open position leg as the P&L queries select it (numeric columns arrive from Postgres as strings). */
export interface OpenLegForUnrealizedPnl {
  id: string;
  positionId: string;
  legType: string;
  side: string;
  quantity: number;
  multiplier: number;
  entryPrice: string | number;
}

export interface UnrealizedPnlByPosition {
  unrealizedByPositionId: Record<string, number | null>;
  premiumByPositionId: Record<string, number | null>;
  stockByPositionId: Record<string, number | null>;
  stockMarketValueByPositionId: Record<string, number | null>;
}

/**
 * Marks each position's open legs to the given prices: (price - entry) x quantity x multiplier, negated for a short leg.
 * Option legs add to the premium figure, stock legs to the stock figure and to the stock market value (price x shares).
 * A position with any open leg that has no price is null on all four figures: a partial sum would pass for a real number.
 * Every id in positionIds starts at 0, so a position with no open legs reads 0, not missing.
 */
export function computeUnrealizedPnlByPosition(
  positionIds: string[],
  openLegs: OpenLegForUnrealizedPnl[],
  pricesByLegId: Record<string, number | null>,
): UnrealizedPnlByPosition {
  const unrealizedByPositionId: Record<string, number | null> = {};
  const premiumByPositionId: Record<string, number | null> = {};
  const stockByPositionId: Record<string, number | null> = {};
  const stockMarketValueByPositionId: Record<string, number | null> = {};
  for (const positionId of positionIds) {
    unrealizedByPositionId[positionId] = 0;
    premiumByPositionId[positionId] = 0;
    stockByPositionId[positionId] = 0;
    stockMarketValueByPositionId[positionId] = 0;
  }
  for (const leg of openLegs) {
    if (unrealizedByPositionId[leg.positionId] === null) continue;
    const currentPrice = pricesByLegId[leg.id];
    if (currentPrice === null || currentPrice === undefined) {
      unrealizedByPositionId[leg.positionId] = null;
      premiumByPositionId[leg.positionId] = null;
      stockByPositionId[leg.positionId] = null;
      stockMarketValueByPositionId[leg.positionId] = null;
      continue;
    }
    const sign = leg.side === "short" ? -1 : 1;
    const entryPrice = Number(leg.entryPrice);
    const legPnl = (currentPrice - entryPrice) * leg.quantity * leg.multiplier * sign;
    unrealizedByPositionId[leg.positionId] = (unrealizedByPositionId[leg.positionId] ?? 0) + legPnl;
    if (leg.legType === "option") {
      premiumByPositionId[leg.positionId] = (premiumByPositionId[leg.positionId] ?? 0) + legPnl;
    } else {
      stockByPositionId[leg.positionId] = (stockByPositionId[leg.positionId] ?? 0) + legPnl;
      stockMarketValueByPositionId[leg.positionId] = (stockMarketValueByPositionId[leg.positionId] ?? 0) + currentPrice * leg.quantity;
    }
  }
  return { unrealizedByPositionId, premiumByPositionId, stockByPositionId, stockMarketValueByPositionId };
}
