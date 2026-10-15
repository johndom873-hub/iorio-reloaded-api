import { daysToExpiry, describeOptionContract, describeOrderSize } from "../../lib/optionContractLabel.js";
import { contractKey } from "../../lib/signalsLiveScoring.js";
import { regularCloseMinutesEt, varianceSessionsToExpiry } from "../../lib/varianceClock.js";
import { selectModelVolatilityForecast } from "../../lib/volatilityEdge.js";
import { openCandidateId } from "../../pluto/candidateFilters.js";
import type { BacktestAction } from "../backtestTypes.js";
import { toOhlcvBars } from "./backtestBarHistory.js";
import { baselineShareFillPrice, makeBaselineSelector, planBaselineSales, roundedStrike, type BaselineCandidate, type BaselineLookBook, type BaselineModelInput } from "./baselineSaleSteps.js";
import { noteLadderLook } from "./backtestBaselineLadder.js";
import { sharesPerContract } from "./backtestBook.js";
import type { BacktestLookContext, BacktestLookResult, BacktestOptionSale } from "./backtestLook.js";
import type { SymbolFileQuote } from "./backtestSymbolFile.js";
import { captureLookTimeEt, earningsNotYetReported, forecastBarRowCount, lookInstantMs } from "./backtestTickerInputs.js";
import { buyBackCoveredCallKeepingShares, buyBackPut, closeCoveredCall, openCashSecuredPut, openCoveredCall, sellShares } from "./ledger/ledgerEvents.js";
import { optionCommissionDollars, optionPurchaseFillPrice, stockSaleFillPrice } from "./ledger/ledgerFills.js";
import { ledgerCapitalAtRisk, ledgerFreeCash, ledgerFreeShares, ledgerHeldSharesAverageCost, ledgerLatestShareAcquisitionPrice, ledgerNetLiquidationValue, ledgerOpenCycleSummary } from "./ledger/ledgerSelectors.js";
import { cycleSplitFactorFor, legsOfPosition, positionsOfSymbol, requireLeg } from "./ledger/simulatedLedger.js";

