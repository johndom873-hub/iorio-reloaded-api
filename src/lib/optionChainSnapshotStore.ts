import { db } from "../db/connection.js";
import type { OptionChainMarketDataType, OptionChainSnapshotStatus, SnapshotCoverage } from "./optionChainCaptureCoverage.js";

// Writes one ticker's capture to option_chain_snapshots + option_quote_snapshots
// (schema: migration 20260921000001). A same-day re-run REPLACES that day's
// snapshot (approved 2026-09-21): the existing header for (ticker, trading
// date) is deleted — its contracts go with it via ON DELETE CASCADE — and a
// fresh header + contracts are inserted, all inside one transaction, so a
// snapshot is never half-saved and a failed replace leaves the previous one
// intact.

export interface OptionChainSnapshotHeaderInput {
  tickerId: string;
  /** Eastern-time trading date, YYYY-MM-DD. */
  tradingDate: string;
  capturedAt: Date;
  underlyingPrice: number | null;
  riskFreeRatePercent: number | null;
  nextExDividendDate: string | null;
  nextExDividendAmount: number | null;
  referenceImpliedVolatility: number | null;
  marketDataType: OptionChainMarketDataType;
  coverage: SnapshotCoverage;
  captureDurationMs: number | null;
  status: OptionChainSnapshotStatus;
  errorMessage: string | null;
}

export interface OptionQuoteToStore {
  expiry: string; // YYYYMMDD, as IBKR uses it
  strike: number;
  right: "C" | "P";
  bid: number | null;
  ask: number | null;
  last: number | null;
  bidSize: number | null;
  askSize: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  modelOptionPrice: number | null;
  underlyingPrice: number | null;
  openInterest: number | null;
  volume: number | null;
}

// 18 columns per row; Postgres allows 65,535 bind parameters per statement.
const quoteInsertChunkSize = 1_500;

export function formatExpiryAsIsoDate(expiryYyyymmdd: string): string {
  if (!/^\d{8}$/.test(expiryYyyymmdd)) throw new Error(`Expected a YYYYMMDD expiry, got "${expiryYyyymmdd}"`);
  return `${expiryYyyymmdd.slice(0, 4)}-${expiryYyyymmdd.slice(4, 6)}-${expiryYyyymmdd.slice(6, 8)}`;
}

export function formatIsoDateAsExpiry(dateIso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) throw new Error(`Expected a YYYY-MM-DD date, got "${dateIso}"`);
  return dateIso.replaceAll("-", "");
}

/**
 * Child rows for the insert. A contract that appears twice (e.g. once from the
 * first pass and once from a starved-ticker re-capture) collapses to its LAST
 * occurrence, since the table's primary key allows one row per contract.
 */
export function buildQuoteRows(snapshotId: string, quotes: OptionQuoteToStore[]): Record<string, unknown>[] {
  const rowsByContract = new Map<string, Record<string, unknown>>();
  for (const quote of quotes) {
    const expiry = formatExpiryAsIsoDate(quote.expiry);
    rowsByContract.set(`${expiry}|${quote.strike}|${quote.right}`, {
      snapshot_id: snapshotId,
      expiry,
      strike: quote.strike,
      option_right: quote.right,
      bid: quote.bid,
      ask: quote.ask,
      last: quote.last,
      bid_size: quote.bidSize,
      ask_size: quote.askSize,
      implied_volatility: quote.impliedVolatility,
      delta: quote.delta,
      gamma: quote.gamma,
      vega: quote.vega,
      theta: quote.theta,
      model_option_price: quote.modelOptionPrice,
      underlying_price: quote.underlyingPrice,
      open_interest: quote.openInterest,
      volume: quote.volume,
    });
  }
  return Array.from(rowsByContract.values());
}

/** Returns the new snapshot's id. */
export async function saveOptionChainSnapshot(header: OptionChainSnapshotHeaderInput, quotes: OptionQuoteToStore[]): Promise<string> {
  return db.transaction(async (transaction) => {
    await transaction("option_chain_snapshots").where({ ticker_id: header.tickerId, trading_date: header.tradingDate }).delete();

    const [inserted] = await transaction("option_chain_snapshots")
      .insert({
        ticker_id: header.tickerId,
        trading_date: header.tradingDate,
        captured_at: header.capturedAt,
        underlying_price: header.underlyingPrice,
        risk_free_rate_percent: header.riskFreeRatePercent,
        next_ex_dividend_date: header.nextExDividendDate,
        next_ex_dividend_amount: header.nextExDividendAmount,
        reference_implied_volatility: header.referenceImpliedVolatility,
        market_data_type: header.marketDataType,
        contracts_requested: header.coverage.contractsRequested,
        contracts_with_any_tick: header.coverage.contractsWithAnyTick,
        contracts_with_two_sided_quote: header.coverage.contractsWithTwoSidedQuote,
        contracts_with_implied_volatility: header.coverage.contractsWithImpliedVolatility,
        capture_duration_ms: header.captureDurationMs,
        status: header.status,
        error_message: header.errorMessage,
      })
      .returning("id");
    const snapshotId = inserted.id as string;

    const rows = buildQuoteRows(snapshotId, quotes);
    for (let start = 0; start < rows.length; start += quoteInsertChunkSize) {
      await transaction("option_quote_snapshots").insert(rows.slice(start, start + quoteInsertChunkSize));
    }
    return snapshotId;
  });
}
