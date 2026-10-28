import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { fetchPricesPoolFirst } from "../ibkr/pricePool.js";
import type { BaselineCommissions } from "../backtest/engine/baselineSaleSteps.js";
import { fetchOpenCycleSummaryRowsByTickerId } from "../lib/cycleBreakEvenQueries.js";
import { activeOrderRequestStatuses } from "../lib/orderRequestStatuses.js";
import { loadPreviousClose } from "../lib/tickerCalendarQueries.js";
import { loadOptionQuoteBandQuotes } from "./optionQuoteBandQuotes.js";
import { defaultOptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";
import type { LadderClock } from "./optionQuoteBandPlan.js";
import { loadLadderCycleMemory } from "./ladderCycleMemory.js";
import type { LadderLookInput } from "./ladderLook.js";
import type { LadderSale } from "./ladderLookBook.js";
import { loadOpenPositionFigures } from "./ladderLookSnapshot.js";
import { loadLadderSettingsForTicker } from "./ladderSettings.js";

// Everything one CC + Put Ladder look at a ticker reads (ladderLook.ts), given what the pass reads once for every ticker.

export interface LadderPassContext {
  now: Date;
  clock: LadderClock;
  /** Pluto's free cash for this ticker's look: the account's, less what the pass's earlier tickers just sent. */
  freeCash: number;
  /** The whole account's net liquidation value. */
  accountValue: number;
  commissions: BaselineCommissions;
  /** Pluto's maxQuoteAgeMinutes: an older band quote is left out of the look. */
  maxQuoteAgeMinutes: number;
}

/** A ticker the look could not be run on, and why; `noShock` when it lacked a shock (Telegram once a day: ladderNotices.ts). */
export interface LadderLookUnavailable {
  unavailable: string;
  noShock: boolean;
}

/** The ladder's own orders on the ticker still working (or built and not yet confirmed), as sales the look counts as filled. */
export async function loadWorkingLadderSales(symbol: string, connection: Knex = db): Promise<LadderSale[]> {
  const rows: { payload: OrderRequestPayload }[] = await connection("order_requests as orq")
    .join("pluto_actions as pa", "pa.id", "orq.pluto_action_id")
    .where("pa.execution_strategy", "cc_put_ladder")
    .whereIn("orq.status", [...activeOrderRequestStatuses])
    .whereRaw("orq.request_type like 'open_%'")
    .whereRaw("orq.payload->>'symbol' = ?", [symbol])
    .select("orq.payload");
  const sales: LadderSale[] = [];
  for (const { payload } of rows) {
    const option = payload.legs.find((leg) => leg.role === "option");
    if (!option?.strike || !option.expiry || !option.right) continue;
    const stock = payload.legs.find((leg) => leg.role === "stock");
    sales.push({
      strategyKey: payload.strategyKey === "covered_call" ? "covered_call" : "cash_secured_put",
      expiry: `${option.expiry.slice(0, 4)}-${option.expiry.slice(4, 6)}-${option.expiry.slice(6, 8)}`,
      strike: option.strike,
      right: option.right,
      contracts: option.quantity,
      optionPrice: option.unitPrice,
      sharesBought: stock?.quantity ?? 0,
      stockPrice: stock?.unitPrice ?? 0,
    });
  }
  return sales;
}

export async function loadLadderLookInput(ticker: { tickerId: string; symbol: string; tickerWeight: number }, pass: LadderPassContext, connection: Knex = db): Promise<LadderLookInput | LadderLookUnavailable> {
  const [prices, previousClose, memory, settings, positions, cycleRowsByTicker, workingSales, bandQuotes, forwardAnchors, previousSessionVolumeByContract] = await Promise.all([
    fetchPricesPoolFirst([{ key: "stock", legType: "stock", symbol: ticker.symbol }]),
    loadPreviousClose(ticker.tickerId, pass.clock.todayIso),
    loadLadderCycleMemory(ticker.tickerId, connection),
    loadLadderSettingsForTicker(ticker.symbol, connection),
    loadOpenPositionFigures(ticker.tickerId, connection),
    fetchOpenCycleSummaryRowsByTickerId([ticker.tickerId]),
    loadWorkingLadderSales(ticker.symbol, connection),
    loadOptionQuoteBandQuotes(ticker.tickerId, pass.clock.todayIso, connection),
    defaultOptionQuoteBandPlannerDependencies.loadForwardAnchors(ticker.tickerId, pass.clock.todayIso),
    defaultOptionQuoteBandPlannerDependencies.loadPreviousSessionVolume(ticker.tickerId, pass.clock.todayIso),
  ]);
  const stockPrice = prices["stock"] ?? null;
  if (stockPrice === null || !(stockPrice > 0)) return { unavailable: `${ticker.symbol}: no live stock price`, noShock: false };
  const shockPct = settings.overrideShockPct ?? settings.recommendedShockPct;
  if (shockPct === null) return { unavailable: `${ticker.symbol}: no shock (no override, and no recommended one without daily closes)`, noShock: true };
  return {
    symbol: ticker.symbol,
    now: pass.now,
    clock: pass.clock,
    stockPrice,
    previousClose: previousClose?.close ?? null,
    memory,
    shockPctIfStartingToday: shockPct,
    baseline: settings.baseline,
    book: { tickerId: ticker.tickerId, at: pass.now, stockPrice, positions, cycleRows: cycleRowsByTicker.get(ticker.tickerId)!, freeCash: pass.freeCash, accountValue: pass.accountValue, tickerWeight: ticker.tickerWeight, commissions: pass.commissions, workingSales },
    bandQuotes,
    forwardAnchors,
    previousSessionVolumeByContract,
    maxQuoteAgeMinutes: pass.maxQuoteAgeMinutes,
  };
}