// The baseline wheel's look (decision maker "baseline", approved by Marcelo 2026-10-13): none of Pluto's rules and none
// of the Signals model, so each can later be added back and measured. At every look, for every symbol:
//   −1. with a share stop (shareStopLossPct > 0), once the price is that far below the cycle's cost per share acquired,
//      every share of the stock is sold at the look's price, a covered call closed whole (its call bought back);
//   0. with profit-taking on (takeProfitPct > 0), every open short option whose buyback keeps at least that share of its
//      premium (1 − buyback fill ÷ entry price, the entry net of its commission) is bought back; a covered call's call
//      alone, its shares kept. The contract is not sold again at the same look;
//   1. free round lots of shares get a call: the contract with the highest premium yield in the expiry range and the
//      calls' delta range (callDeltaRange: the entry's, or their own), by callStrike: any strike, or only at or above the
//      cycle's cost per share acquired, or its break-even after its premium, or the latest share acquisition's price, or
//      the average price paid for the shares held (ledgerHeldSharesAverageCost); on as many lots as the volume limit
//      allows. With callStrike "none", no call: the shares are held uncovered;
//   2. free cash goes into the entry with the highest premium yield in the same ranges: a cash-secured put, or 100
//      shares bought with a call sold on them (a buy-write; with entryCallStrike "above_purchase_price", the call at or
//      above the price paid for the shares; with "above_average_after_purchase", at or above the average price of the
//      shares held once these are bought), as many contracts as the cash, the stock's share of the account
//      (maxAccountPctPerStock: its open positions' capital at risk, net of premium), the shares' cap
//      (maxSharesPctOfAccount: the shares held at the 10:00 price, against the day's account value) and the volume limit
//      allow. A buy-write waits while held round lots have no call, unless entryWhenSharesUncovered is "buy": it then buys
//      every share its call covers and the uncovered lots keep waiting for their own;
//   3. with putsWhenNoCall "dte_budget" (a buy-write entry), when step 1 left held lots without a call or step 2 had room
//      for a lot and sold no buy-write, and no put of the stock is open: one put, the highest premium yield, strike at
//      most the average price of the shares held (any with none held), as many contracts as putBudgetPctPerDte% of the
//      day's account value × days to expiry (its exposure, (strike − fill) × 100 a contract), the free cash and the volume
//      limit allow (approved by Marcelo 2026-10-13). An assignment may take the shares past their cap.
// With minCallYieldPct > 0, a call (step 1 or a buy-write's) is sold only when its premium yield is above that.
// The day's account value for sizing is the session's: open options at zero when dayValueOptions is "excluded".
// With earnings "skip_spanning", no sale whose expiry spans a known earnings date (today ≤ report ≤ expiry); with looks
// "first_look", the session asks only at 10:00. With volatilityEdgeFilter "entries" (or "all_sales"), a new entry (or any
// sale, the calls on held shares too) is sold only when its volatility edge is at least minVolatilityEdgePoints; with
// ranking "edge_yield", "time_value" or "premium_dollars", the candidates are picked by that instead of their premium
// yield; with expiryChoice "nearest_qualifying", from the nearest expiry that has any first. With coverage
// "fill_down_ranking", what the best contract's volume limit leaves goes to the next candidates in that order.
// Everything is held to expiry; the session settles it (assignment, call-away) as for any session.
//
//   delta          = Black-76 delta at the quote's own implied volatility (from its mid), on the expiry's put-call parity
//                    forward (spot × e^{rT} when no strike has a usable pair); T = calendar days to expiry ÷ 365, and for
//                    an option expiring on the look's day the hours from the look to that day's close ÷ 8,760
//                    (approved by Marcelo 2026-10-15: at 10:00 on a 16:00 close, 6 ÷ 8,760)
//   fill           = mid − λ × half-spread (the session's fill rule)
//   premium yield  = (fill − intrinsic value) × 100 − commission, ÷ capital at risk, ÷ max(T, 1 day): a sale expiring
//                    on the look's day counts one day, as its cash or shares stay committed until the next morning's settlement
//                    capital at risk = (strike − fill) × 100 for a put, (spot − fill) × 100 for a call
//   Out of the money this is the platform's premium yield after costs; in the money only the time value counts, as
//   the intrinsic value is not earned.
//   volatility edge = √(252 × σ_mid² × T ÷ τ) − σ_YZ21: the Signals model's implied volatility (the mid's total variance
//                    on the forecast's clock) less its forecast; τ = variance sessions from the look to the expiry's close
//                    (varianceClock.ts), σ_YZ21 from the daily bars before today
//   Edge Yield     = the Signals model's expected P&L after costs (contractValuation.ts, friction λ × half-spread × 100 +
//                    commission) ÷ capital at risk, annualized on calendar time
// Realism limits: bid at least $0.05, ask above bid, at most 20% of the contract's previous-session volume (fixed), and a
// spread at most maxSpreadPctOfMid of the mid (a setting, 15% by default).

// The candidate rules and the sale steps live in baselineSaleSteps.ts (shared with live Pluto's ladder); re-exported here.
export { baselineContractsForCash, baselineMaxVolumeShare, baselineMinimumBid, selectBaselineCandidates, type BaselineCandidate, type BaselineCandidateInput, type BaselineModelInput, type BaselineRejections } from "./baselineSaleSteps.js";

