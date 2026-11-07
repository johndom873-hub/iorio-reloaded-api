import { baselineMinimumBid } from "../backtest/engine/baselineSaleSteps.js";
import { volFarmerV4ImpliedMoveStep, volFarmerV4LeapsBudget, volFarmerV4PutStrikeCapOf, volFarmerV4CallMaxCommissionShareOfPremium } from "../backtest/engine/volFarmerV4Steps.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { regularCloseEt } from "../lib/marketSessionStatus.js";
import { roundToCents } from "../lib/positionOrderRules.js";
import { optionLimitCentsGivenUp, optionLimitPriceGivingUpOneCent } from "../lib/optionLimitPrice.js";
import { followTheMidCheckIntervalSeconds, maxLimitPriceChangesPerOrder } from "../lib/orderLimitPriceChanges.js";
import { tradingSessionsPerYear } from "../lib/tradingSessionsHeld.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { openingLookFallbackEtMinutes } from "./openingLook.js";
import { cancelMarginMinutes, closeMarginMinutes, hhmmFromMinutes, hhmmMinutesBefore } from "./sessionSchedule.js";
import { volFarmerV4BuyBackMinutesBeforeWindowEnd } from "./volFarmerV4LiveBook.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadEnabledPlutoTickerSettings, tickerPotFraction, type PlutoTickerSettings } from "./tickerSettingsStore.js";

// The numbers Pluto's "How it works" tab quotes (approved mockups https://claude.ai/artifact/TYdARe8Sa6RuF5Lb1E1s2b and,
// for the buyback, https://claude.ai/artifact/HwdnZHFFzJpktyUBJkjBVR; Vol Farmer v4, the CC + Put Ladder's part retired
// 2026-11-02): Pluto's live settings and the code's own constants, read from
// where the strategy reads them, so the tab cannot drift from what runs. The worked example is computed by the strategy's
// own functions on fixed example inputs. Percentages are in percent (5 = 5%), deltas as fractions, money in dollars.

/**
 * Vol Farmer v4's example: Pluto's book worth $1M, a 20% allocation, the stock at $100, a first break-even of $96 after a fall, IBKR's
 * IV at 60%; the first position rebalanced after a fall to $90 and a rise to $110.
 */
const volFarmerV4ExampleStockPrice = 100;
const volFarmerV4ExampleFirstBreakEven = 96;
const volFarmerV4ExampleImpliedVolatility = 0.6;
const volFarmerV4ExampleFallPrice = 70;
const volFarmerV4ExampleRisePrice = 130;
const volFarmerV4ExamplePlutoBookValue = 1_000_000;
const volFarmerV4ExampleAllocationPct = 20;
/** The buyback's example (Marcelo 2026-11-02): a minute before the window's end the stock is at $101, the lots' Calls struck at $100 quoted 1.05 / 1.15. */
const volFarmerV4ExampleBuyBackStockPrice = 101;
const volFarmerV4ExampleBuyBackBid = 1.05;
const volFarmerV4ExampleBuyBackAsk = 1.15;
/** The order price's example (Marcelo 2026-11-07): a Call quoted 1.49 / 1.52. */
const volFarmerV4ExampleSaleBid = 1.49;
const volFarmerV4ExampleSaleAsk = 1.52;

