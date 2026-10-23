import type { OpenCycleSummary } from "../../lib/cycleBreakEven.js";
import { easternIsoDate } from "../../lib/easternIsoDate.js";
import { formatWholeDollars } from "../../lib/formatWholeDollars.js";
import { impliedVolatilityFromPrice } from "../../lib/impliedVolatilitySurface.js";
import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { deltaFromQuoteMid } from "../../lib/quoteOwnDelta.js";
import type { BacktestAction, BacktestBaselineSettings, BacktestHedgeTotals } from "../backtestTypes.js";
import { sharesPerContract } from "./backtestBook.js";
import { baselineQuoteRejection, roundedStrike } from "./baselineSaleSteps.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { buyHedgePut, keepHedgePuts, sellHedgePut, takeKeptHedgePuts } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, optionSaleFillPrice } from "./ledger/ledgerFills.js";
import { ledgerFreeCash, ledgerKeptHedgeLegs, ledgerOpenHedgeLegs, ledgerRealizedPnl } from "./ledger/ledgerSelectors.js";
import { isSymbolFlat, legsOfPosition, positionsOfSymbol, requirePosition, type LedgerLeg, type SimulatedLedger } from "./ledger/simulatedLedger.js";

// The baseline wheel's hedge (Marcelo 2026-10-22): long Puts on the shares the entries bring in, sold as the ladder buys
// lower. At every look, for a symbol with hedgePutTenorDays above 0, before the sale steps:
//   1. a ladder Put assigned (a rung): as many hedge Puts are sold as its contracts, oldest first, locking in their gain
//      (the shares' average price has come down, so less hedge is needed)
//   2. shares that left (a Call assigned, shares sold): the Puts above what the shares still held get by the size rule
//      are sold, oldest first; every one once no share is held
//   3. a Put with hedgePutRollDaysLeft days or fewer to expiry: sold, and while shares are held as many bought again on
//      the rules below, the strike from the stock price
//   4. a Cash-Secured Put entry assigned: its Puts bought, the strike from the stock price or, with hedgePutStrikeFrom
//      "price_paid", from the assigned strike
// and after the sale steps, the Puts of the Covered Call entries made at the look, at the instant of their shares. A look
// whose hedge sales leave the symbol flat opens nothing new on it: the next cycle starts at the next look.
//
//   Puts for an entry = floor(ratio × the cycle's entry lots so far) − the Puts already bought for its entries
//     ratio = hedgePutCoveragePct ÷ 100, × min(1, (1 − s) ÷ (s × (rungs − S))) with hedgePutSize "rung_level": one rung's
//             contracts at its cap ÷ the lots of the shares' budget (s the ladder's share level, S its shock; 60% shares,
//             2 rungs and S 70% give 0.4 ÷ (0.6 × 1.3) = 0.51), fixed at the cycle's first purchase
//   Puts kept for the shares held = floor(ratio × their lots)
//   expiry  = the listed one nearest hedgePutTenorDays (a tie: the later), or the first at or after them; always more than
//             hedgePutRollDaysLeft days out
//   strike  = the listed strike nearest price × (1 − hedgePutBelowPricePct ÷ 100) with a usable quote (bid at least
//             $0.05, ask above it, spread within maxSpreadPctOfMid) and no short option on it
//   fill    = mid + λ × half-spread for a purchase, mid − λ × half-spread for a sale (the session's fill rule); $0.68 a
//             contract each way. No volume limit: long-dated Puts trade a few contracts a day, and the scores keep the
//             quoted ask size. A purchase is cut to the free cash.
// A sale needs an ask (a missing bid sells at the half-spread's share of the ask); a Put with no quote waits for a later
// look, and one still held at its expiry is settled at its intrinsic value (runBacktestSession.ts).
// With hedgeInBreakEven "included" the cycle's break-even counts the realized P&L H of the Puts sold in the cycle:
//   break-even = (acquisition cost − net premium − H) ÷ shares acquired, cash break-even = (… − disposals − H) ÷ shares held
//
// Fewer purchases (hedgePutTurnover, Marcelo 2026-10-22), D = hedgePutTurnoverDays:
//   keep_for_next_entry: step 2's Puts are kept instead of sold: they leave the cycle at their mark into a position of no
//     cycle (bookkeeping, no trade), so the cycle ends as it would without them. An entry takes kept Puts first, the
//     longest kept first, at the price they were kept at, and buys only what is missing. Kept Puts are sold once D days
//     have passed without an entry taking them, at hedgePutRollDaysLeft days or fewer to expiry, and at the look before a
//     split; Puts of a cycle that spans a split are sold, not kept (kept Puts never change scale).
//   keep_unless_far_below: the same, but an entry sells the kept Puts struck more than hedgePutFarBelowPct below its
//     strike reference instead of taking them.
//   wait_between_purchases: an entry's Puts are bought only once D days have passed since the last purchase (an entry's
//     or a roll's), and only as many as the shares then held get by the size rule; the rolls are never held back.
//
// The whole position (hedgePutCovers "position", Marcelo 2026-10-23), in place of steps 1–4 and the rules above: the Puts
// cover the shares held plus the shares the open short Puts would bring (the entry's and the ladder's rungs), so they are
// there before an assignment, not after. At every look, before the sale steps: kept Puts are sold near expiry or before a
// split; the cycle's Puts with hedgePutRollDaysLeft days or fewer to expiry are sold, and all of them at the look before a
// split; with no share and no short Put left, the Puts leave the cycle at their mark (kept, as above; sold when the cycle
// is on another scale) so that it ends. Then, and again after the sale steps, the Puts the position is missing are taken
// from the kept ones (on today's scale) and bought. Nothing is sold when a rung is assigned or shares leave: a Put beyond
// the position's size waits for its roll.
//   Puts wanted = floor(hedgePutCoveragePct ÷ 100 × (lots held + lots of the open short Puts))
//   staggered expiries: n = hedgePutStaggeredExpiries slots of width w = (T − hedgePutRollDaysLeft) ÷ n, T = hedgePutTenorDays;
//     slot k holds the Puts with (T − (k + 1)·w, T − k·w] days left (more than T: slot 0) and is owed floor(wanted ÷ n),
//     plus one for k < wanted mod n; each Put missing goes to the slot furthest below what it is owed (a tie: the longer
//     expiry), bought on the expiry nearest T − k·w days
//   Example: 360 days rolled at 90 left over 3 expiries (w = 90), 8 Puts wanted and none held: 3 at about 360 days, 3 at
//   270 and 2 at 180, so a third of them rolls each quarter.
//
// Strike by delta (hedgePutStrikeBy "delta", Marcelo 2026-10-23), in place of the strike rule above: of the expiry's Puts
// with a usable quote and no short option on them, the one whose own |delta| is nearest hedgePutAbsDelta (the IV of its
// mid, then Black-76 on the forward S·e^{rT}, T = days to expiry ÷ 365; a tie: the higher strike).
// No purchase while too dear (hedgePutPriceGate, Marcelo 2026-10-23): the Put chosen is not bought, and is tried again at
// the next look (Puts held are kept), when
//   cost_vs_typical_fall: mid ÷ S × 365 ÷ days to expiry > hedgePutCostFallShare × F; F, the typical yearly fall = the
//     median, over the windows of 252 daily closes ending every 21 sessions back within the last 1,260 before today, of
//     the deepest fall from a running high in the window (fewer than 252 closes: no gate)
//   iv_vs_history: the Put's IV > hedgePutIvMultiple × the median of the stock's daily IV (IBKR's) over the last 252
//     sessions with one before today (fewer than 126: no gate)
//   iv_vs_realized: the Put's IV > hedgePutIvMultiple × σ21 = the sample standard deviation of the last 21 daily log
//     returns before today × √252
//   with S the stock price and the Put's IV that of its mid as above; a measure that can't be worked out blocks nothing.
//   Example: a 1-year Put at $12 on a $100 stock costs 12% a year; with F 40% and 0.3 the limit is 12%: bought.