export async function runBaselineLook(context: BacktestLookContext): Promise<BacktestLookResult> {
  const { settings, ledger, todayIso } = context;
  const baseline = settings.baseline;
  const lookTimeEt = context.lookTimeEt ?? captureLookTimeEt;
  const at = new Date(lookInstantMs(todayIso, lookTimeEt));
  // An option expiring today is priced on the hours left to today's close (13:00 on a half day).
  const closeMinutesEt = context.calendar.sessionsBetween(todayIso, todayIso)[0]?.closeMinutesEt ?? regularCloseMinutesEt;
  const [lookHours, lookMinutes] = lookTimeEt.split(":").map(Number);
  const yearsToTodaysClose = Math.max(0, closeMinutesEt - (lookHours! * 60 + lookMinutes!)) / 60 / 8760;
  const spreadShareCharged = settings.trading.spreadCostChargedPct / 100;
  const actions: BacktestAction[] = [];
  const optionSales: BacktestOptionSale[] = [];
  const summaries: string[] = [];

  for (const lookSymbol of context.symbols) {
    const symbol = lookSymbol.profile.symbol;
    if (!lookSymbol.optionContractsRepresentable) {
      summaries.push(`${symbol}: no option orders while the open cycle spans a split`);
      continue;
    }
    const quotes = lookSymbol.intraday?.quotes ?? lookSymbol.market.quotes;
    const stockPrice = lookSymbol.intraday?.stockPrice ?? lookSymbol.market.stockPrice;
    const riskFreeRate = (lookSymbol.market.riskFreeRatePercent ?? 0) / 100;
    const cycleSplitFactor = cycleSplitFactorFor(ledger, symbol, lookSymbol.splitFactorToday, at);
    const priceToCycleScale = cycleSplitFactor / lookSymbol.splitFactorToday;
    const toCyclePrice = (price: number) => price * priceToCycleScale;
    const sharesPerContractOnCycleScale = Math.round(sharesPerContract / priceToCycleScale);
    const heldContracts = new Set(
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(ledger, position.id).filter((leg) => leg.legType === "option" && leg.exitAt === null))
        .map((leg) => `${leg.expiryDate}|${Math.round((leg.strikePrice! / priceToCycleScale) * 10_000) / 10_000}`),
    );
    const heldKey = (contract: { expiry: string; strike: number }) => `${contract.expiry}|${Math.round(contract.strike * 10_000) / 10_000}`;
    const isHeld = (contract: { expiry: string; strike: number }) => heldContracts.has(heldKey(contract));
    const earningsDatesIso = baseline.earnings === "skip_spanning" && lookSymbol.profile.calendarChecksApply ? earningsNotYetReported(lookSymbol.profile.earnings, todayIso) : undefined;
    let model: BaselineModelInput | null = null;
    if (baseline.volatilityEdgeFilter !== "off" || baseline.ranking === "edge_yield") {
      const furthestExpiry = quotes.reduce<string | null>((furthest, quote) => (furthest === null || quote.expiry > furthest ? quote.expiry : furthest), null);
      const sessions = furthestExpiry === null ? [] : context.calendar.sessionsBetween(todayIso, furthestExpiry);
      const varianceSessionsByExpiry = new Map<string, number>();
      model = {
        tables: context.modelTables,
        group: lookSymbol.profile.valuationGroup,
        forecast: selectModelVolatilityForecast(toOhlcvBars(lookSymbol.bars.rowsBefore(todayIso, forecastBarRowCount))),
        varianceSessionsTo: (expiryIso) => {
          let varianceSessions = varianceSessionsByExpiry.get(expiryIso);
          if (varianceSessions === undefined) varianceSessionsByExpiry.set(expiryIso, (varianceSessions = varianceSessionsToExpiry(at.getTime(), expiryIso, sessions)));
          return varianceSessions;
        },
        minVolatilityEdge: baseline.volatilityEdgeFilter !== "off" ? baseline.minVolatilityEdgePoints / 100 : null,
        rankByEdgeYield: baseline.ranking === "edge_yield",
      };
    }
    // The calls on held shares are held to the margin only when every sale is (makeBaselineSelector).
    const select = makeBaselineSelector({ quotes, todayIso, yearsToTodaysClose, stockPrice, riskFreeRate, previousSessionVolumeByContract: lookSymbol.market.previousSessionVolumeByContract, baseline, spreadShareCharged, isHeld, earningsDatesIso, model });
    // The day's account value for sizing: the session's own, open options at zero when it leaves them out.
    const accountValueToday = () =>
      ledgerNetLiquidationValue(ledger, baseline.dayValueOptions === "excluded" ? new Map([...context.priceByLegId].map(([legId, price]) => [legId, requireLeg(ledger, legId).legType === "option" ? 0 : price])) : context.priceByLegId);
    let quoteIndex: Map<string, SymbolFileQuote> | null = null;
    const quoteOf = (contract: { expiry: string; strike: number; right: "C" | "P" }) => (quoteIndex ??= new Map(quotes.map((quote) => [contractKey({ expiry: quote.expiry, strike: roundedStrike(quote.strike), right: quote.right }), quote]))).get(contractKey(contract));
    // On today's scale: the average price paid for the shares held (null when none), and how many are held.
    const heldSharesAverageCostToday = () => {
      const averageCost = ledgerHeldSharesAverageCost(ledger, symbol);
      return averageCost === null ? null : averageCost / priceToCycleScale;
    };
    const heldSharesToday = () =>
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open")
        .flatMap((position) => legsOfPosition(ledger, position.id))
        .filter((leg) => leg.legType === "stock" && leg.side === "long" && leg.exitAt === null)
        .reduce((sum, leg) => sum + leg.quantity * priceToCycleScale, 0);
    // The put ladder (backtestBaselineLadder.ts): the cycle's state, noted before anything is sold at this look.
    const ladderOn = baseline.entry === "buy_write" && baseline.putsWhenNoCall === "reserve_ladder";
    const ladderState = ladderOn
      ? noteLadderLook(ledger, symbol, { cycleOpen: ledgerOpenCycleSummary(ledger, symbol) !== null, todayIso, accountValue: accountValueToday(), stockPriceOnCycleScale: toCyclePrice(stockPrice), adjustedClosesBefore: lookSymbol.adjustedDailyClosesBeforeToday }, baseline)
      : null;
    const openPutCollateral = () =>
      positionsOfSymbol(ledger, symbol)
        .filter((position) => position.status === "open" && position.strategyKey === "cash_secured_put")
        .flatMap((position) => legsOfPosition(ledger, position.id))
        .filter((leg) => leg.legType === "option" && leg.side === "short" && leg.exitAt === null)
        .reduce((sum, leg) => sum + leg.strikePrice! * leg.quantity * leg.multiplier, 0);

    // strikeLimit: the cost rule's lowest strike for a call (costFloor, before the relief) or highest for a put (costCeiling,
    // the average held; null with none), when one applied; its scores then carry it with the averages around the order.
    const record = (strategyKey: "cash_secured_put" | "covered_call", candidate: BaselineCandidate, contracts: number, eligibleCount: number, chosenBecause: string, strikeLimit: { name: "costFloor" | "costCeiling"; value: number | null } | null = null, buyEveryShare = false, extraScores: Record<string, number | null> = {}) => {
      const actionId = context.nextActionId();
      const averageCostBefore = strikeLimit === null ? null : heldSharesAverageCostToday();
      const sharesHeldBefore = strikeLimit === null ? null : Math.round(heldSharesToday());
      const stockFillToday = baselineShareFillPrice(baseline, stockPrice);
      const candidateMid = (candidate.bid + candidate.ask) / 2;
      let legIds: string[];
      let positionIds: string[];
      let newLegId: string;
      let sharesNote = "";
      if (strategyKey === "cash_secured_put") {
        const opened = openCashSecuredPut(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, fillPrice: toCyclePrice(candidate.fillPrice), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale });
        legIds = [opened.legId];
        positionIds = [opened.positionId];
        newLegId = opened.legId;
      } else {
        const opened = openCoveredCall(ledger, { symbol, expiryDate: candidate.expiry, strike: toCyclePrice(candidate.strike), contracts, callFillPrice: toCyclePrice(candidate.fillPrice), stockFillPrice: toCyclePrice(stockFillToday), at, actionId, splitFactorToday: lookSymbol.splitFactorToday, sharesPerContract: sharesPerContractOnCycleScale, tradedSharesPerLedgerShare: priceToCycleScale, buyEveryShare });
        const leftoverLegIds = opened.leftoverPositionId === null ? [] : legsOfPosition(ledger, opened.leftoverPositionId).filter((leg) => leg.exitAt === null).map((leg) => leg.id);
        legIds = [opened.callLegId, opened.stockLegId, ...leftoverLegIds];
        positionIds = [opened.positionId, ...(opened.leftoverPositionId === null ? [] : [opened.leftoverPositionId])];
        newLegId = opened.callLegId;
        const sharesBoughtToday = Math.round(opened.sharesBought * priceToCycleScale);
        const sharesHeldToday = Math.round(opened.sharesFromHeld * priceToCycleScale);
        sharesNote = [sharesHeldToday > 0 ? ` on ${sharesHeldToday} held shares` : "", sharesBoughtToday > 0 ? ` with ${sharesBoughtToday} shares bought @ ${stockFillToday.toFixed(2)}` : ""].join("");
      }
      // One position per contract (the ledger's rule, either right): the look's next choice must not take it again.
      heldContracts.add(heldKey(candidate));
      for (const legId of legIds) {
        const leg = requireLeg(ledger, legId);
        context.priceByLegId.set(legId, toCyclePrice(leg.legType === "stock" ? stockPrice : candidateMid));
      }
      const contractLabel = describeOptionContract({ strike: candidate.strike, right: candidate.right, expiry: candidate.expiry, dte: candidate.dte });
      const modelNote = [candidate.edgeYield === null ? "" : `, Edge Yield ${(candidate.edgeYield * 100).toFixed(0)}%`, candidate.volatilityEdge === null ? "" : `, IV ${(candidate.volatilityEdge * 100).toFixed(1)} pts above the forecast`].join("");
      const description = `${symbol} Sell ${contractLabel}${describeOrderSize(contracts, candidate.fillPrice)}${sharesNote} (premium yield ${(candidate.premiumYield * 100).toFixed(0)}%${modelNote}, delta ${Math.abs(candidate.delta).toFixed(2)}; ${eligibleCount} eligible)`;
      actions.push({
        actionId,
        tradingDate: todayIso,
        at: at.toISOString(),
        lookTimeEt,
        passNumber: 1,
        symbol,
        kind: strategyKey === "cash_secured_put" ? "open_cash_secured_put" : "open_covered_call",
        candidateId: openCandidateId(symbol, { strategyKey, expiry: candidate.expiry, strike: candidate.strike }),
        description,
        automatic: false,
        chosenBecause,
        outcome: "filled",
        blockReason: null,
        gateResults: [{ gate: "baseline", ok: true, detail: `${contracts} contract(s): volume allows ${candidate.volumeCap}` }],
        contract: { strategyKey, expiry: candidate.expiry, strike: candidate.strike, right: candidate.right },
        candidateScores: {
          premiumYield: candidate.premiumYield,
          delta: candidate.delta,
          impliedVolatility: candidate.impliedVolatility,
          timeValue: candidate.timeValue,
          dte: candidate.dte,
          bid: candidate.bid,
          ask: candidate.ask,
          volumeCap: candidate.volumeCap,
          eligibleCount,
          volatilityEdge: candidate.volatilityEdge,
          edgeYield: candidate.edgeYield,
          ...(strikeLimit === null
            ? {}
            : strikeLimit.name === "costFloor"
              ? { costFloor: strikeLimit.value, averageCostBefore, averageCostAfter: heldSharesAverageCostToday(), sharesHeldBefore }
              : { costCeiling: strikeLimit.value, averageCostBefore, averageCostAfter: heldSharesAverageCostToday(), sharesHeldBefore }),
          ...extraScores,
        },
        quantity: contracts,
        limitPrice: candidate.fillPrice,
        fillPrice: candidate.fillPrice,
        positionIds,
      });
      optionSales.push({
        legId: newLegId,
        actionId,
        symbol,
        openedOn: todayIso,
        strategyKey,
        expiry: candidate.expiry,
        strike: candidate.strike,
        optionRight: candidate.right,
        contracts,
        bid: candidate.bid,
        ask: candidate.ask,
        fillPrice: candidate.fillPrice,
        commissionDollars: optionCommissionDollars(contracts),
        spotAtOpen: stockPrice,
        sharePriceAtOpen: strategyKey === "covered_call" ? stockPrice : null,
        exposureDollars: ledgerCapitalAtRisk(ledger, requireLeg(ledger, newLegId).positionId) ?? ((strategyKey === "covered_call" ? stockPrice : candidate.strike) - candidate.fillPrice) * sharesPerContract * contracts,
        dte: candidate.dte,
        delta: candidate.delta,
        grade: null,
        edgeMargin: null,
        expectedPnlDollars: null,
        calibratedExpectedPnlDollars: null,
        edgeYield: candidate.edgeYield,
        histYield: null,
        kellyContracts: null,
        stressContracts: null,
        priceToCycleScale,
      });
      summaries.push(`Opened ${description}`);
    };

    // −1. The share stop.
    if (baseline.shareStopLossPct > 0) {
      const cycle = ledgerOpenCycleSummary(ledger, symbol);
      const costToday = cycle && cycle.sharesHeld > 0 && cycle.sharesAcquired > 0 ? cycle.acquisitionCost / cycle.sharesAcquired / priceToCycleScale : null;
      if (costToday !== null && stockPrice <= costToday * (1 - baseline.shareStopLossPct / 100)) {
        const stockFill = stockSaleFillPrice(stockPrice);
        for (const position of positionsOfSymbol(ledger, symbol)) {
          if (position.status !== "open" || (position.strategyKey !== "unstructured" && position.strategyKey !== "covered_call")) continue;
          const openLegs = legsOfPosition(ledger, position.id).filter((leg) => leg.exitAt === null);
          const stockLeg = openLegs.find((leg) => leg.legType === "stock");
          if (!stockLeg) continue;
          const sharesToday = Math.round(stockLeg.quantity * priceToCycleScale);
          let callNote = "";
          const actionId = context.nextActionId();
          if (position.strategyKey === "unstructured") {
            sellShares(ledger, { positionId: position.id, shares: stockLeg.quantity, fillPrice: toCyclePrice(stockFill), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
          } else {
            const callLeg = openLegs.find((leg) => leg.legType === "option")!;
            const quote = quoteOf({ expiry: callLeg.expiryDate!, strike: roundedStrike(callLeg.strikePrice! / priceToCycleScale), right: "C" });
            if (!quote || quote.ask === null || !(quote.ask > 0)) {
              summaries.push(`${symbol}: share stop waits for a quote on the call written on ${sharesToday} shares`);
              continue;
            }
            const callFill = optionPurchaseFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged);
            closeCoveredCall(ledger, { positionId: position.id, callFillPrice: toCyclePrice(callFill), stockFillPrice: toCyclePrice(stockFill), at, actionId, tradedSharesPerLedgerShare: priceToCycleScale });
            callNote = `, buying back the call @ ${callFill.toFixed(2)}`;
          }
          const description = `${symbol} Sell ${sharesToday} shares @ ${stockFill.toFixed(2)}${callNote} (${(((stockPrice / costToday) - 1) * 100).toFixed(1)}% from their cost of ${costToday.toFixed(2)})`;
          actions.push({ actionId, tradingDate: todayIso, at: at.toISOString(), lookTimeEt, passNumber: 1, symbol, kind: position.strategyKey === "unstructured" ? "close_shares" : "close_position", candidateId: `${symbol}:share_stop:${position.id}`, description, automatic: false, chosenBecause: `baseline: shares ${baseline.shareStopLossPct}% or more below their cost`, outcome: "filled", blockReason: null, gateResults: [{ gate: "baseline", ok: true, detail: `price ${stockPrice.toFixed(2)} vs cost ${costToday.toFixed(2)}` }], contract: null, candidateScores: { costPerShare: costToday, stockPrice }, quantity: sharesToday, limitPrice: stockFill, fillPrice: stockFill, positionIds: [position.id] });
          summaries.push(`Closed ${description}`);
        }
      }
    }

    // 0. Profit-taking.
    if (baseline.takeProfitPct > 0) {
      for (const position of positionsOfSymbol(ledger, symbol)) {
        if (position.status !== "open" || (position.strategyKey !== "cash_secured_put" && position.strategyKey !== "covered_call")) continue;
        const optionLeg = legsOfPosition(ledger, position.id).find((leg) => leg.legType === "option" && leg.side === "short" && leg.exitAt === null);
        if (!optionLeg || daysToExpiry(optionLeg.expiryDate!, todayIso) < 1) continue;
        const right = optionLeg.optionType === "call" ? ("C" as const) : ("P" as const);
        const contract = { expiry: optionLeg.expiryDate!, strike: roundedStrike(optionLeg.strikePrice! / priceToCycleScale), right };
        const quote = quoteOf(contract);
        if (!quote || quote.ask === null || !(quote.ask > 0) || (quote.bid !== null && quote.bid > quote.ask)) continue;
        const buybackFill = optionPurchaseFillPrice(quote.bid ?? 0, quote.ask, spreadShareCharged);
        const entryToday = optionLeg.entryPrice / priceToCycleScale;
        const kept = entryToday > 0 ? 1 - buybackFill / entryToday : 0;
        if (kept * 100 < baseline.takeProfitPct) continue;
        const actionId = context.nextActionId();
        if (right === "P") buyBackPut(ledger, { legId: optionLeg.id, fillPrice: toCyclePrice(buybackFill), at, actionId });
        else buyBackCoveredCallKeepingShares(ledger, { positionId: position.id, callFillPrice: toCyclePrice(buybackFill), at, actionId });
        const contracts = Math.round((optionLeg.quantity * optionLeg.multiplier * priceToCycleScale) / sharesPerContract);
        const contractLabel = describeOptionContract({ strike: contract.strike, right, expiry: contract.expiry, dte: daysToExpiry(contract.expiry, todayIso) });
        const description = `${symbol} Buy back ${contractLabel}${describeOrderSize(contracts, buybackFill)} (keeps ${(kept * 100).toFixed(0)}% of the premium${right === "C" ? "; the shares stay" : ""})`;
        actions.push({ actionId, tradingDate: todayIso, at: at.toISOString(), lookTimeEt, passNumber: 1, symbol, kind: "close_leg", candidateId: `${symbol}:take_profit:${optionLeg.id}`, description, automatic: false, chosenBecause: `baseline: take profit at ${baseline.takeProfitPct}% of the premium`, outcome: "filled", blockReason: null, gateResults: [{ gate: "baseline", ok: true, detail: `buyback keeps ${(kept * 100).toFixed(1)}% of the premium` }], contract: { strategyKey: position.strategyKey, expiry: contract.expiry, strike: contract.strike, right }, candidateScores: { kept, entryPrice: entryToday, bid: quote.bid, ask: quote.ask }, quantity: contracts, limitPrice: buybackFill, fillPrice: buybackFill, positionIds: [position.id] });
        summaries.push(`Closed ${description}`);
      }
    }

    // The sale steps (baselineSaleSteps.ts, shared with live Pluto's ladder): each sale filled at once through record().
    const book: BaselineLookBook = {
      freeShares: () => ledgerFreeShares(ledger, symbol),
      freeCash: () => ledgerFreeCash(ledger),
      heldSharesAverageCost: () => ledgerHeldSharesAverageCost(ledger, symbol),
      heldSharesAverageCostToday,
      heldSharesToday,
      latestShareAcquisitionPrice: () => ledgerLatestShareAcquisitionPrice(ledger, symbol),
      openCycleSummary: () => ledgerOpenCycleSummary(ledger, symbol),
      openPutCollateral,
      accountValueToday,
      netLiquidationValue: () => ledgerNetLiquidationValue(ledger, context.priceByLegId),
      openPositionsCapitalAtRisk: () => positionsOfSymbol(ledger, symbol).filter((position) => position.status === "open").reduce((sum, position) => sum + (ledgerCapitalAtRisk(ledger, position.id) ?? 0), 0),
      hasOpenCashSecuredPut: () => positionsOfSymbol(ledger, symbol).some((position) => position.status === "open" && position.strategyKey === "cash_secured_put"),
      isHeld,
      sell: record,
    };
    planBaselineSales({ symbol, todayIso, atMs: at.getTime(), stockPrice, priceToCycleScale, baseline, select, book, ladderState, notes: summaries });
  }

  const summary = summaries.length === 0 ? "No action: fully invested" : actions.length === 0 ? `No action: ${summaries.join(" | ")}` : summaries.join(" · ");
  return { actions, optionSales, summary, summaryOfActions: summary, opensStopped: [], fitIssueBySymbol: new Map(), scoredBySymbol: new Map(), llmCalls: { asked: 0, fromCache: 0 } };
}
