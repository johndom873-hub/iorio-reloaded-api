import type { BaselineCandidate, BaselineCommissions, BaselineLookBook, BaselineSaleStep } from "../backtest/engine/baselineSaleSteps.js";
import { availableUncoveredShares, cashLockedInCashSecuredPuts, positionCapitalAtRisk, type PositionFigures, type PositionLegFigures } from "../lib/positionSelectors.js";
import { summarizeOpenCycleFromRows, type CycleOptionLegRow, type CycleStockTradeRow, type OpenCycleSummaryRows } from "../lib/cycleInputRows.js";
import type { OpenCycleSummary } from "../lib/cycleBreakEven.js";
import { runningAverageShareCost } from "../lib/shareAverageCost.js";
import { sharesPerContract } from "../lib/optionFriction.js";

// The CC + Put Ladder's live book for one ticker at one look: the BaselineLookBook the shared sale steps
// (baselineSaleSteps.ts) read, over the ticker's positions, cycle and cash as the database holds them, through the same
// selectors the backtest's ledger uses (positionSelectors.ts, cycleInputRows.ts, shareAverageCost.ts). Each sale the steps
// plan at the look is applied to an in-memory copy at once, as the backtest's ledger fills it, so the next step sees it;
// the ladder's orders still working from earlier looks are applied the same way first (committed as if filled). The
// planned sales are collected for the order step. Pure: everything is read before the look.

export interface LadderSale {
  strategyKey: "cash_secured_put" | "covered_call";
  expiry: string;
  strike: number;
  right: "C" | "P";
  contracts: number;
  /** The option's limit per share. */
  optionPrice: number;
  /** Shares a covered call buys (a Covered Call entry); the rest of its shares are already held. 0 for a Put. */
  sharesBought: number;
  /** The stock's limit per share when shares are bought. */
  stockPrice: number;
}

export interface PlannedLadderSale extends LadderSale {
  /** The look's order it belongs to: a Call on held shares, the entry with the free cash, or a ladder Put. */
  step: BaselineSaleStep;
  candidate: BaselineCandidate;
  eligibleCount: number;
  chosenBecause: string;
  scores: Record<string, number | null>;
}

export interface LadderLookSnapshot {
  tickerId: string;
  at: Date;
  stockPrice: number;
  /** The ticker's open positions with their legs. */
  positions: readonly PositionFigures[];
  /** The ticker's short option legs, stock trades and open shares, as the break-even loader reads them. */
  cycleRows: OpenCycleSummaryRows;
  /** Pluto's free cash: what a new sale may commit, every open Put's strike already set aside. */
  freeCash: number;
  /** The whole account's value. */
  accountValue: number;
  /** The ticker's pot as a share of the account: allocation × Pluto's capital budget. */
  tickerWeight: number;
  commissions: BaselineCommissions;
  /** The ladder's orders still working, applied as filled before the look plans. */
  workingSales: readonly LadderSale[];
}

