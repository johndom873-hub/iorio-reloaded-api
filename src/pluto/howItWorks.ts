import { baselineMaxVolumeShare, baselineMinimumBid } from "../backtest/engine/baselineSaleSteps.js";
import { ladderBudget, ladderRungCollateral, ladderStrikeCap } from "../backtest/engine/backtestBaselineLadder.js";
import { volFarmerV2ImpliedMoveStep, volFarmerV2LeapsBudget, volFarmerV2PutStrikeCap } from "../backtest/engine/volFarmerV2Steps.js";
import { flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { tradingSessionsPerYear } from "../lib/tradingSessionsHeld.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { ladderFixedBaselineChoices } from "./ladderSettings.js";
import { closeMarginMinutes } from "./sessionSchedule.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { tickerPotFraction } from "./tickerSettingsStore.js";

// The numbers Pluto's "How it works" tab quotes (approved mockup https://claude.ai/artifact/TYdARe8Sa6RuF5Lb1E1s2b; the
// CC + Put Ladder and, since 2026-10-27, Vol Farmer v2): Pluto's live settings and the code's own constants, read from
// where the strategies read them, so the tab cannot drift from what runs. The worked examples are computed by the
// strategies' own functions on fixed example inputs. Percentages are in percent (5 = 5%), deltas as fractions, money in
// dollars.

/** The ladder example's fixed inputs: a $2M account, a 20% allocation, shares bought at $104 with a $100 break-even. */
const ladderExampleAccountValue = 2_000_000;
const ladderExampleAllocationPct = 20;
const ladderExampleAverageCost = 104;
const ladderExampleBreakEven = 100;
const ladderExampleShockPct = 70;

/** Vol Farmer v2's example: the same account and allocation, the stock at $100, a first break-even of $96 after a fall, IBKR's IV at 60%. */
const volFarmerV2ExampleStockPrice = 100;
const volFarmerV2ExampleFirstBreakEven = 96;
const volFarmerV2ExampleImpliedVolatility = 0.6;

export interface PlutoHowItWorksLadderRung {
  rung: number;
  /** The highest strike the rung's Put may have, with every earlier rung an open Put on its full share of the reserve. */
  strikeCap: number;
}

export interface PlutoHowItWorks {
  shared: {
    windowStartEt: string;
    windowEndEt: string;
    windowEndMinutesBeforeCloseAtLeast: number;
    capitalBudgetPct: number;
    /** Every ticker's pot is its allocation raised by this share (tickerPotFraction). */
    excessAllowancePct: number;
    dailyLossBreakerPct: number;
    unfilledOrderCancelMinutes: number;
    /** A premium yield a year is the sale's return × this ÷ the trading sessions it is held (tradingSessionsHeld.ts). */
    premiumYieldSessionsPerYear: number;
  };
  /** The Safety Limits: they hold every Pluto strategy, both strategies' orders counted together (safetyLimits.ts). */
  safetyLimits: {
    maxWorkingOrdersPerTicker: number;
    maxOrdersPerTickerPerDay: number;
    maxOpenPositionsPerTicker: number;
    /** Across every Pluto ticker: open positions plus working orders, and orders sent in a day. */
    maxOpenPositions: number;
    maxOrdersPerDay: number;
    spyStressBreakerPct: number;
    tickerCooldownMinutes: number;
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
  volFarmerV2: {
    /** The Calls' |delta| range, spread limit and bid minimum; the volume share as the ladder's. */
    callMinAbsDelta: number;
    callMaxAbsDelta: number;
    maxSpreadPctOfMid: number;
    minimumBid: number;
    maxVolumeSharePct: number;
    /** % of the pot the first position's shares are bought with; the Puts sell on the rest. */
    firstPositionPct: number;
    putsStartCallYieldPct: number;
    putMaxAbsDelta: number;
    stepRule: PlutoSettings["volFarmerV2StepRule"];
    /** The fixed rule's Step. */
    stepBelowFirstBreakEvenPct: number;
    leapsMinDte: number;
    leapsAbsDelta: number;
    leapsMaxAllocationPct: number;
    example: {
      accountValue: number;
      allocationPct: number;
      pot: number;
      stockPrice: number;
      lots: number;
      firstBreakEven: number;
      impliedVolatilityPct: number;
      stepPct: number;
      putStrikeCap: number;
      /** How far below B-E2 the LEAPS is bought: half the Step, percent (Marcelo 2026-10-28). */
      leapsEntryBelowSecondBreakEvenPct: number;
      leapsCap: number;
    };
  };
}

const percent = (fraction: number) => Math.round(fraction * 1_000_000) / 10_000;

/** Pure: the tab's numbers from Pluto's settings, the platform's unfilled-order sweep and the code's constants. */
export function buildPlutoHowItWorks(settings: PlutoSettings, figures: { unfilledOrderCancelMinutes: number }): PlutoHowItWorks {
  const pot = ladderExampleAccountValue * tickerPotFraction(ladderExampleAllocationPct, settings);
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


  const volFarmerV2Step = settings.volFarmerV2StepRule === "implied_move_at_put_sale" ? volFarmerV2ImpliedMoveStep(volFarmerV2ExampleImpliedVolatility).stepPct : settings.volFarmerV2StepBelowFirstBreakEvenPct;
  const volFarmerV2LotCost = volFarmerV2ExampleStockPrice * 100 + flatStockCommissionEstimator.perShareDollars("buy") * 100;

  return {
    shared: {
      windowStartEt: settings.windowStartEt,
      windowEndEt: settings.windowEndEt,
      windowEndMinutesBeforeCloseAtLeast: closeMarginMinutes,
      capitalBudgetPct: settings.capitalBudgetPct,
      excessAllowancePct: settings.excessAllowancePct,
      dailyLossBreakerPct: settings.dailyLossBreakerPct,
      unfilledOrderCancelMinutes: figures.unfilledOrderCancelMinutes,
      premiumYieldSessionsPerYear: tradingSessionsPerYear,
    },
    safetyLimits: {
      maxWorkingOrdersPerTicker: settings.safetyMaxWorkingOrdersPerTicker,
      maxOrdersPerTickerPerDay: settings.safetyMaxOrdersPerTickerPerDay,
      maxOpenPositionsPerTicker: settings.safetyMaxOpenPositionsPerTicker,
      maxOpenPositions: settings.safetyMaxOpenPositions,
      maxOrdersPerDay: settings.safetyMaxOrdersPerDay,
      spyStressBreakerPct: settings.safetySpyStressBreakerPct,
      tickerCooldownMinutes: settings.safetyTickerCooldownMinutes,
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
      example: { accountValue: ladderExampleAccountValue, allocationPct: ladderExampleAllocationPct, pot, sharesBudget, reserve, rungCollateral, averageCost: ladderExampleAverageCost, breakEven: ladderExampleBreakEven, shockPct, floor, rungs },
    },
    volFarmerV2: {
      callMinAbsDelta: settings.volFarmerV2CallMinAbsDelta,
      callMaxAbsDelta: settings.volFarmerV2CallMaxAbsDelta,
      maxSpreadPctOfMid: settings.volFarmerV2MaxSpreadPctOfMid,
      minimumBid: baselineMinimumBid,
      maxVolumeSharePct: percent(baselineMaxVolumeShare),
      firstPositionPct: settings.volFarmerV2FirstPositionPct,
      putsStartCallYieldPct: settings.volFarmerV2PutsStartCallYieldPct,
      putMaxAbsDelta: settings.volFarmerV2PutMaxAbsDelta,
      stepRule: settings.volFarmerV2StepRule,
      stepBelowFirstBreakEvenPct: settings.volFarmerV2StepBelowFirstBreakEvenPct,
      leapsMinDte: settings.volFarmerV2LeapsMinDte,
      leapsAbsDelta: settings.volFarmerV2LeapsAbsDelta,
      leapsMaxAllocationPct: settings.volFarmerV2LeapsMaxAllocationPct,
      example: {
        accountValue: ladderExampleAccountValue,
        allocationPct: ladderExampleAllocationPct,
        pot,
        stockPrice: volFarmerV2ExampleStockPrice,
        lots: Math.floor((pot * settings.volFarmerV2FirstPositionPct) / 100 / volFarmerV2LotCost + 1e-9),
        firstBreakEven: volFarmerV2ExampleFirstBreakEven,
        impliedVolatilityPct: percent(volFarmerV2ExampleImpliedVolatility),
        stepPct: volFarmerV2Step,
        putStrikeCap: volFarmerV2PutStrikeCap(volFarmerV2ExampleFirstBreakEven, volFarmerV2Step),
        leapsEntryBelowSecondBreakEvenPct: volFarmerV2Step / 2,
        leapsCap: volFarmerV2LeapsBudget(Number.POSITIVE_INFINITY, pot, settings.volFarmerV2LeapsMaxAllocationPct),
      },
    },
  };
}

export async function loadPlutoHowItWorks(): Promise<PlutoHowItWorks> {
  const [settings, unfilledOrderCancelMinutes] = await Promise.all([loadPlutoSettings(), loadOrderUnfilledCancelMinutes()]);
  return buildPlutoHowItWorks(settings, { unfilledOrderCancelMinutes });
}
