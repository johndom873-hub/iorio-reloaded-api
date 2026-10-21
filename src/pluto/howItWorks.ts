import { baselineMaxVolumeShare, baselineMinimumBid } from "../backtest/engine/baselineSaleSteps.js";
import { ladderBudget, ladderRungCollateral, ladderStrikeCap } from "../backtest/engine/backtestBaselineLadder.js";
import { gradeForEdgeMargin, gradeMarginCutPoints, yieldOnExposure } from "../lib/contractValuation.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { describeOptionContract } from "../lib/optionContractLabel.js";
import { addCalendarDays } from "../lib/signalsRoadmap.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { buybackUnscoredMinKeptPremiumShare, earningsBuybackWindowSessions, eventCloseWindowSessions } from "./closeActions.js";
import { ladderFixedBaselineChoices } from "./ladderSettings.js";
import { kellyFraction } from "./postModelGates.js";
import { candidatesPerTickerPerStrategy } from "./prompt.js";
import { closeMarginMinutes } from "./sessionSchedule.js";
import { loadPlutoSettings, type PlutoExecutionStrategy, type PlutoGrade, type PlutoSettings } from "./settingsStore.js";

// The numbers Pluto's "How it works" tab quotes for each strategy (approved mockup
// https://claude.ai/artifact/TYdARe8Sa6RuF5Lb1E1s2b): Pluto's live settings and the code's own constants, read from where
// the strategies read them, so the tab cannot drift from what runs. The two worked examples are computed by the
// functions the strategies use (the ladder's strike cap, the valuation's grade and yield) on fixed example inputs.
// Percentages are in percent (5 = 5%), deltas as fractions, money in dollars.

/** The ladder example's fixed inputs: a $2M account, a 20% allocation, shares bought at $104 with a $100 break-even. */
const ladderExampleAccountValue = 2_000_000;
const ladderExampleAllocationPct = 20;
const ladderExampleAverageCost = 104;
const ladderExampleBreakEven = 100;
const ladderExampleShockPct = 70;

/** The Edge Margin example's fixed inputs: a $45 Put, 7 days out, mid $1.00, fair $0.85, $2 of spread and commission (no symbol: any would be a real ticker). */
const edgeExampleStrike = 45;
const edgeExampleDaysToExpiry = 7;
const edgeExampleMid = 1;
const edgeExampleFair = 0.85;
const edgeExampleFrictionDollars = 2;

export interface PlutoHowItWorksLadderRung {
  rung: number;
  /** The highest strike the rung's Put may have, with every earlier rung an open Put on its full share of the reserve. */
  strikeCap: number;
}

export interface PlutoHowItWorks {
  activeStrategy: PlutoExecutionStrategy;
  shared: {
    capitalBudgetPct: number;
    dailyLossBreakerPct: number;
    unfilledOrderCancelMinutes: number;
  };
  ladder: {
    /** The Calls' |delta| range; the ladder's Puts have none (the rung's cap bounds them). */
    minAbsDelta: number;
    maxAbsDelta: number;
    minDte: number;
    maxDte: number;
    maxSpreadPctOfMid: number;
    minimumBid: number;
    maxVolumeSharePct: number;
    rungs: number;
    sharesPct: number;
    shockMinPct: number;
    shockMaxPct: number;
    shockNoHistoryPct: number;
    shockLookbackYears: number;
    /** A ladder Put is sold instead of the best Call when its premium yield beats the Call's by more than this. */
    putOverCallYieldMarginPct: number;
    /** The entry (a Cash-Secured Put or a Covered Call, whichever ranks higher) needs a premium yield above this, % a year. */
    minEntryYieldPct: number;
    /** A band quote older than this is left out of the look. */
    maxQuoteAgeMinutes: number;
    maxWorkingOrdersPerTicker: number;
    maxOrdersPerTickerPerDay: number;
    maxOpenPositionsPerTicker: number;
    /** Across every ladder ticker: open positions plus working orders, and orders sent in a day. */
    maxOpenPositions: number;
    maxOrdersPerDay: number;
    spyStressBreakerPct: number;
    tickerCooldownMinutes: number;
    example: {
      accountValue: number;
      allocationPct: number;
      pot: number;
      sharesBudget: number;
      reserve: number;
      rungCollateral: number;
      averageCost: number;
      breakEven: number;
      shockPct: number;
      floor: number;
      rungs: PlutoHowItWorksLadderRung[];
    };
  };
  edgeMargin: {
    windowStartEt: string;
    windowEndEt: string;
    windowEndMinutesBeforeCloseAtLeast: number;
    minGrade: PlutoGrade;
    gradeCutsPct: { strong: number; good: number; weak: number };
    minEdgeYieldPct: number;
    minAnnualizedYieldPct: number;
    maxAbsDelta: number;
    minDte: number;
    maxDte: number;
    maxSpreadPct: number;
    minOpenInterest: number;
    minSessionVolume: number;
    maxQuoteAgeMinutes: number;
    maxDayMoveMultiple: number;
    burstLines: number;
    candidatesPerTickerPerStrategy: number;
    confidenceFloor: number;
    maxEdgeMarginDriftPts: number;
    orderSizePctOfBudget: number;
    maxTickerPctOfBudget: number;
    minCashReservePct: number;
    maxContractsVolumeSharePct: number;
    stressRiskBudgetPct: number;
    stressSigmas: number;
    kellyFraction: number;
    maxOpenPositions: number;
    spyStressBreakerPct: number;
    maxActionsPerSession: number;
    tickerCooldownMinutes: number;
    consecutiveModelFailuresBreaker: number;
    dailyCostCeilingUsd: number;
    heldShareCallMinProfitPct: number;
    heldShareCallMinProfitDollars: number;
    buybackMinDte: number;
    buybackUnscoredMinKeptPremiumPct: number;
    earningsCloseWindowSessions: number;
    eventCloseWindowSessions: number;
    example: {
      contractLabel: string;
      strike: number;
      daysToExpiry: number;
      mid: number;
      fair: number;
      frictionDollars: number;
      exposure: number;
      edgeMarginPct: number;
      grade: string;
      edgeDollars: number;
      edgeYieldPct: number;
      passesMinEdgeYield: boolean;
    };
  };
}