export interface PlutoHowItWorks {
  shared: {
    windowStartEt: string;
    windowEndEt: string;
    windowEndMinutesBeforeCloseAtLeast: number;
    /** Every ticker's pot is its allocation of Pluto's book value raised by this share (tickerPotFraction). */
    excessAllowancePct: number;
    dailyLossBreakerPct: number;
    unfilledOrderCancelMinutes: number;
    /** A premium yield a year is the sale's return × this ÷ the trading sessions it is held (tradingSessionsHeld.ts). */
    premiumYieldSessionsPerYear: number;
    /** The opening analysis runs on whatever quotes are in by this time (HH:MM ET), openingLook.ts. */
    openingLookFallbackEt: string;
  };
  /** The Safety Limits: they hold Vol Farmer v4's orders (safetyLimits.ts). */
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
  volFarmerV4: {
    /** The Calls' |delta| range, spread limit and bid minimum (a sale has no size limit: it is a limit at the live quote). */
    callMinAbsDelta: number;
    callMaxAbsDelta: number;
    maxSpreadPctOfMid: number;
    minimumBid: number;
    /** No Call is sold whose commission is more than this % of its premium. */
    callMaxCommissionPctOfPremium: number;
    /** A Call, Put or buyback goes this many cents past the mid, never past the bid or ask; a LEAPS at the mid (optionLimitPrice.ts). */
    optionCentsGivenUp: number;
    /** Follow the mid: a working Call on shares held, Put or buyback is checked every this many seconds and its limit moved, at most maxLimitChangesPerOrder times. */
    followTheMidCheckSeconds: number;
    maxLimitChangesPerOrder: number;
    /** % of the pot the first position's shares are bought with; the Puts sell on the rest. */
    firstPositionPct: number;
    putsStartCallYieldPct: number;
    putMaxAbsDelta: number;
    stepRule: PlutoSettings["volFarmerV4StepRule"];
    /** The fixed rule's Step. */
    stepBelowFirstBreakEvenPct: number;
    leapsMinDte: number;
    leapsAbsDelta: number;
    leapsMaxAllocationPct: number;
    /** v3's rules (volFarmerV4Steps.ts): the rebalancing band, % of the pot, and the choices as the settings hold them. */
    rebalanceBandPct: number;
    rebalances: PlutoSettings["volFarmerV4Rebalances"];
    firstPositionAfterCalledAway: PlutoSettings["volFarmerV4FirstPositionAfterCalledAway"];
    optionsExpiry: PlutoSettings["volFarmerV4OptionsExpiry"];
    optionsMaxDaysToExpiry: number;
    callStrikeFloor: PlutoSettings["volFarmerV4CallStrikeFloor"];
    putsSold: PlutoSettings["volFarmerV4PutsSold"];
    putStrikeCap: PlutoSettings["volFarmerV4PutStrikeCap"];
    trimsSell: PlutoSettings["volFarmerV4TrimsSell"];
    /** Top-ups take the money in to at most this % of the pot; 0: no cap. */
    topUpCapPct: number;
    /** Calls in the money at the window's end: assigned at the close, or bought back every day or before weekends only (Marcelo 2026-11-02). */
    callsInTheMoneyAtLastLook: PlutoSettings["volFarmerV4CallsInTheMoneyAtLastLook"];
    /** Always hold the stock, Pluto's setting (Marcelo 2026-11-03): "on" buys shares on any day, "off" only with a Call. */
    alwaysHoldTheStock: PlutoSettings["volFarmerV4AlwaysHoldTheStock"];
    /** The enabled tickers whose own Always hold the stock is the other value, alphabetical. */
    alwaysHoldTheStockOtherwise: string[];
    /** The buyback's minutes before the window's end, from buyBackStartsEt (HH:MM ET); a buyback still working is cancelled at buyBackCancelledAtEt on a regular day. */
    buyBackMinutesBeforeWindowEnd: number;
    buyBackStartsEt: string;
    buyBackCancelledAtEt: string;
    example: {
      /** Pluto's book value in the example: the pots' base since the Pluto and Manual books (2026-11-05). */
      plutoBookValue: number;
      allocationPct: number;
      pot: number;
      stockPrice: number;
      lots: number;
      /** The first position's target (First position % of the pot) and the band either side of it, in dollars. */
      targetDollars: number;
      bandDollars: number;
      /** The lots' value after a fall to fallPrice, and the lots held after the top-up (the same when inside the band). */
      fallPrice: number;
      valueAfterFall: number;
      lotsAfterFallTopUp: number;
      /** The top-up cap in dollars (null: no cap), and the money in (the lots' cost) once the fall's top-up is bought. */
      topUpCapDollars: number | null;
      moneyInAfterFallTopUp: number;
      /** The lots' value after a rise to risePrice, and the lots held after the trim. */
      risePrice: number;
      valueAfterRise: number;
      lotsAfterRiseTrim: number;
      firstBreakEven: number;
      impliedVolatilityPct: number;
      stepPct: number;
      putStrikeCap: number;
      /** How far below B-E2 the LEAPS is bought: half the Step, percent (Marcelo 2026-10-28). */
      leapsEntryBelowSecondBreakEvenPct: number;
      leapsCap: number;
      /** The order price: a Call quoted saleBid / saleAsk is sold at saleLimit. */
      saleBid: number;
      saleAsk: number;
      saleLimit: number;
      /** The buyback: at buyBackTimeEt the stock is at buyBackStockPrice, above the lots' Calls struck at stockPrice, quoted buyBackBid / buyBackAsk, bought back at buyBackLimit for the lots × 100 × the limit plus the commission. */
      buyBackTimeEt: string;
      buyBackStockPrice: number;
      buyBackBid: number;
      buyBackAsk: number;
      buyBackLimit: number;
      buyBackCostDollars: number;
      buyBackCommissionDollars: number;
    };
  };
}

const percent = (fraction: number) => Math.round(fraction * 1_000_000) / 10_000;