/** The long-dated Puts a look reads for the hedge (runBacktestSession.ts builds it from the symbol's file). */
export interface HedgePutQuoteSource {
  /** Every Put expiry listed that day, ascending. */
  listedExpiries(): readonly string[];
  /** The look's Puts of one expiry. */
  quotesOf(expiry: string): readonly SymbolFileQuote[];
}

type HedgeSettings = Pick<
  BacktestBaselineSettings,
  "hedgePutTenorDays" | "hedgePutExpiry" | "hedgePutStrikeFrom" | "hedgePutBelowPricePct" | "hedgePutSize" | "hedgePutCoveragePct" | "hedgePutRollDaysLeft" | "hedgePutCovers" | "hedgePutStaggeredExpiries" | "hedgePutStrikeBy" | "hedgePutAbsDelta" | "hedgePutPriceGate" | "hedgePutCostFallShare" | "hedgePutIvMultiple" | "hedgeInBreakEven" | "hedgePutTurnover" | "hedgePutTurnoverDays" | "hedgePutFarBelowPct" | "maxSpreadPctOfMid" | "putsWhenNoCall" | "ladderSharesPct" | "ladderRungs"
>;

/** A symbol's hedge across looks, kept beside its ledger. Shares and prices are on the ledger's (the cycle's) scale. */
interface HedgeSymbolState {
  /** The short Puts the sale steps sold as ladder rungs. */
  ladderPutLegIds: Set<string>;
  /** Assigned Puts already turned into hedge orders. */
  handledAssignedLegIds: Set<string>;
  /** The day the assignments were last read: settlements happen once a day, before its first look. */
  assignmentsReadOn: string | null;
  /** Entries whose Puts are still to be bought; `covered`: Puts already taken from the kept ones for it. */
  pendingEntries: { shares: number; pricePaid: number; reason: string; covered?: number }[];
  /** Contracts assigned rungs still have Puts to sell for. */
  rungContractsToSell: number;
  /** Puts sold near expiry still to be replaced (no Put was quoted at their look). */
  replacementsToBuy: number;
  /** The open cycle's ratio, fixed at its first purchase; null before. */
  cycleRatio: number | null;
  cycleEntryLots: number;
  cycleEntryPutsWanted: number;
  /** The hedge positions bought in the open cycle: their realized P&L is the cycle's. */
  cycleHedgePositionIds: Set<string>;
  /** The day of the symbol's last Put purchase, across cycles (the wait rule). */
  lastPurchaseOn: string | null;
  /** The price gate's measures, worked out once a day. */
  priceGateMeasures: { dateIso: string; typicalFall: number | null; medianImpliedVolatility: number | null; realizedVolatility: number | null } | null;
  /** The day a purchase the price gate held back was last noted (once a day). */
  priceGateNotedOn: string | null;
}

const stateByLedger = new WeakMap<SimulatedLedger, Map<string, HedgeSymbolState>>();

function hedgeStateOf(ledger: SimulatedLedger, symbol: string): HedgeSymbolState {
  let bySymbol = stateByLedger.get(ledger);
  if (!bySymbol) stateByLedger.set(ledger, (bySymbol = new Map()));
  let state = bySymbol.get(symbol);
  if (!state) bySymbol.set(symbol, (state = { ladderPutLegIds: new Set(), handledAssignedLegIds: new Set(), assignmentsReadOn: null, pendingEntries: [], rungContractsToSell: 0, replacementsToBuy: 0, cycleRatio: null, cycleEntryLots: 0, cycleEntryPutsWanted: 0, cycleHedgePositionIds: new Set(), lastPurchaseOn: null, priceGateMeasures: null, priceGateNotedOn: null }));
  return state;
}

export const hedgeIsOn = (baseline: Pick<BacktestBaselineSettings, "hedgePutTenorDays">): boolean => baseline.hedgePutTenorDays > 0;

/** Puts per 100 shares an entry brings in: the coverage, × the rung level's ratio with hedgePutSize "rung_level" and the ladder on (S the ladder's shock). */
export function hedgeCoverageRatio(settings: Pick<HedgeSettings, "hedgePutSize" | "hedgePutCoveragePct" | "putsWhenNoCall" | "ladderSharesPct" | "ladderRungs">, ladderShock: number | null): number {
  const coverage = settings.hedgePutCoveragePct / 100;
  if (settings.hedgePutSize !== "rung_level" || settings.putsWhenNoCall !== "reserve_ladder" || ladderShock === null) return coverage;
  const shareLevel = settings.ladderSharesPct / 100;
  return coverage * Math.min(1, (1 - shareLevel) / (shareLevel * (settings.ladderRungs - ladderShock)));
}

/** The expiry a Put is bought on: nearest the target days (a tie: the later) or the first at or after them, more than `minimumDaysOut` away; null when none is listed. */
export function hedgePutExpiry(listedExpiries: readonly string[], todayIso: string, settings: Pick<HedgeSettings, "hedgePutTenorDays" | "hedgePutExpiry" | "hedgePutRollDaysLeft">): string | null {
  const candidates = listedExpiries.map((expiry) => ({ expiry, days: daysToExpiry(expiry, todayIso) })).filter((candidate) => candidate.days > settings.hedgePutRollDaysLeft);
  if (settings.hedgePutExpiry === "first_at_or_after") return candidates.find((candidate) => candidate.days >= settings.hedgePutTenorDays)?.expiry ?? null;
  let best: { expiry: string; days: number } | null = null;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.days - settings.hedgePutTenorDays);
    if (best === null || distance < Math.abs(best.days - settings.hedgePutTenorDays) || (distance === Math.abs(best.days - settings.hedgePutTenorDays) && candidate.days > best.days)) best = candidate;
  }
  return best?.expiry ?? null;
}

/** The Put bought: the listed strike nearest the target with a usable quote and no short option on it (a tie: the higher strike); null when none. */
export function hedgePutQuote(quotes: readonly SymbolFileQuote[], targetStrike: number, maxSpreadPctOfMid: number, isTakenByShortOption: (strike: number) => boolean): SymbolFileQuote | null {
  let best: SymbolFileQuote | null = null;
  for (const quote of quotes) {
    if (quote.right !== "P" || baselineQuoteRejection(quote, maxSpreadPctOfMid) !== null || isTakenByShortOption(quote.strike)) continue;
    const distance = Math.abs(quote.strike - targetStrike);
    if (best === null || distance < Math.abs(best.strike - targetStrike) - 1e-9 || (Math.abs(distance - Math.abs(best.strike - targetStrike)) <= 1e-9 && quote.strike > best.strike)) best = quote;
  }
  return best;
}