const percent = (fraction: number) => Math.round(fraction * 1_000_000) / 10_000;

/** Pure: the tab's numbers from Pluto's settings, the platform's unfilled-order sweep and the code's constants. */
export function buildPlutoHowItWorks(settings: PlutoSettings, figures: { unfilledOrderCancelMinutes: number; todayIso: string }): PlutoHowItWorks {
  const pot = (ladderExampleAccountValue * ladderExampleAllocationPct * settings.capitalBudgetPct) / 10_000;
  const { sharesBudget, reserve } = ladderBudget(pot, settings.ladderSharesPct);
  const rungCollateral = ladderRungCollateral(reserve, 0, settings.ladderRungs);
  const shockPct = Math.min(settings.ladderShockMaxPct, Math.max(settings.ladderShockMinPct, ladderExampleShockPct));
  const floor = ladderExampleAverageCost * (1 - shockPct / 100);
  const rungs: PlutoHowItWorksLadderRung[] = [];
  for (let rung = 1; rung <= settings.ladderRungs; rung += 1) {
    const committed = (rung - 1) * rungCollateral;
    const strikeCap = ladderStrikeCap({ breakEven: ladderExampleBreakEven, floor, committed, rungCollateral: ladderRungCollateral(reserve, committed, settings.ladderRungs), reserve });
    if (strikeCap !== null) rungs.push({ rung, strikeCap });
  }

  const edgeMargin = 1 - edgeExampleFair / edgeExampleMid;
  const edgeDollars = (edgeExampleMid - edgeExampleFair) * 100 - edgeExampleFrictionDollars;
  const exposure = (edgeExampleStrike - edgeExampleMid) * 100;
  const edgeYield = yieldOnExposure(edgeDollars, exposure, edgeExampleDaysToExpiry / 365);

  return {
    activeStrategy: settings.executionStrategy,
    shared: {
      capitalBudgetPct: settings.capitalBudgetPct,
      dailyLossBreakerPct: settings.dailyLossBreakerPct,
      unfilledOrderCancelMinutes: figures.unfilledOrderCancelMinutes,
    },
    ladder: {
      minAbsDelta: settings.ladderMinAbsDelta,
      maxAbsDelta: settings.ladderMaxAbsDelta,
      minDte: settings.ladderMinDte,
      maxDte: settings.ladderMaxDte,
      maxSpreadPctOfMid: settings.ladderMaxSpreadPctOfMid,
      minimumBid: baselineMinimumBid,
      maxVolumeSharePct: percent(baselineMaxVolumeShare),
      rungs: settings.ladderRungs,
      sharesPct: settings.ladderSharesPct,
      shockMinPct: settings.ladderShockMinPct,
      shockMaxPct: settings.ladderShockMaxPct,
      shockNoHistoryPct: settings.ladderShockNoHistoryPct,
      shockLookbackYears: settings.ladderShockLookbackYears,
      putOverCallYieldMarginPct: ladderFixedBaselineChoices.ladderPutYieldMarginPct,
      minEntryYieldPct: ladderFixedBaselineChoices.minCallYieldPct,
      maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
      maxWorkingOrdersPerTicker: settings.ladderMaxWorkingOrdersPerTicker,
      maxOrdersPerTickerPerDay: settings.ladderMaxOrdersPerTickerPerDay,
      maxOpenPositionsPerTicker: settings.ladderMaxOpenPositionsPerTicker,
      maxOpenPositions: settings.ladderMaxOpenPositions,
      maxOrdersPerDay: settings.ladderMaxOrdersPerDay,
      spyStressBreakerPct: settings.ladderSpyStressBreakerPct,
      tickerCooldownMinutes: settings.ladderTickerCooldownMinutes,
      example: { accountValue: ladderExampleAccountValue, allocationPct: ladderExampleAllocationPct, pot, sharesBudget, reserve, rungCollateral, averageCost: ladderExampleAverageCost, breakEven: ladderExampleBreakEven, shockPct, floor, rungs },
    },
    edgeMargin: {
      windowStartEt: settings.windowStartEt,
      windowEndEt: settings.windowEndEt,
      windowEndMinutesBeforeCloseAtLeast: closeMarginMinutes,
      minGrade: settings.minGrade,
      gradeCutsPct: { strong: percent(gradeMarginCutPoints.strong), good: percent(gradeMarginCutPoints.good), weak: percent(gradeMarginCutPoints.weak) },
      minEdgeYieldPct: settings.minEdgeYieldPct,
      minAnnualizedYieldPct: settings.minAnnualizedYieldPct,
      maxAbsDelta: settings.maxAbsDelta,
      minDte: settings.minDte,
      maxDte: settings.maxDte,
      maxSpreadPct: settings.maxSpreadPct,
      minOpenInterest: settings.minOpenInterest,
      minSessionVolume: settings.minSessionVolume,
      maxQuoteAgeMinutes: settings.maxQuoteAgeMinutes,
      maxDayMoveMultiple: settings.maxDayMoveMultiple,
      burstLines: settings.burstLines,
      candidatesPerTickerPerStrategy,
      confidenceFloor: settings.confidenceFloor,
      maxEdgeMarginDriftPts: settings.maxEdgeMarginDriftPts,
      orderSizePctOfBudget: settings.orderSizePctOfBudget,
      maxTickerPctOfBudget: settings.maxTickerPctOfBudget,
      minCashReservePct: settings.minCashReservePct,
      maxContractsVolumeSharePct: settings.maxContractsVolumeSharePct,
      stressRiskBudgetPct: settings.stressRiskBudgetPct,
      stressSigmas: settings.stressSigmas,
      kellyFraction,
      maxOpenPositions: settings.maxOpenPositions,
      spyStressBreakerPct: settings.spyStressBreakerPct,
      maxActionsPerSession: settings.maxActionsPerSession,
      tickerCooldownMinutes: settings.tickerCooldownMinutes,
      consecutiveModelFailuresBreaker: settings.consecutiveModelFailuresBreaker,
      dailyCostCeilingUsd: settings.dailyCostCeilingUsd,
      heldShareCallMinProfitPct: settings.unstructuredCloseMinPct,
      heldShareCallMinProfitDollars: settings.unstructuredCloseMinDollars,
      buybackMinDte: settings.buybackMinDte,
      buybackUnscoredMinKeptPremiumPct: percent(buybackUnscoredMinKeptPremiumShare),
      earningsCloseWindowSessions: earningsBuybackWindowSessions,
      eventCloseWindowSessions,
      example: {
        contractLabel: describeOptionContract({ strike: edgeExampleStrike, right: "P", expiry: addCalendarDays(figures.todayIso, edgeExampleDaysToExpiry), dte: edgeExampleDaysToExpiry }),
        strike: edgeExampleStrike,
        daysToExpiry: edgeExampleDaysToExpiry,
        mid: edgeExampleMid,
        fair: edgeExampleFair,
        frictionDollars: edgeExampleFrictionDollars,
        exposure,
        edgeMarginPct: percent(edgeMargin),
        grade: gradeForEdgeMargin(edgeMargin),
        edgeDollars,
        edgeYieldPct: percent(edgeYield),
        passesMinEdgeYield: edgeYield * 100 >= settings.minEdgeYieldPct,
      },
    },
  };
}

export async function loadPlutoHowItWorks(now: Date = new Date()): Promise<PlutoHowItWorks> {
  const [settings, unfilledOrderCancelMinutes] = await Promise.all([loadPlutoSettings(), loadOrderUnfilledCancelMinutes()]);
  return buildPlutoHowItWorks(settings, { unfilledOrderCancelMinutes, todayIso: easternIsoDate(now) });
}
