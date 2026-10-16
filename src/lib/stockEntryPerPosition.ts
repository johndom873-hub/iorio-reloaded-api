// Each position's own cost for shares that several positions hold together (approved 2026-10-15).
//
// IBKR reports one average cost per stock contract, blended over every share held. When two covered calls on one ticker
// each own a slice of those shares, that average is wrong for both: INTC 200 shares assigned at $100.00 and 100 bought at
// $92.43 (+ $1.09 commission) both showed $97.4803. Each slice's cost is instead:
//   - its own opening fills, when they cover its shares: (sum of quantity x price + commissions) / quantity;
//   - else the cost it already carries, once it has been split this way (the flag on the leg);
//   - else an equal share of what is left of IBKR's total: (held shares x IBKR's average - the slices above) / their shares.
// A leg split this way keeps its own cost afterwards, even alone: after one sibling sells, IBKR's average reflects the lot
// it sold first (oldest first), not the lots each position bought, and taking it would lose the difference from the total.

const entryPriceDecimals = 4;

export interface OpeningFill {
  quantity: number;
  price: number;
  commission: number | null;
}

export interface PositionStockLeg {
  id: string;
  quantity: number;
  storedEntryPrice: number;
  fromPositionSplit: boolean;
  openingFills: OpeningFill[];
}

export type StockEntryAllocation =
  | { kind: "allocated"; entryPriceByLegId: Map<string, number>; driftPerShare: number }
  /** A lone split leg that gained shares beyond its own fills: its own cost is no longer known, so IBKR's average applies again. */
  | { kind: "ibkr_average"; reason: "shares_added" }
  /** no_known_cost: no leg has its own fills or a cost of its own yet, so the split would only repeat IBKR's average. */
  | { kind: "skipped"; reason: "share_count" | "no_known_cost" | "residual_not_positive" };

function roundEntryPrice(value: number): number {
  return Number(value.toFixed(entryPriceDecimals));
}

/** Cost per share of the leg's own opening fills, commissions included, when they cover its shares; else null. */
export function ownOpeningFillsCost(fills: OpeningFill[], legQuantity: number): number | null {
  const filledQuantity = fills.reduce((sum, fill) => sum + fill.quantity, 0);
  if (filledQuantity === 0 || filledQuantity < legQuantity) return null;
  const filledCost = fills.reduce((sum, fill) => sum + fill.quantity * fill.price + (fill.commission ?? 0), 0);
  return roundEntryPrice(filledCost / filledQuantity);
}

/**
 * Entry price per open stock leg of one contract. heldTotalCost is what IBKR holds valued at its (assigned-put corrected)
 * average cost; driftPerShare is how far the allocated legs sum away from it, which only a sibling's earlier sale explains.
 */
export function allocateStockEntryPerPosition(legs: PositionStockLeg[], heldShares: number, heldTotalCost: number): StockEntryAllocation {
  const legShares = legs.reduce((sum, leg) => sum + leg.quantity, 0);
  if (legShares !== heldShares) return { kind: "skipped", reason: "share_count" };

  if (legs.length === 1) {
    const [leg] = legs as [PositionStockLeg];
    const ownCost = ownOpeningFillsCost(leg.openingFills, leg.quantity);
    if (ownCost !== null) return { kind: "allocated", entryPriceByLegId: new Map([[leg.id, ownCost]]), driftPerShare: (ownCost * leg.quantity - heldTotalCost) / heldShares };
    if (leg.openingFills.length > 0) return { kind: "ibkr_average", reason: "shares_added" };
  }

  const entryPriceByLegId = new Map<string, number>();
  const residualLegs: PositionStockLeg[] = [];
  let allocatedCost = 0;
  for (const leg of legs) {
    const ownCost = ownOpeningFillsCost(leg.openingFills, leg.quantity);
    const knownCost = ownCost ?? (leg.fromPositionSplit ? leg.storedEntryPrice : null);
    if (knownCost === null) {
      residualLegs.push(leg);
      continue;
    }
    entryPriceByLegId.set(leg.id, knownCost);
    allocatedCost += knownCost * leg.quantity;
  }

  if (entryPriceByLegId.size === 0) return { kind: "skipped", reason: "no_known_cost" };
  if (residualLegs.length > 0) {
    const residualShares = residualLegs.reduce((sum, leg) => sum + leg.quantity, 0);
    const residualCostPerShare = (heldTotalCost - allocatedCost) / residualShares;
    if (!(Number.isFinite(residualCostPerShare) && residualCostPerShare > 0)) return { kind: "skipped", reason: "residual_not_positive" };
    for (const leg of residualLegs) {
      const residualEntryPrice = roundEntryPrice(residualCostPerShare);
      entryPriceByLegId.set(leg.id, residualEntryPrice);
      allocatedCost += residualEntryPrice * leg.quantity;
    }
  }

  return { kind: "allocated", entryPriceByLegId, driftPerShare: (allocatedCost - heldTotalCost) / heldShares };
}