/** The Put bought by delta: the one with a usable quote and no short option on it whose own |delta| is nearest the target (a tie: the higher strike); null when none has a delta. */
export function hedgePutQuoteByDelta(
  quotes: readonly SymbolFileQuote[],
  target: { stockPrice: number; yearsToExpiry: number; riskFreeRate: number; absDelta: number },
  maxSpreadPctOfMid: number,
  isTakenByShortOption: (strike: number) => boolean,
): { quote: SymbolFileQuote; absDelta: number } | null {
  let best: { quote: SymbolFileQuote; absDelta: number } | null = null;
  for (const quote of quotes) {
    if (quote.right !== "P" || baselineQuoteRejection(quote, maxSpreadPctOfMid) !== null || isTakenByShortOption(quote.strike)) continue;
    const delta = deltaFromQuoteMid({ bid: quote.bid, ask: quote.ask, spotPrice: target.stockPrice, strike: quote.strike, isCall: false, yearsToExpiry: target.yearsToExpiry, riskFreeRate: target.riskFreeRate });
    if (delta === null) continue;
    const absDelta = Math.abs(delta);
    const distance = Math.abs(absDelta - target.absDelta);
    const bestDistance = best === null ? Infinity : Math.abs(best.absDelta - target.absDelta);
    if (distance < bestDistance - 1e-12 || (Math.abs(distance - bestDistance) <= 1e-12 && quote.strike > best!.quote.strike)) best = { quote, absDelta };
  }
  return best;
}

/** The typical yearly fall: the median, over the windows of 252 closes ending every 21 sessions back within the last 1,260, of the deepest fall from a running high in the window; null with fewer than 252 closes. */
export function typicalYearlyFall(closesOldestFirst: readonly { close: number }[]): number | null {
  const count = closesOldestFirst.length;
  if (count < 252) return null;
  const falls: number[] = [];
  for (let end = count; end >= 252 && end > count - 1260; end -= 21) {
    let peak = closesOldestFirst[end - 252]!.close;
    let deepest = 0;
    for (let index = end - 252; index < end; index++) {
      const close = closesOldestFirst[index]!.close;
      if (close > peak) peak = close;
      deepest = Math.min(deepest, close / peak - 1);
    }
    falls.push(Math.abs(deepest));
  }
  return median(falls);
}

/** σ21: the sample standard deviation of the last 21 daily log returns × √252; null with fewer than 22 closes. */
export function realizedVolatility21(closesOldestFirst: readonly { close: number }[]): number | null {
  if (closesOldestFirst.length < 22) return null;
  const closes = closesOldestFirst.slice(-22).map((bar) => bar.close);
  const returns = closes.slice(1).map((close, index) => Math.log(close / closes[index]!));
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  return Math.sqrt((returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)) * 252);
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The cycle's break-even with the realized P&L of its hedge Puts in it (hedgeInBreakEven "included"); the summary as it is otherwise. */
export function withHedgeInBreakEven(summary: OpenCycleSummary | null, hedgeRealizedPnl: number): OpenCycleSummary | null {
  if (summary === null || summary.unavailableReason !== null || hedgeRealizedPnl === 0) return summary;
  const netPremium = summary.netPremium + hedgeRealizedPnl;
  return {
    ...summary,
    netPremium,
    breakEvenPerShare: summary.breakEvenPerShare === null ? null : (summary.acquisitionCost - netPremium) / summary.sharesAcquired,
    cashBreakEvenPerShare: summary.cashBreakEvenPerShare === null ? null : (summary.acquisitionCost - summary.disposalProceeds - netPremium) / summary.sharesHeld,
  };
}

/**
 * The hedge's Puts over a session, from the book: purchases and sales from the cash journal and the trades (exact across
 * a split, where a held Put's contracts and multiplier change), realized P&L as the platform counts a position's, the Puts
 * still held at the marks given, and half the quoted spread of every order (the actions' scores).
 */
export function summarizeHedge(ledger: SimulatedLedger, actions: readonly BacktestAction[], priceByLegId: ReadonlyMap<string, number>): BacktestHedgeTotals {
  const hedgePositionIds = new Set(ledger.positions.filter((position) => position.strategyKey === "hedge").map((position) => position.id));
  const hedgeLegs = ledger.legs.filter((leg) => hedgePositionIds.has(leg.positionId));
  const hedgeLegIds = new Set(hedgeLegs.map((leg) => leg.id));
  const trades = ledger.trades.filter((trade) => hedgeLegIds.has(trade.legId));
  const journalOf = (kind: "hedge_purchase" | "hedge_sale") => ledger.cashJournal.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + entry.amount, 0);
  const openings = trades.filter((trade) => !trade.isClosingTrade);
  const closings = trades.filter((trade) => trade.isClosingTrade);
  const openLegs = hedgeLegs.filter((leg) => leg.exitAt === null && ledger.positions.find((position) => position.id === leg.positionId)?.status === "open");
  const hedgeActions = actions.filter((action) => action.kind === "buy_hedge" || action.kind === "sell_hedge");
  const keptPositionIds = new Set(ledger.positions.filter((position) => position.strategyKey === "hedge" && position.keptSince !== undefined).map((position) => position.id));
  const keptLegs = hedgeLegs.filter((leg) => keptPositionIds.has(leg.positionId));
  const contractsOf = (legs: readonly LedgerLeg[]) => legs.reduce((sum, leg) => sum + leg.quantity, 0);
  return {
    purchases: openings.length,
    contractsBought: openings.reduce((sum, trade) => sum + trade.quantity, 0),
    costDollars: -journalOf("hedge_purchase") + openings.reduce((sum, trade) => sum + trade.commission, 0),
    sales: closings.length,
    contractsSold: closings.reduce((sum, trade) => sum + trade.quantity, 0),
    proceedsDollars: journalOf("hedge_sale") - closings.reduce((sum, trade) => sum + trade.commission, 0),
    realizedPnlDollars: [...hedgePositionIds].reduce((sum, positionId) => sum + ledgerRealizedPnl(ledger, positionId).total, 0),
    openContracts: openLegs.reduce((sum, leg) => sum + leg.quantity, 0),
    openCostDollars: openLegs.reduce((sum, leg) => sum + leg.entryPrice * leg.quantity * leg.multiplier, 0),
    openMarkDollars: openLegs.reduce((sum, leg) => sum + (priceByLegId.get(leg.id) ?? leg.entryPrice) * leg.quantity * leg.multiplier, 0),
    halfSpreadDollars: hedgeActions.reduce((sum, action) => sum + Number(action.candidateScores?.halfSpreadDollars ?? 0), 0),
    ...(keptPositionIds.size === 0
      ? {}
      : {
          keptContracts: contractsOf(keptLegs),
          keptContractsTaken: contractsOf(keptLegs.filter((leg) => leg.exitedBy === "taken_into_cycle")),
          keptContractsSold: contractsOf(keptLegs.filter((leg) => leg.exitAt !== null && leg.exitedBy === undefined)),
          keptRealizedPnlDollars: [...keptPositionIds].reduce((sum, positionId) => sum + ledgerRealizedPnl(ledger, positionId).total, 0),
        }),
  };
}

