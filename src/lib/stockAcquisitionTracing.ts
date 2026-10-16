// What shares really traded at, traced through hand-overs over records already in hand: the database's
// (stockLegAcquisitionFills.ts) or a simulated ledger's (the backtest), so both give the same answer. Pure.

export interface StockAcquisition {
  /** Share-weighted execution price. */
  fillPrice: number;
  /** Commission paid per share on those executions (an assignment carries none). */
  commissionPerShare: number;
}

interface PositionStockFills {
  shares: number;
  value: number;
  commission: number;
}

const maximumHandOverDepth = 20;

/** The records the acquisition is traced through, from the database or a simulated ledger alike. */
export interface StockAcquisitionRecords {
  /** Stock buy fills that opened shares (not closing trades), by the position holding them. */
  buyFills: { positionId: string; quantity: number; price: number; commission: number | null }[];
  /** position_share_sources links. */
  shareSources: { positionId: string; sourcePositionId: string; sharesReceived: number | null }[];
  /** The short put of each cash-secured put position that was assigned. */
  assignedPuts: { positionId: string; strike: number; quantity: number; multiplier: number }[];
}

/** fetchStockAcquisitionByPositionId's tracing, over records already in hand. */
export function stockAcquisitionByPositionIdFromRecords(positionIds: string[], records: StockAcquisitionRecords): Map<string, StockAcquisition> {
  const result = new Map<string, StockAcquisition>();
  const ownFillsByPositionId = new Map<string, PositionStockFills>();
  for (const fill of records.buyFills) {
    const fills = ownFillsByPositionId.get(fill.positionId) ?? { shares: 0, value: 0, commission: 0 };
    fills.shares += fill.quantity;
    fills.value += fill.quantity * fill.price;
    fills.commission += fill.commission ?? 0;
    ownFillsByPositionId.set(fill.positionId, fills);
  }
  const sourcesByPositionId = new Map<string, { sourcePositionId: string; sharesReceived: number | null }[]>();
  for (const link of records.shareSources) {
    sourcesByPositionId.set(link.positionId, [...(sourcesByPositionId.get(link.positionId) ?? []), { sourcePositionId: link.sourcePositionId, sharesReceived: link.sharesReceived }]);
  }
  const assignedPutByPositionId = new Map<string, { strike: number; shares: number }>();
  for (const put of records.assignedPuts) assignedPutByPositionId.set(put.positionId, { strike: put.strike, shares: put.quantity * put.multiplier });

  // A position's shares: its own buy fills, else what its sources handed it (each at its own acquisition), else the
  // strike of the put whose assignment delivered them.
  const acquisitionOf = (positionId: string, depth: number, visiting: Set<string>): PositionStockFills | null => {
    const ownFills = ownFillsByPositionId.get(positionId);
    const sources = sourcesByPositionId.get(positionId) ?? [];
    if (ownFills && ownFills.shares > 0 && sources.length === 0) return ownFills;
    const assignedPut = assignedPutByPositionId.get(positionId);
    if (assignedPut && sources.length === 0) return { shares: assignedPut.shares, value: assignedPut.shares * assignedPut.strike, commission: 0 };
    if (depth >= maximumHandOverDepth || sources.length === 0) return ownFills ?? null;

    const combined: PositionStockFills = { shares: 0, value: 0, commission: 0 };
    if (ownFills) {
      combined.shares += ownFills.shares;
      combined.value += ownFills.value;
      combined.commission += ownFills.commission;
    }
    for (const { sourcePositionId, sharesReceived } of sources) {
      if (visiting.has(sourcePositionId)) continue;
      const source = acquisitionOf(sourcePositionId, depth + 1, new Set([...visiting, sourcePositionId]));
      if (!source || source.shares <= 0) continue;
      const shares = sharesReceived ?? source.shares;
      combined.shares += shares;
      combined.value += (source.value / source.shares) * shares;
      combined.commission += (source.commission / source.shares) * shares;
    }
    return combined.shares > 0 ? combined : null;
  };

  for (const positionId of positionIds) {
    const acquisition = acquisitionOf(positionId, 0, new Set([positionId]));
    if (acquisition && acquisition.shares > 0) result.set(positionId, { fillPrice: acquisition.value / acquisition.shares, commissionPerShare: acquisition.commission / acquisition.shares });
  }
  return result;
}
