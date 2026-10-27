import { baselineMaxVolumeShare, baselineMinimumBid } from "../backtest/engine/baselineSaleSteps.js";
import { ladderBudget, ladderRungCollateral, ladderStrikeCap } from "../backtest/engine/backtestBaselineLadder.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { ladderFixedBaselineChoices } from "./ladderSettings.js";
import { closeMarginMinutes } from "./sessionSchedule.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";

// The numbers Pluto's "How it works" tab quotes (approved mockup https://claude.ai/artifact/TYdARe8Sa6RuF5Lb1E1s2b; the
// CC + Put Ladder only since Signals was retired, 2026-10-27): Pluto's live settings and the code's own constants, read
// from where the ladder reads them, so the tab cannot drift from what runs. The worked example is computed by the
// ladder's own strike-cap functions on fixed example inputs. Percentages are in percent (5 = 5%), deltas as fractions,
// money in dollars.

/** The ladder example's fixed inputs: a $2M account, a 20% allocation, shares bought at $104 with a $100 break-even. */
const ladderExampleAccountValue = 2_000_000;
const ladderExampleAllocationPct = 20;
const ladderExampleAverageCost = 104;
const ladderExampleBreakEven = 100;
const ladderExampleShockPct = 70;

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
}

const percent = (fraction: number) => Math.round(fraction * 1_000_000) / 10_000;

/** Pure: the tab's numbers from Pluto's settings, the platform's unfilled-order sweep and the code's constants. */
export function buildPlutoHowItWorks(settings: PlutoSettings, figures: { unfilledOrderCancelMinutes: number }): PlutoHowItWorks {
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


  return {
    shared: {
      windowStartEt: settings.windowStartEt,
      windowEndEt: settings.windowEndEt,
      windowEndMinutesBeforeCloseAtLeast: closeMarginMinutes,
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
  };
}

export async function loadPlutoHowItWorks(): Promise<PlutoHowItWorks> {
  const [settings, unfilledOrderCancelMinutes] = await Promise.all([loadPlutoSettings(), loadOrderUnfilledCancelMinutes()]);
  return buildPlutoHowItWorks(settings, { unfilledOrderCancelMinutes });
}
