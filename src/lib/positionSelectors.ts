// The position figures of positionQueries.ts (positionSelect, fetchAvailableUncoveredShares) and positionExposure.ts
// (computeCashLockedInCsps) as pure functions over plain rows. The SQL stays the source for the platform; these mirror it
// branch for branch so that a book held in memory (the backtest's simulated ledger) reads the same figures, and
// positionSelectors.db.test.ts runs both on the same rows.
//
//   leg realized P&L   = (exit − entry) × quantity × multiplier × (short ? −1 : 1) − Σ commission of its closing trades
//   position realized  = Σ over legs with an exit price, split into option legs (premium) and stock legs (stock)
//   capitalAtRisk      = hedge: Σ entry × multiplier × quantity of its option legs
//                        an open stock leg: its entry × quantity − Σ entry × multiplier × quantity of the open short calls
//                        else: (strike − premium received) × multiplier × quantity of the open option leg, else the latest
//   capitalDeployed    = hedge: as above
//                        ever held stock: Σ entry × quantity of every stock leg − the premium of every slice of the short
//                          call contract chosen as above
//                        else: Σ (strike − premium received) × multiplier × quantity over every slice of the chosen contract
//   free shares        = Σ quantity of open long stock legs on the ticker's open unstructured positions
//   cash locked        = Σ over open cash-secured-put positions of strike × multiplier × quantity of the chosen option leg

export interface PositionLegFigures {
  id: string;
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  /** YYYY-MM-DD. */
  expiryDate: string | null;
  multiplier: number;
  entryPrice: number;
  entryAt: Date;
  exitPrice: number | null;
  exitAt: Date | null;
}

export interface PositionFigures {
  strategyKey: string;
  status: "open" | "closed";
  legs: readonly PositionLegFigures[];
}

export interface PositionRealizedPnl {
  total: number;
  /** Option legs only. */
  premium: number;
  /** Stock legs only. */
  stock: number;
}

const legSign = (leg: Pick<PositionLegFigures, "side">) => (leg.side === "short" ? -1 : 1);
const premiumReceivedPerShare = (leg: PositionLegFigures) => (leg.side === "short" ? leg.entryPrice : 0);
const isOpen = (leg: PositionLegFigures) => leg.exitAt === null;

/** A closed leg's realized P&L (legRealizedPnlSql); `closingCommissionDollars` is the sum over its closing trades, a missing commission as 0. */
export function legRealizedPnl(leg: Pick<PositionLegFigures, "side" | "quantity" | "multiplier" | "entryPrice"> & { exitPrice: number }, closingCommissionDollars: number): number {
  return (leg.exitPrice - leg.entryPrice) * leg.quantity * leg.multiplier * legSign(leg) - closingCommissionDollars;
}

/** positionSelect's realizedPnl, realizedPremiumPnl and realizedStockPnl: legs with an exit price only. */
export function positionRealizedPnl(legs: readonly PositionLegFigures[], closingCommissionDollarsByLegId: ReadonlyMap<string, number>): PositionRealizedPnl {
  const result: PositionRealizedPnl = { total: 0, premium: 0, stock: 0 };
  for (const leg of legs) {
    if (leg.exitPrice === null) continue;
    const realized = legRealizedPnl({ ...leg, exitPrice: leg.exitPrice }, closingCommissionDollarsByLegId.get(leg.id) ?? 0);
    result.total += realized;
    if (leg.legType === "option") result.premium += realized;
    else result.stock += realized;
  }
  return result;
}

/** The leg the SQL's `ORDER BY (exit_at IS NULL) DESC, entry_at DESC LIMIT 1` picks: the open one, else the latest entered. */
function chosenLeg(legs: readonly PositionLegFigures[]): PositionLegFigures | null {
  let chosen: PositionLegFigures | null = null;
  for (const leg of legs) {
    if (chosen === null || (isOpen(leg) && !isOpen(chosen)) || (isOpen(leg) === isOpen(chosen) && leg.entryAt.getTime() > chosen.entryAt.getTime())) chosen = leg;
  }
  return chosen;
}