/** The session note on the hedge's Puts. */
export function describeHedgeTotals(totals: BacktestHedgeTotals): string {
  const open = totals.openContracts > 0 ? `; ${totals.openContracts.toLocaleString("en-US")} contract(s) still held at the end, cost ${formatWholeDollars(totals.openCostDollars)}, marked at ${formatWholeDollars(totals.openMarkDollars)}` : "; none held at the end";
  const kept =
    totals.keptContracts === undefined
      ? ""
      : ` Kept between cycles: ${totals.keptContracts.toLocaleString("en-US")} contract(s), ${(totals.keptContractsTaken ?? 0).toLocaleString("en-US")} taken by a later entry, ${(totals.keptContractsSold ?? 0).toLocaleString("en-US")} sold while kept for ${formatWholeDollars(totals.keptRealizedPnlDollars ?? 0)} of realized P&L that is in no cycle.`;
  return `Hedge: ${totals.purchases.toLocaleString("en-US")} Put purchase(s) (${totals.contractsBought.toLocaleString("en-US")} contracts) cost ${formatWholeDollars(totals.costDollars)} with commissions; ${totals.sales.toLocaleString("en-US")} sale(s) (${totals.contractsSold.toLocaleString("en-US")} contracts) brought ${formatWholeDollars(totals.proceedsDollars)}; realized P&L ${formatWholeDollars(totals.realizedPnlDollars)}${open}. Filled at the session's fill rule; half the quoted spreads came to ${formatWholeDollars(totals.halfSpreadDollars)}.${kept}`;
}

/** One symbol's look, as the hedge reads and writes it (runBaselineLook builds it). */
export interface BaselineHedgeLook {
  ledger: SimulatedLedger;
  symbol: string;
  baseline: HedgeSettings;
  todayIso: string;
  lookTimeEt: string;
  at: Date;
  /** The look's stock price, as traded today. */
  stockPrice: number;
  /** r: a price as traded today × r is on the ledger's scale. */
  priceToCycleScale: number;
  sharesPerContractOnCycleScale: number;
  /** λ: the share of the half-spread a fill gives up. */
  spreadShareCharged: number;
  quotes: HedgePutQuoteSource | null;
  /** The shares held, as traded today. */
  heldSharesToday(): number;
  /** The ladder's shock S for a purchase now (the cycle's once its ladder started); null without the ladder. */
  ladderShock(): number | null;
  /** The sale steps may not sell a contract the hedge holds: it is noted with them. */
  noteHeldContract(contract: { expiry: string; strike: number }): void;
  /** A split takes effect at the session after this one: kept Puts are sold now (they never change scale). */
  splitBeforeNextSession: boolean;
  /** The day's risk-free rate (a decimal): the Puts' IV and delta. */
  riskFreeRate: number;
  /** IBKR's split-adjusted daily closes before today, oldest first: the price gate's falls and realized volatility. */
  pastDailyCloses: readonly { close: number }[];
  /** The stock's daily IV (IBKR's, a decimal) over the last 252 sessions with one before today, oldest first. */
  pastImpliedVolatilities(): readonly number[];
  priceByLegId: Map<string, number>;
  nextActionId(): string;
  actions: BacktestAction[];
  summaries: string[];
}

/** The hedge of one symbol at a look (one per symbol and look, created only when the hedge is on). */
export class BaselineHedgeSteps {
  private readonly state: HedgeSymbolState;

  constructor(private readonly look: BaselineHedgeLook) {
    this.state = hedgeStateOf(look.ledger, look.symbol);
  }

  /** A Put the sale steps sold as a ladder rung (its assignment sells hedge Puts). */
  noteLadderPut(legId: string): void {
    this.state.ladderPutLegIds.add(legId);
  }

  /** Shares a Covered Call entry bought at this look (ledger scale), at the stock fill: their Puts are bought after the sale steps (the whole position's: counted there). */
  noteCoveredCallEntry(sharesBought: number, pricePaidOnCycleScale: number): void {
    if (sharesBought > 0 && !this.coversPosition()) this.state.pendingEntries.push({ shares: sharesBought, pricePaid: pricePaidOnCycleScale, reason: "Covered Call entry" });
  }

  /** The cycle's break-even with the hedge's realized P&L, with hedgeInBreakEven "included". */
  breakEvenSummary(summary: OpenCycleSummary | null): OpenCycleSummary | null {
    if (this.look.baseline.hedgeInBreakEven !== "included") return summary;
    let realized = 0;
    for (const positionId of this.state.cycleHedgePositionIds) realized += ledgerRealizedPnl(this.look.ledger, positionId).total;
    return withHedgeInBreakEven(summary, realized);
  }