/** Pure: the tab's numbers from Pluto's settings, the platform's unfilled-order sweep and the code's constants. */
export function buildPlutoHowItWorks(settings: PlutoSettings, figures: { unfilledOrderCancelMinutes: number; tickers: readonly Pick<PlutoTickerSettings, "symbol" | "alwaysHoldTheStock">[] }): PlutoHowItWorks {
  const pot = volFarmerV4ExamplePlutoBookValue * tickerPotFraction(volFarmerV4ExampleAllocationPct, settings);
  const volFarmerV4Step = settings.volFarmerV4StepRule === "implied_move_at_put_sale" ? volFarmerV4ImpliedMoveStep(volFarmerV4ExampleImpliedVolatility).stepPct : settings.volFarmerV4StepBelowFirstBreakEvenPct;
  // A lot's cost at a price, as the steps count it (the shares and their commission).
  const lotCostAt = (price: number) => price * 100 + flatStockCommissionEstimator.perShareDollars("buy") * 100;
  const target = (pot * settings.volFarmerV4FirstPositionPct) / 100;
  const band = (pot * settings.volFarmerV4RebalanceBandPct) / 100;
  const lots = Math.floor(target / lotCostAt(volFarmerV4ExampleStockPrice) + 1e-9);
  const topUpCapDollars = settings.volFarmerV4TopUpCapPct > 0 ? (pot * settings.volFarmerV4TopUpCapPct) / 100 : null;
  const moneyInBefore = lots * lotCostAt(volFarmerV4ExampleStockPrice);
  // Step 1b's rebalancing (volFarmerV4Steps.ts rebalanceHolding): outside the band, back to floor(target ÷ a lot's cost), never
  // below one lot; a top-up buys no more lots than the cap's room over the money in pays for.
  const lotsAfterRebalanceAt = (price: number) => {
    const value = lots * 100 * price;
    if (Math.abs(value - target) <= band) return lots;
    const targetLots = Math.max(1, Math.floor(target / lotCostAt(price) + 1e-9));
    if (value >= target) return Math.min(lots, targetLots);
    const capLots = topUpCapDollars === null ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor((topUpCapDollars - moneyInBefore) / lotCostAt(price) + 1e-9));
    return lots + Math.min(Math.max(0, targetLots - lots), capLots);
  };

  return {
    shared: {
      windowStartEt: settings.windowStartEt,
      windowEndEt: settings.windowEndEt,
      windowEndMinutesBeforeCloseAtLeast: closeMarginMinutes,
      excessAllowancePct: settings.excessAllowancePct,
      dailyLossBreakerPct: settings.dailyLossBreakerPct,
      unfilledOrderCancelMinutes: figures.unfilledOrderCancelMinutes,
      premiumYieldSessionsPerYear: tradingSessionsPerYear,
      openingLookFallbackEt: hhmmFromMinutes(openingLookFallbackEtMinutes),
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
    volFarmerV4: {
      callMinAbsDelta: settings.volFarmerV4CallMinAbsDelta,
      callMaxAbsDelta: settings.volFarmerV4CallMaxAbsDelta,
      maxSpreadPctOfMid: settings.volFarmerV4MaxSpreadPctOfMid,
      minimumBid: baselineMinimumBid,
      callMaxCommissionPctOfPremium: percent(volFarmerV4CallMaxCommissionShareOfPremium),
      optionCentsGivenUp: optionLimitCentsGivenUp,
      followTheMidCheckSeconds: followTheMidCheckIntervalSeconds,
      maxLimitChangesPerOrder: maxLimitPriceChangesPerOrder,
      firstPositionPct: settings.volFarmerV4FirstPositionPct,
      putsStartCallYieldPct: settings.volFarmerV4PutsStartCallYieldPct,
      putMaxAbsDelta: settings.volFarmerV4PutMaxAbsDelta,
      stepRule: settings.volFarmerV4StepRule,
      stepBelowFirstBreakEvenPct: settings.volFarmerV4StepBelowFirstBreakEvenPct,
      leapsMinDte: settings.volFarmerV4LeapsMinDte,
      leapsAbsDelta: settings.volFarmerV4LeapsAbsDelta,
      leapsMaxAllocationPct: settings.volFarmerV4LeapsMaxAllocationPct,
      rebalanceBandPct: settings.volFarmerV4RebalanceBandPct,
      rebalances: settings.volFarmerV4Rebalances,
      firstPositionAfterCalledAway: settings.volFarmerV4FirstPositionAfterCalledAway,
      optionsExpiry: settings.volFarmerV4OptionsExpiry,
      optionsMaxDaysToExpiry: settings.volFarmerV4OptionsMaxDaysToExpiry,
      callStrikeFloor: settings.volFarmerV4CallStrikeFloor,
      putsSold: settings.volFarmerV4PutsSold,
      putStrikeCap: settings.volFarmerV4PutStrikeCap,
      trimsSell: settings.volFarmerV4TrimsSell,
      topUpCapPct: settings.volFarmerV4TopUpCapPct,
      callsInTheMoneyAtLastLook: settings.volFarmerV4CallsInTheMoneyAtLastLook,
      alwaysHoldTheStock: settings.volFarmerV4AlwaysHoldTheStock,
      alwaysHoldTheStockOtherwise: figures.tickers
        .filter((ticker) => ticker.alwaysHoldTheStock !== null && ticker.alwaysHoldTheStock !== settings.volFarmerV4AlwaysHoldTheStock)
        .map((ticker) => ticker.symbol)
        .sort(),
      buyBackMinutesBeforeWindowEnd: volFarmerV4BuyBackMinutesBeforeWindowEnd,
      buyBackStartsEt: hhmmMinutesBefore(settings.windowEndEt, volFarmerV4BuyBackMinutesBeforeWindowEnd),
      buyBackCancelledAtEt: hhmmMinutesBefore(regularCloseEt, cancelMarginMinutes),
      example: {
        plutoBookValue: volFarmerV4ExamplePlutoBookValue,
        allocationPct: volFarmerV4ExampleAllocationPct,
        pot,
        stockPrice: volFarmerV4ExampleStockPrice,
        lots,
        targetDollars: target,
        bandDollars: band,
        fallPrice: volFarmerV4ExampleFallPrice,
        valueAfterFall: lots * 100 * volFarmerV4ExampleFallPrice,
        lotsAfterFallTopUp: lotsAfterRebalanceAt(volFarmerV4ExampleFallPrice),
        topUpCapDollars,
        moneyInAfterFallTopUp: moneyInBefore + (lotsAfterRebalanceAt(volFarmerV4ExampleFallPrice) - lots) * lotCostAt(volFarmerV4ExampleFallPrice),
        risePrice: volFarmerV4ExampleRisePrice,
        valueAfterRise: lots * 100 * volFarmerV4ExampleRisePrice,
        lotsAfterRiseTrim: lotsAfterRebalanceAt(volFarmerV4ExampleRisePrice),
        firstBreakEven: volFarmerV4ExampleFirstBreakEven,
        impliedVolatilityPct: percent(volFarmerV4ExampleImpliedVolatility),
        stepPct: volFarmerV4Step,
        putStrikeCap: volFarmerV4PutStrikeCapOf(volFarmerV4ExampleFirstBreakEven, volFarmerV4Step),
        leapsEntryBelowSecondBreakEvenPct: volFarmerV4Step / 2,
        leapsCap: volFarmerV4LeapsBudget(Number.POSITIVE_INFINITY, pot, settings.volFarmerV4LeapsMaxAllocationPct),
        buyBackTimeEt: hhmmMinutesBefore(settings.windowEndEt, 1),
        saleBid: volFarmerV4ExampleSaleBid,
        saleAsk: volFarmerV4ExampleSaleAsk,
        saleLimit: optionLimitPriceGivingUpOneCent(volFarmerV4ExampleSaleBid, volFarmerV4ExampleSaleAsk, "sell"),
        buyBackStockPrice: volFarmerV4ExampleBuyBackStockPrice,
        buyBackBid: volFarmerV4ExampleBuyBackBid,
        buyBackAsk: volFarmerV4ExampleBuyBackAsk,
        buyBackLimit: optionLimitPriceGivingUpOneCent(volFarmerV4ExampleBuyBackBid, volFarmerV4ExampleBuyBackAsk, "buy"),
        buyBackCostDollars: roundToCents(optionLimitPriceGivingUpOneCent(volFarmerV4ExampleBuyBackBid, volFarmerV4ExampleBuyBackAsk, "buy") * 100 * lots),
        buyBackCommissionDollars: roundToCents(flatCommissionEstimator.perContractDollars("buy", lots) * lots),
      },
    },
  };
}

export async function loadPlutoHowItWorks(): Promise<PlutoHowItWorks> {
  const [settings, unfilledOrderCancelMinutes, tickers] = await Promise.all([loadPlutoSettings(), loadOrderUnfilledCancelMinutes(), loadEnabledPlutoTickerSettings()]);
  return buildPlutoHowItWorks(settings, { unfilledOrderCancelMinutes, tickers });
}
