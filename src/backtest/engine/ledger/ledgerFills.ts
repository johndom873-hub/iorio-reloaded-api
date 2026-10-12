import { flatStockCommissionPerShareDollars } from "../../../lib/commissionEstimate.js";
import { commissionPerContractDollars } from "../../../lib/optionFriction.js";
import { computeSaleFillPrice } from "../backtestBook.js";

// What a simulated order fills at and what it costs (docs/backtesting/FULL-FIDELITY-DESIGN.md §7). The engine prices
// each order with these and hands the fill to the event applier (ledgerEvents.ts), which charges the commission.
//
//   option sale      = mid − spread cost share × (ask − bid) ÷ 2
//   option purchase  = mid + spread cost share × (ask − bid) ÷ 2
//   shares bought    = stock price + $0.01          shares sold = stock price − $0.01
//   commission       = $0.68 per option contract, $0.005 per share; none at expiry or assignment

/** What a stock order gives up against the simulated stock price, per share. */
export const stockFillSlippageDollars = 0.01;

/** Sale price per share of an option: mid − spread cost share × half-spread. */
export function optionSaleFillPrice(bid: number, ask: number, spreadShareCharged: number): number {
  return computeSaleFillPrice(bid, ask, spreadShareCharged);
}

/** Purchase price per share of an option (a buyback): mid + spread cost share × half-spread. */
export function optionPurchaseFillPrice(bid: number, ask: number, spreadShareCharged: number): number {
  return (bid + ask) / 2 + (spreadShareCharged * (ask - bid)) / 2;
}

export function stockPurchaseFillPrice(stockPrice: number): number {
  return stockPrice + stockFillSlippageDollars;
}

export function stockSaleFillPrice(stockPrice: number): number {
  return stockPrice - stockFillSlippageDollars;
}

export function optionCommissionDollars(contracts: number): number {
  return commissionPerContractDollars * contracts;
}

export function stockCommissionDollars(shares: number): number {
  return flatStockCommissionPerShareDollars * shares;
}