const optionLegsOf = (legs: readonly PositionLegFigures[]) => legs.filter((leg) => leg.legType === "option");
const stockLegsOf = (legs: readonly PositionLegFigures[]) => legs.filter((leg) => leg.legType === "stock");
const shortCallLegsOf = (legs: readonly PositionLegFigures[]) => legs.filter((leg) => leg.legType === "option" && leg.optionType === "call" && leg.side === "short");

function hedgePremiumPaid(legs: readonly PositionLegFigures[]): number | null {
  const optionLegs = optionLegsOf(legs);
  return optionLegs.length === 0 ? null : optionLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.multiplier * leg.quantity, 0);
}

function optionCollateral(leg: PositionLegFigures): number | null {
  return leg.strikePrice === null ? null : (leg.strikePrice - premiumReceivedPerShare(leg)) * leg.multiplier * leg.quantity;
}

/** positionSelect's capitalAtRisk (EXP $): the capital exposed now, net of the premium received. Null when the position has nothing to measure. */
export function positionCapitalAtRisk(position: Pick<PositionFigures, "strategyKey" | "legs">): number | null {
  if (position.strategyKey === "hedge") return hedgePremiumPaid(position.legs);
  // The SQL takes one open stock leg (LIMIT 1, unordered): a position holds at most one.
  const openStockLeg = stockLegsOf(position.legs).find(isOpen);
  if (openStockLeg) {
    const openShortCallPremium = shortCallLegsOf(position.legs).filter(isOpen).reduce((sum, leg) => sum + leg.entryPrice * leg.multiplier * leg.quantity, 0);
    return openStockLeg.entryPrice * openStockLeg.quantity - openShortCallPremium;
  }
  const chosen = chosenLeg(optionLegsOf(position.legs));
  return chosen === null ? null : optionCollateral(chosen);
}

/** positionSelect's capitalDeployed (the P&L % base): capitalAtRisk plus what partial closes carved off and what the shares cost once they left. */
export function positionCapitalDeployed(position: Pick<PositionFigures, "strategyKey" | "legs">): number | null {
  if (position.strategyKey === "hedge") return hedgePremiumPaid(position.legs);
  const stockLegs = stockLegsOf(position.legs);
  if (stockLegs.length > 0) {
    const shortCalls = shortCallLegsOf(position.legs);
    const chosenCall = chosenLeg(shortCalls);
    const chosenCallPremium = chosenCall === null ? 0 : shortCalls.filter((leg) => leg.strikePrice !== null && leg.strikePrice === chosenCall.strikePrice && leg.expiryDate === chosenCall.expiryDate).reduce((sum, leg) => sum + leg.entryPrice * leg.multiplier * leg.quantity, 0);
    return stockLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity, 0) - chosenCallPremium;
  }
  const optionLegs = optionLegsOf(position.legs);
  const chosen = chosenLeg(optionLegs);
  if (chosen === null) return null;
  const sameContract = optionLegs.filter((leg) => leg.strikePrice !== null && leg.strikePrice === chosen.strikePrice && leg.expiryDate === chosen.expiryDate && leg.optionType !== null && leg.optionType === chosen.optionType);
  return sameContract.length === 0 ? null : sameContract.reduce((sum, leg) => sum + optionCollateral(leg)!, 0);
}

/** fetchAvailableUncoveredShares over one ticker's positions: shares in open long stock legs of its open unstructured positions. */
export function availableUncoveredShares(positionsOfTicker: readonly PositionFigures[]): number {
  let shares = 0;
  for (const position of positionsOfTicker) {
    if (position.status !== "open" || position.strategyKey !== "unstructured") continue;
    for (const leg of position.legs) if (leg.legType === "stock" && leg.side === "long" && isOpen(leg)) shares += leg.quantity;
  }
  return shares;
}

/** computeCashLockedInCsps over every position of the book: the full strike of each open cash-secured put, not net of premium. */
export function cashLockedInCashSecuredPuts(positions: readonly PositionFigures[]): number {
  let locked = 0;
  for (const position of positions) {
    if (position.status !== "open" || position.strategyKey !== "cash_secured_put") continue;
    const chosen = chosenLeg(optionLegsOf(position.legs));
    if (chosen !== null && chosen.strikePrice !== null) locked += chosen.strikePrice * chosen.multiplier * chosen.quantity;
  }
  return locked;
}