const contractKey = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${Math.round(contract.strike * 10_000) / 10_000}`;
const isOpenLeg = (leg: PositionLegFigures) => leg.exitAt === null;

export function createLadderLookBook(snapshot: LadderLookSnapshot): { book: BaselineLookBook; planned: PlannedLadderSale[] } {
  const positions: PositionFigures[] = snapshot.positions.map((position) => ({ ...position, legs: position.legs.map((leg) => ({ ...leg })) }));
  const optionRows: (CycleOptionLegRow & { positionCloseReason: string | null })[] = [...snapshot.cycleRows.optionRows];
  const stockTradeRows: CycleStockTradeRow[] = [...snapshot.cycleRows.stockTradeRows];
  let openStockShares = snapshot.cycleRows.openStockShares;
  let freeCash = snapshot.freeCash;
  let syntheticCount = 0;
  const planned: PlannedLadderSale[] = [];

  const heldContracts = new Set(positions.filter((position) => position.status === "open").flatMap((position) => position.legs.filter((leg) => leg.legType === "option" && isOpenLeg(leg) && leg.expiryDate !== null && leg.strikePrice !== null).map((leg) => contractKey({ expiry: leg.expiryDate!, strike: leg.strikePrice! }))));
  const openLongStockLegs = () => positions.filter((position) => position.status === "open").flatMap((position) => position.legs.filter((leg) => leg.legType === "stock" && leg.side === "long" && isOpenLeg(leg)));
  const shareMoves = () => [...stockTradeRows].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime()).map((trade) => ({ shares: trade.side === "buy" ? trade.quantity : -trade.quantity, price: trade.price }));
  const optionLeg = (sale: LadderSale, id: string): PositionLegFigures => ({ id, legType: "option", side: "short", quantity: sale.contracts, optionType: sale.right === "C" ? "call" : "put", strikePrice: sale.strike, expiryDate: sale.expiry, multiplier: sharesPerContract, entryPrice: sale.optionPrice, entryAt: snapshot.at, exitPrice: null, exitAt: null });
  const optionRow = (sale: LadderSale, id: string): CycleOptionLegRow & { positionCloseReason: string | null } => ({ id, positionId: id, tickerId: snapshot.tickerId, side: "short", optionType: sale.right === "C" ? "call" : "put", strike: sale.strike, quantity: sale.contracts, multiplier: sharesPerContract, entryPrice: sale.optionPrice, entryAt: snapshot.at, exitPrice: null, exitAt: null, expiryDate: sale.expiry, closingCommission: 0, hasClosingTrade: false, expiryClose: null, positionCloseReason: null });

  /** One sale filled in the copy: the position, the cycle's rows and the cash, as the backtest's ledger records it. */
  const apply = (sale: LadderSale) => {
    const id = `ladder-look-${++syntheticCount}`;
    const premium = sale.optionPrice * sharesPerContract * sale.contracts;
    const optionCommission = snapshot.commissions.option.perContractDollars("sell", sale.contracts) * sale.contracts;
    heldContracts.add(contractKey(sale));
    optionRows.push(optionRow(sale, id));
    if (sale.strategyKey === "cash_secured_put") {
      positions.push({ strategyKey: "cash_secured_put", status: "open", legs: [optionLeg(sale, id)] });
      freeCash += premium - optionCommission - sale.strike * sharesPerContract * sale.contracts;
      return;
    }
    // A covered call takes the uncovered shares first (oldest positions first), then buys the rest.
    let sharesFromHeld = sale.contracts * sharesPerContract - sale.sharesBought;
    let handedOverCost = 0;
    for (const position of positions) {
      if (sharesFromHeld <= 0) break;
      if (position.status !== "open" || position.strategyKey !== "unstructured") continue;
      for (const leg of position.legs) {
        if (sharesFromHeld <= 0 || leg.legType !== "stock" || leg.side !== "long" || !isOpenLeg(leg)) continue;
        const taken = Math.min(leg.quantity, sharesFromHeld);
        handedOverCost += taken * leg.entryPrice;
        leg.quantity -= taken;
        sharesFromHeld -= taken;
        if (leg.quantity === 0) leg.exitAt = snapshot.at;
      }
      if (position.legs.every((leg) => !isOpenLeg(leg))) position.status = "closed";
    }
    const sharesHeldUsed = sale.contracts * sharesPerContract - sale.sharesBought - sharesFromHeld;
    const stockCommission = snapshot.commissions.stock.perShareDollars("buy") * sale.sharesBought;
    const sharesInPosition = sharesHeldUsed + sale.sharesBought;
    const stockEntry = sharesInPosition > 0 ? (handedOverCost + sale.sharesBought * sale.stockPrice + stockCommission) / sharesInPosition : 0;
    positions.push({ strategyKey: "covered_call", status: "open", legs: [{ id: `${id}-stock`, legType: "stock", side: "long", quantity: sharesInPosition, optionType: null, strikePrice: null, expiryDate: null, multiplier: 1, entryPrice: stockEntry, entryAt: snapshot.at, exitPrice: null, exitAt: null }, optionLeg(sale, id)] });
    if (sale.sharesBought > 0) {
      stockTradeRows.push({ tickerId: snapshot.tickerId, at: snapshot.at, side: "buy", quantity: sale.sharesBought, price: sale.stockPrice, commission: stockCommission });
      openStockShares += sale.sharesBought;
    }
    freeCash += premium - optionCommission - sale.sharesBought * sale.stockPrice - stockCommission;
  };
  for (const sale of snapshot.workingSales) apply(sale);

  const heldSharesAverageCost = () => runningAverageShareCost(shareMoves());
  const heldSharesToday = () => openLongStockLegs().reduce((sum, leg) => sum + leg.quantity, 0);
  const book: BaselineLookBook = {
    freeShares: () => availableUncoveredShares(positions),
    freeCash: () => Math.max(0, freeCash),
    heldSharesAverageCost,
    heldSharesAverageCostToday: heldSharesAverageCost,
    heldSharesToday,
    latestShareAcquisitionPrice: () => [...stockTradeRows].filter((trade) => trade.side === "buy").sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0]?.price ?? null,
    openCycleSummary: (): OpenCycleSummary | null => summarizeOpenCycleFromRows(snapshot.tickerId, { optionRows, stockTradeRows, openStockShares }),
    openPutCollateral: () => cashLockedInCashSecuredPuts(positions),
    accountValueToday: () => snapshot.accountValue,
    tickerWeight: () => snapshot.tickerWeight,
    netLiquidationValue: () => snapshot.accountValue,
    openPositionsCapitalAtRisk: () => positions.filter((position) => position.status === "open").reduce((sum, position) => sum + (positionCapitalAtRisk(position) ?? 0), 0),
    hasOpenCashSecuredPut: () => positions.some((position) => position.status === "open" && position.strategyKey === "cash_secured_put"),
    isHeld: (contract) => heldContracts.has(contractKey(contract)),
    sell(strategyKey, candidate, contracts, eligibleCount, chosenBecause, _strikeLimit, buyEveryShare = false, extraScores = {}, step = strategyKey === "covered_call" ? "held_calls" : "ladder_put") {
      const sharesNeeded = contracts * sharesPerContract;
      const sharesBought = strategyKey === "covered_call" ? sharesNeeded - (buyEveryShare ? 0 : Math.min(availableUncoveredShares(positions), sharesNeeded)) : 0;
      const sale: LadderSale = { strategyKey, expiry: candidate.expiry, strike: candidate.strike, right: candidate.right, contracts, optionPrice: candidate.fillPrice, sharesBought, stockPrice: snapshot.stockPrice };
      apply(sale);
      planned.push({ ...sale, step, candidate, eligibleCount, chosenBecause, scores: extraScores });
    },
  };
  return { book, planned };
}