  /** Steps 1–4, before the sale steps. Returns true when its sales left the symbol flat: no entry at this look. */
  beforeSales(): boolean {
    const { ledger, symbol } = this.look;
    this.sellKeptPutsDue();
    if (isSymbolFlat(ledger, symbol)) {
      this.resetCycle();
      return false;
    }
    if (this.coversPosition()) return this.positionBeforeSales();
    let sold = false;
    this.readAssignments();
    // 1. The rungs assigned.
    if (this.state.rungContractsToSell > 0) {
      const heldContracts = this.heldHedgeContracts();
      if (heldContracts === 0) this.state.rungContractsToSell = 0;
      else {
        const wanted = Math.min(this.state.rungContractsToSell, heldContracts);
        const soldNow = this.sellOldestFirst(wanted, `rung assigned: ${this.state.rungContractsToSell} contract(s)`, "the ladder's rung was assigned: as many hedge Puts sold as its contracts, oldest first, locking in their gain");
        this.state.rungContractsToSell -= soldNow;
        if (this.heldHedgeContracts() === 0) this.state.rungContractsToSell = 0;
        sold ||= soldNow > 0;
      }
    }
    // 2. Shares that left: their Puts sold, or kept between cycles.
    const lotsHeld = this.lotsHeld();
    const putsForSharesHeld = Math.floor(this.ratio() * lotsHeld + 1e-9);
    const excess = this.heldHedgeContracts() - putsForSharesHeld;
    if (excess > 0) {
      const why = lotsHeld === 0 ? "no shares are held" : `${putsForSharesHeld} Put(s) left for the ${lotsHeld * sharesPerContract} shares held`;
      sold ||= (this.keepsPutsNow() ? this.keepOldestFirst(excess, why) : this.sellOldestFirst(excess, `shares left: ${why}`, "the shares the Puts covered left the cycle")) > 0;
    }
    // 3. Rolls: the replacements are bought once every Put due is sold (later looks retry one no Put was quoted for).
    for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
      const daysLeft = daysToExpiry(leg.expiryDate!, this.look.todayIso);
      if (daysLeft > this.look.baseline.hedgePutRollDaysLeft) continue;
      const contracts = leg.quantity;
      if (!this.sellLeg(leg, contracts, `${daysLeft} day(s) left`, `${this.look.baseline.hedgePutRollDaysLeft} days or fewer to expiry`)) continue;
      sold = true;
      this.state.replacementsToBuy += contracts;
    }
    if (sold && isSymbolFlat(ledger, symbol)) {
      this.resetCycle();
      return true;
    }
    if (this.state.replacementsToBuy > 0) {
      const room = Math.floor(this.ratio() * this.lotsHeld() + 1e-9) - this.heldHedgeContracts();
      const replacement = Math.min(this.state.replacementsToBuy, room);
      if (replacement <= 0 || this.buy(replacement, this.look.stockPrice, `${replacement} Put(s) sold near expiry`, "rolled: a Put held had reached the days left to roll at") !== null) this.state.replacementsToBuy = 0;
    }
    // 4. Cash-Secured Put entries assigned.
    this.buyPendingEntries();
    return false;
  }

  /** After the sale steps: the Puts of this look's Covered Call entries, or those the whole position is missing. */
  afterSales(): void {
    if (isSymbolFlat(this.look.ledger, this.look.symbol)) return;
    if (this.coversPosition()) this.topUpPosition();
    else this.buyPendingEntries();
  }

  private coversPosition(): boolean {
    return this.look.baseline.hedgePutCovers === "position";
  }

  /** The whole position before the sale steps: rolls and a split's sales, the cycle's end, then the Puts missing. True when the cycle ended here. */
  private positionBeforeSales(): boolean {
    const { ledger, symbol, baseline, todayIso } = this.look;
    let sold = false;
    for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
      const daysLeft = daysToExpiry(leg.expiryDate!, todayIso);
      if (this.look.splitBeforeNextSession) sold = this.sellLeg(leg, leg.quantity, "a split takes effect at the next session", "the position's Puts are sold before a split and bought again after it") || sold;
      else if (daysLeft <= baseline.hedgePutRollDaysLeft) sold = this.sellLeg(leg, leg.quantity, `${daysLeft} day(s) left`, `${baseline.hedgePutRollDaysLeft} days or fewer to expiry`) || sold;
    }
    const heldContracts = this.heldHedgeContracts();
    if (heldContracts > 0 && this.positionLots() === 0) {
      const why = "no shares or short Puts are held";
      sold = (this.canKeepNow() ? this.keepOldestFirst(heldContracts, why, "the position is gone") : this.sellOldestFirst(heldContracts, why, "the position the Puts covered is gone")) > 0 || sold;
    }
    if (sold && isSymbolFlat(ledger, symbol)) {
      this.resetCycle();
      return true;
    }
    this.topUpPosition();
    return false;
  }

  /** Buys the Puts the whole position is missing: the kept ones first (on today's scale only), then new ones over the staggered expiries. Not at the look before a split: its Puts are bought at the next session. */
  private topUpPosition(): void {
    if (this.look.splitBeforeNextSession) return;
    const wanted = this.positionPutsWanted();
    let missing = wanted - this.hedgeLotsToday();
    if (missing <= 0) return;
    const { stockPrice } = this.look;
    const describedPosition = `the position: ${this.lotsHeld() * sharesPerContract} shares and ${this.shortPutLotsToday()} short Put(s)`;
    if (this.look.priceToCycleScale === 1) missing -= this.takeKeptPuts(missing, stockPrice, describedPosition);
    if (missing <= 0) return;
    this.slotAllocation(wanted, missing).forEach((contracts, slot) => {
      if (contracts > 0) this.buy(contracts, stockPrice, describedPosition, "Puts on the whole position: the shares held and the shares its short Puts would bring", this.slotTargetDays(slot));
    });
  }

  /** floor(coverage × (lots held + lots of the open short Puts)). */
  private positionPutsWanted(): number {
    return Math.floor((this.look.baseline.hedgePutCoveragePct / 100) * this.positionLots() + 1e-9);
  }

  private positionLots(): number {
    return this.lotsHeld() + this.shortPutLotsToday();
  }

  /** The lots the open short Puts (the entry's and the ladder's) would bring, as traded today. */
  private shortPutLotsToday(): number {
    const { ledger, symbol } = this.look;
    let lots = 0;
    for (const position of positionsOfSymbol(ledger, symbol)) {
      if (position.status !== "open" || position.strategyKey !== "cash_secured_put") continue;
      for (const leg of legsOfPosition(ledger, position.id)) if (leg.legType === "option" && leg.side === "short" && leg.exitAt === null) lots += this.lotsOfLeg(leg);
    }
    return lots;
  }

  /** The cycle's hedge Puts in lots as traded today. */
  private hedgeLotsToday(): number {
    return ledgerOpenHedgeLegs(this.look.ledger, this.look.symbol).reduce((sum, leg) => sum + this.lotsOfLeg(leg), 0);
  }

  /** An option leg's contracts as traded today (a contract opened before a split covers more shares after it). */
  private lotsOfLeg(leg: LedgerLeg): number {
    return Math.round((leg.quantity * leg.multiplier * this.look.priceToCycleScale) / sharesPerContract);
  }

  private slotWidth(): number {
    const { hedgePutTenorDays, hedgePutRollDaysLeft, hedgePutStaggeredExpiries } = this.look.baseline;
    return (hedgePutTenorDays - hedgePutRollDaysLeft) / hedgePutStaggeredExpiries;
  }

  /** The staggered expiry a Put with these days left sits in: 0 the longest. */
  private slotOf(daysLeft: number): number {
    const { hedgePutTenorDays, hedgePutStaggeredExpiries } = this.look.baseline;
    return Math.min(hedgePutStaggeredExpiries - 1, Math.max(0, Math.floor((hedgePutTenorDays - daysLeft) / this.slotWidth())));
  }

  private slotTargetDays(slot: number): number {
    return Math.round(this.look.baseline.hedgePutTenorDays - slot * this.slotWidth());
  }

  /** The Puts to buy for each staggered expiry: one at a time to the slot furthest below what it is owed of `wanted` (a tie: the longer expiry). */
  private slotAllocation(wanted: number, missing: number): number[] {
    const slots = this.look.baseline.hedgePutStaggeredExpiries;
    const owedBeyondHeld = Array.from({ length: slots }, (_, slot) => Math.floor(wanted / slots) + (slot < wanted % slots ? 1 : 0));
    for (const leg of ledgerOpenHedgeLegs(this.look.ledger, this.look.symbol)) owedBeyondHeld[this.slotOf(daysToExpiry(leg.expiryDate!, this.look.todayIso))]! -= this.lotsOfLeg(leg);
    const allocation = Array<number>(slots).fill(0);
    for (let put = 0; put < missing; put++) {
      let neediest = 0;
      for (let slot = 1; slot < slots; slot++) if (owedBeyondHeld[slot]! > owedBeyondHeld[neediest]!) neediest = slot;
      allocation[neediest]! += 1;
      owedBeyondHeld[neediest]! -= 1;
    }
    return allocation;
  }

  private resetCycle(): void {
    Object.assign(this.state, { pendingEntries: [], rungContractsToSell: 0, replacementsToBuy: 0, cycleRatio: null, cycleEntryLots: 0, cycleEntryPutsWanted: 0, cycleHedgePositionIds: new Set<string>() });
  }

  private ratio(): number {
    return this.state.cycleRatio ?? hedgeCoverageRatio(this.look.baseline, this.look.ladderShock());
  }

  private lotsHeld(): number {
    return Math.floor(this.look.heldSharesToday() / sharesPerContract + 1e-9);
  }

  private heldHedgeContracts(): number {
    return ledgerOpenHedgeLegs(this.look.ledger, this.look.symbol).reduce((sum, leg) => sum + leg.quantity, 0);
  }

  /** The Puts settled since the day's last read: rungs to sell for, entries to buy for. */
  private readAssignments(): void {
    const { ledger, symbol, todayIso, priceToCycleScale } = this.look;
    if (this.state.assignmentsReadOn === todayIso) return;
    this.state.assignmentsReadOn = todayIso;
    for (const position of positionsOfSymbol(ledger, symbol)) {
      if (position.strategyKey !== "cash_secured_put" || position.closeReason !== "assigned") continue;
      for (const leg of legsOfPosition(ledger, position.id)) {
        if (leg.legType !== "option" || leg.settledAs !== "assigned" || this.state.handledAssignedLegIds.has(leg.id)) continue;
        this.state.handledAssignedLegIds.add(leg.id);
        const shares = leg.quantity * leg.multiplier;
        if (this.state.ladderPutLegIds.has(leg.id)) this.state.rungContractsToSell += Math.round((shares * priceToCycleScale) / sharesPerContract);
        else this.state.pendingEntries.push({ shares, pricePaid: leg.strikePrice!, reason: `Cash-Secured Put assigned at ${(leg.strikePrice! / priceToCycleScale).toFixed(2)}` });
      }
    }
  }

  private buyPendingEntries(): void {
    const { priceToCycleScale, stockPrice, baseline } = this.look;
    while (this.state.pendingEntries.length > 0) {
      if (this.waitingBetweenPurchases()) return; // the wait rule: tried again at a later look
      const entry = this.state.pendingEntries[0]!;
      const lots = Math.round((entry.shares * priceToCycleScale) / sharesPerContract);
      this.state.cycleRatio ??= this.ratio();
      const wantedSoFar = Math.floor(this.state.cycleRatio * (this.state.cycleEntryLots + lots) + 1e-9);
      let wanted = wantedSoFar - this.state.cycleEntryPutsWanted - (entry.covered ?? 0);
      // Once the wait is over, only the Puts the shares still held get.
      if (baseline.hedgePutTurnover === "wait_between_purchases") wanted = Math.min(wanted, Math.floor(this.ratio() * this.lotsHeld() + 1e-9) - this.heldHedgeContracts());
      const reference = baseline.hedgePutStrikeFrom === "price_paid" ? entry.pricePaid / priceToCycleScale : stockPrice;
      const describedEntry = `${entry.reason}: ${lots * sharesPerContract} shares`;
      if (wanted > 0 && this.keepRuleOn()) {
        const taken = this.takeKeptPuts(wanted, reference, describedEntry);
        entry.covered = (entry.covered ?? 0) + taken;
        wanted -= taken;
      }
      if (wanted > 0 && this.buy(wanted, reference, describedEntry, "Puts on the shares an entry brought in") === null) return; // no quote: tried again at the next look
      this.state.cycleEntryLots += lots;
      this.state.cycleEntryPutsWanted = wantedSoFar;
      this.state.pendingEntries.shift();
    }
  }

  private keepRuleOn(): boolean {
    return this.look.baseline.hedgePutTurnover === "keep_for_next_entry" || this.look.baseline.hedgePutTurnover === "keep_unless_far_below";
  }

  /** Whether step 2 keeps its Puts at this look: a keep rule on, the cycle on today's scale and no split at the next session. */
  private keepsPutsNow(): boolean {
    return this.keepRuleOn() && this.canKeepNow();
  }

  /** Puts can leave the cycle as kept ones (which never change scale): the cycle on today's scale and no split at the next session. */
  private canKeepNow(): boolean {
    return this.look.priceToCycleScale === 1 && !this.look.splitBeforeNextSession;
  }

  /** The wait rule: fewer than hedgePutTurnoverDays since the symbol's last purchase. */
  private waitingBetweenPurchases(): boolean {
    const { baseline, todayIso } = this.look;
    return baseline.hedgePutTurnover === "wait_between_purchases" && this.state.lastPurchaseOn !== null && daysToExpiry(todayIso, this.state.lastPurchaseOn) < baseline.hedgePutTurnoverDays;
  }

  /** Moves up to `contracts` of the cycle's hedge Puts, oldest first, out of the cycle at their marks; the contracts kept. */
  private keepOldestFirst(contracts: number, why: string, whatHappened = "shares left"): number {
    const { ledger, symbol, at, priceToCycleScale } = this.look;
    let kept = 0;
    for (const leg of ledgerOpenHedgeLegs(ledger, symbol)) {
      if (kept >= contracts) break;
      const quantity = Math.min(leg.quantity, contracts - kept);
      const markPrice = this.look.priceByLegId.get(leg.id) ?? leg.entryPrice;
      const { keptLegId } = keepHedgePuts(ledger, { legId: leg.id, contracts: quantity, markPrice, at });
      this.look.priceByLegId.set(keptLegId, markPrice);
      const contractLabel = describeOptionContract({ strike: leg.strikePrice! / priceToCycleScale, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, this.look.todayIso) });
      this.look.summaries.push(`${symbol}: kept ${quantity} × ${contractLabel} for the next entry at their mark ${(markPrice / priceToCycleScale).toFixed(2)} (${whatHappened}: ${why})`);
      kept += quantity;
    }
    return kept;
  }

  /** The kept Puts due for sale: past the days kept (not with the whole position covered), near expiry, or before a split (a Put with no quote waits). */
  private sellKeptPutsDue(): void {
    const { ledger, symbol, baseline, todayIso } = this.look;
    for (const { leg, keptSince } of ledgerKeptHedgeLegs(ledger, symbol)) {
      const daysKept = daysToExpiry(todayIso, easternIsoDate(keptSince));
      const daysLeft = daysToExpiry(leg.expiryDate!, todayIso);
      if (this.look.splitBeforeNextSession) this.sellLeg(leg, leg.quantity, "kept, a split takes effect at the next session", "kept Puts are sold before a split");
      else if (daysLeft <= baseline.hedgePutRollDaysLeft) this.sellLeg(leg, leg.quantity, `kept, ${daysLeft} day(s) left`, `${baseline.hedgePutRollDaysLeft} days or fewer to expiry`);
      else if (!this.coversPosition() && daysKept >= baseline.hedgePutTurnoverDays) this.sellLeg(leg, leg.quantity, `kept ${daysKept} days`, `no entry took the kept Puts within ${baseline.hedgePutTurnoverDays} days`);
    }
  }

  /**
   * Takes up to `contracts` kept Puts into the cycle, the longest kept first; with keep_unless_far_below, one struck more
   * than hedgePutFarBelowPct below `referencePrice` is sold instead. The contracts taken.
   */
  private takeKeptPuts(contracts: number, referencePrice: number, whatFor: string): number {
    const { ledger, symbol, baseline, at, priceToCycleScale } = this.look;
    const floorStrike = referencePrice * (1 - baseline.hedgePutFarBelowPct / 100);
    let taken = 0;
    for (const { leg } of ledgerKeptHedgeLegs(ledger, symbol)) {
      if (taken >= contracts) break;
      const strikeToday = leg.strikePrice! / priceToCycleScale;
      if (!this.coversPosition() && baseline.hedgePutTurnover === "keep_unless_far_below" && strikeToday < floorStrike) {
        this.sellLeg(leg, leg.quantity, `kept, struck below ${floorStrike.toFixed(2)} (${baseline.hedgePutFarBelowPct}% under ${referencePrice.toFixed(2)})`, `kept Puts struck more than ${baseline.hedgePutFarBelowPct}% below the new entry's price are sold`);
        continue;
      }
      const quantity = Math.min(leg.quantity, contracts - taken);
      const markPrice = this.look.priceByLegId.get(leg.id) ?? leg.entryPrice;
      const { positionId, legId } = takeKeptHedgePuts(ledger, { keptLegId: leg.id, contracts: quantity, at });
      this.state.cycleHedgePositionIds.add(positionId);
      this.look.priceByLegId.set(legId, markPrice);
      this.look.noteHeldContract({ expiry: leg.expiryDate!, strike: strikeToday });
      const contractLabel = describeOptionContract({ strike: strikeToday, right: "P", expiry: leg.expiryDate!, dte: daysToExpiry(leg.expiryDate!, this.look.todayIso) });
      this.look.summaries.push(`${symbol}: took ${quantity} kept × ${contractLabel} into the cycle for ${whatFor}, at the ${(leg.entryPrice / priceToCycleScale).toFixed(2)} they were kept at`);
      taken += quantity;
    }
    return taken;
  }

  /** Buys up to `contracts` Puts struck from `referencePrice` (as traded), on the expiry nearest `targetDays`; null when no Put is quoted (nothing bought), else the contracts bought. */
  private buy(contracts: number, referencePrice: number, whatFor: string, chosenBecause: string, targetDays = this.look.baseline.hedgePutTenorDays): number | null {
    const { ledger, symbol, baseline, todayIso, lookTimeEt, at, priceToCycleScale } = this.look;
    if (!this.look.quotes) return null;
    const expiry = hedgePutExpiry(this.look.quotes.listedExpiries(), todayIso, { ...baseline, hedgePutTenorDays: targetDays });
    if (expiry === null) return null;
    const dte = daysToExpiry(expiry, todayIso);
    const targetStrike = referencePrice * (1 - baseline.hedgePutBelowPricePct / 100);
    const isTaken = (strike: number) => this.isTakenByShortOption(expiry, strike);
    const byDelta = baseline.hedgePutStrikeBy === "delta" ? hedgePutQuoteByDelta(this.look.quotes.quotesOf(expiry), { stockPrice: this.look.stockPrice, yearsToExpiry: dte / 365, riskFreeRate: this.look.riskFreeRate, absDelta: baseline.hedgePutAbsDelta }, baseline.maxSpreadPctOfMid, isTaken) : null;
    const quote = baseline.hedgePutStrikeBy === "delta" ? (byDelta?.quote ?? null) : hedgePutQuote(this.look.quotes.quotesOf(expiry), targetStrike, baseline.maxSpreadPctOfMid, isTaken);
    if (quote === null) return null;
    const tooDear = this.priceGateBlock(quote, dte);
    if (tooDear !== null) {
      if (this.state.priceGateNotedOn !== todayIso) this.look.summaries.push(`${symbol}: no hedge Put bought for ${whatFor}: ${tooDear} (noted once a day)`);
      this.state.priceGateNotedOn = todayIso;
      return null;
    }
    const bid = quote.bid!;
    const ask = quote.ask!;
    const fill = optionPurchaseFillPrice(bid, ask, this.look.spreadShareCharged);
    const costPerContract = fill * sharesPerContract + optionCommissionDollars(1);
    const affordable = Math.floor(ledgerFreeCash(ledger) / costPerContract + 1e-9);
    const bought = Math.min(contracts, affordable);
    const contractLabel = describeOptionContract({ strike: quote.strike, right: "P", expiry, dte });
    if (bought < 1) {
      this.look.summaries.push(`${symbol}: no hedge Put bought for ${whatFor}: ${contracts} × ${contractLabel} @ ${fill.toFixed(2)} need more than the free cash`);
      return 0;
    }
    const actionId = this.look.nextActionId();
    const opened = buyHedgePut(ledger, { symbol, expiryDate: expiry, strike: quote.strike * priceToCycleScale, contracts: bought, fillPrice: fill * priceToCycleScale, at, actionId, sharesPerContract: this.look.sharesPerContractOnCycleScale });
    this.state.cycleHedgePositionIds.add(opened.positionId);
    this.state.lastPurchaseOn = todayIso;
    this.look.priceByLegId.set(opened.legId, ((bid + ask) / 2) * priceToCycleScale);
    this.look.noteHeldContract({ expiry, strike: quote.strike });
    const cutNote = bought < contracts ? `; ${contracts} wanted, cut to the free cash` : "";
    const strikeNote =
      byDelta !== null
        ? `, |delta| ${byDelta.absDelta.toFixed(2)} for ${baseline.hedgePutAbsDelta} at ${this.look.stockPrice.toFixed(2)}`
        : baseline.hedgePutBelowPricePct > 0
          ? `, strike ${baseline.hedgePutBelowPricePct}% below ${referencePrice.toFixed(2)}`
          : ` at ${referencePrice.toFixed(2)}`;
    const description = `${symbol} Buy ${contractLabel}${describeOrderSize(bought, fill)} (hedge for ${whatFor}${strikeNote}${cutNote})`;
    this.look.actions.push({
      actionId,
      tradingDate: todayIso,
      at: at.toISOString(),
      lookTimeEt,
      passNumber: 1,
      symbol,
      kind: "buy_hedge",
      candidateId: `${symbol}:hedge:${expiry}:${roundedStrike(quote.strike)}`,
      description,
      automatic: false,
      chosenBecause: `hedge: ${chosenBecause}`,
      outcome: "filled",
      blockReason: null,
      gateResults: [{ gate: "hedge", ok: true, detail: `${bought} contract(s); quoted ask size ${quote.askSize ?? "unknown"}` }],
      contract: { strategyKey: "hedge", expiry, strike: quote.strike, right: "P" },
      candidateScores: {
        bid,
        ask,
        bidSize: quote.bidSize,
        askSize: quote.askSize,
        dte,
        stockPrice: this.look.stockPrice,
        referencePrice,
        targetStrike,
        coverageRatio: this.coversPosition() ? baseline.hedgePutCoveragePct / 100 : (this.state.cycleRatio ?? this.ratio()),
        costDollars: fill * sharesPerContract * bought + optionCommissionDollars(bought),
        halfSpreadDollars: ((ask - bid) / 2) * sharesPerContract * bought,
        ...(this.coversPosition() ? { targetDays } : {}),
        ...(byDelta !== null ? { absDelta: byDelta.absDelta } : {}),
      },
      quantity: bought,
      limitPrice: fill,
      fillPrice: fill,
      positionIds: [opened.positionId],
    });
    this.look.summaries.push(`Hedged ${description}`);
    return bought;
  }

  /** Why the Put chosen is too dear to buy now (hedgePutPriceGate), or null; a measure that can't be worked out blocks nothing. */
  private priceGateBlock(quote: SymbolFileQuote, daysLeft: number): string | null {
    const { baseline, stockPrice, riskFreeRate } = this.look;
    if (baseline.hedgePutPriceGate === "off") return null;
    const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
    const mid = (quote.bid! + quote.ask!) / 2;
    const measures = this.priceGateMeasures();
    if (baseline.hedgePutPriceGate === "cost_vs_typical_fall") {
      if (measures.typicalFall === null) return null;
      const yearlyCost = (mid / stockPrice) * (365 / daysLeft);
      const limit = baseline.hedgePutCostFallShare * measures.typicalFall;
      return yearlyCost > limit ? `its yearly cost ${percent(yearlyCost)} is above ${baseline.hedgePutCostFallShare} × the typical yearly fall ${percent(measures.typicalFall)} = ${percent(limit)}` : null;
    }
    const years = daysLeft / 365;
    const impliedVolatility = impliedVolatilityFromPrice(mid, stockPrice * Math.exp(riskFreeRate * years), quote.strike, years, riskFreeRate, false);
    const fromHistory = baseline.hedgePutPriceGate === "iv_vs_history";
    const reference = fromHistory ? measures.medianImpliedVolatility : measures.realizedVolatility;
    if (impliedVolatility === null || reference === null) return null;
    const limit = baseline.hedgePutIvMultiple * reference;
    return impliedVolatility > limit ? `its IV ${percent(impliedVolatility)} is above ${baseline.hedgePutIvMultiple} × ${fromHistory ? "the median IV over 252 sessions" : "the 21-session realized volatility"} ${percent(reference)}` : null;
  }

  private priceGateMeasures(): NonNullable<HedgeSymbolState["priceGateMeasures"]> {
    const { todayIso, pastDailyCloses } = this.look;
    if (this.state.priceGateMeasures?.dateIso !== todayIso) {
      const volatilities = this.look.pastImpliedVolatilities();
      this.state.priceGateMeasures = {
        dateIso: todayIso,
        typicalFall: typicalYearlyFall(pastDailyCloses),
        medianImpliedVolatility: volatilities.length >= 126 ? median(volatilities) : null,
        realizedVolatility: realizedVolatility21(pastDailyCloses),
      };
    }
    return this.state.priceGateMeasures;
  }

  /** Sells up to `contracts` hedge Puts, oldest first; the contracts sold. */
  private sellOldestFirst(contracts: number, whatFor: string, chosenBecause: string): number {
    let sold = 0;
    for (const leg of ledgerOpenHedgeLegs(this.look.ledger, this.look.symbol)) {
      if (sold >= contracts) break;
      const quantity = Math.min(leg.quantity, contracts - sold);
      if (this.sellLeg(leg, quantity, whatFor, chosenBecause)) sold += quantity;
    }
    return sold;
  }

  /** Sells `contracts` of one hedge leg at the look's quote; false when it has none (the Put waits for a later look). */
  private sellLeg(leg: LedgerLeg, contracts: number, whatFor: string, chosenBecause: string): boolean {
    const { ledger, symbol, todayIso, lookTimeEt, at, priceToCycleScale } = this.look;
    const strike = roundedStrike(leg.strikePrice! / priceToCycleScale);
    const quote = this.look.quotes?.quotesOf(leg.expiryDate!).find((candidate) => roundedStrike(candidate.strike) === strike) ?? null;
    if (quote === null || quote.ask === null || !(quote.ask > 0) || (quote.bid !== null && quote.bid > quote.ask)) return false;
    const bid = quote.bid ?? 0;
    const fill = optionSaleFillPrice(bid, quote.ask, this.look.spreadShareCharged);
    const actionId = this.look.nextActionId();
    const positionId = leg.positionId;
    const { soldLegId } = sellHedgePut(ledger, { legId: leg.id, contracts, fillPrice: fill * priceToCycleScale, at, actionId });
    if (requirePosition(ledger, positionId).status === "open") this.look.priceByLegId.set(leg.id, ((bid + quote.ask) / 2) * priceToCycleScale);
    const realized = ledgerRealizedPnl(ledger, positionId);
    const soldLeg = legsOfPosition(ledger, positionId).find((positionLeg) => positionLeg.id === soldLegId)!;
    const realizedOfSale = (soldLeg.exitPrice! - soldLeg.entryPrice) * soldLeg.quantity * soldLeg.multiplier - optionCommissionDollars(contracts);
    const dte = daysToExpiry(leg.expiryDate!, todayIso);
    const contractLabel = describeOptionContract({ strike, right: "P", expiry: leg.expiryDate!, dte });
    const entryToday = leg.entryPrice / priceToCycleScale;
    const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, fill)} (hedge, ${whatFor}; bought at ${entryToday.toFixed(2)} with its commission, ${realizedOfSale >= 0 ? "gain" : "loss"} ${formatWholeDollars(Math.abs(realizedOfSale))})`;
    this.look.actions.push({
      actionId,
      tradingDate: todayIso,
      at: at.toISOString(),
      lookTimeEt,
      passNumber: 1,
      symbol,
      kind: "sell_hedge",
      candidateId: `${symbol}:hedge:${leg.expiryDate}:${strike}:${leg.id}`,
      description,
      automatic: false,
      chosenBecause: `hedge: ${chosenBecause}`,
      outcome: "filled",
      blockReason: null,
      gateResults: [{ gate: "hedge", ok: true, detail: whatFor }],
      contract: { strategyKey: "hedge", expiry: leg.expiryDate!, strike, right: "P" },
      candidateScores: { bid: quote.bid, ask: quote.ask, dte, stockPrice: this.look.stockPrice, entryPrice: entryToday, proceedsDollars: fill * sharesPerContract * contracts - optionCommissionDollars(contracts), realizedPnlDollars: realizedOfSale, positionRealizedPnlDollars: realized.total, halfSpreadDollars: ((quote.ask - bid) / 2) * sharesPerContract * contracts },
      quantity: contracts,
      limitPrice: fill,
      fillPrice: fill,
      positionIds: [positionId],
    });
    this.look.summaries.push(`Closed ${description}`);
    return true;
  }

  /** A short option or a kept Put held on the contract (one position per contract: the hedge cannot buy it). */
  private isTakenByShortOption(expiry: string, strike: number): boolean {
    const { ledger, symbol, priceToCycleScale } = this.look;
    return positionsOfSymbol(ledger, symbol).some(
      (position) =>
        position.status === "open" &&
        (position.strategyKey !== "hedge" || position.keptSince !== undefined) &&
        legsOfPosition(ledger, position.id).some((leg) => leg.legType === "option" && leg.exitAt === null && leg.expiryDate === expiry && Math.abs(leg.strikePrice! / priceToCycleScale - strike) < 0.0001),
    );
  }
}
