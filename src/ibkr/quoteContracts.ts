import { randomUUID } from "node:crypto";
import { OptionType } from "@stoqey/ib";
import type { IBApi } from "@stoqey/ib";
import { openCaptureQuoteWindow, type CapturedOptionQuote } from "./captureOptionQuoteBatch.js";
import { maximumQuoteBatchSize, type OptionQuote } from "./fetchOptionChain.js";
import { peekPooledQuote, type PooledQuote } from "./marketDataPool.js";
import { describeMarketDataLineShortage, releaseMarketDataLines, renewMarketDataLineReservation, reserveMarketDataLines } from "./marketDataLineBudget.js";

// One-shot option quotes for the scan/roll/refresh/assistant paths (approved
// 2026-09-24, replacing fetchOptionChain.ts's fetchQuotesForContracts and
// quoteOptionChain). Three rules, all missing before:
//   1. Pool first: a contract some open screen already streams is read from
//      marketDataPool.ts with no IBKR request at all.
//   2. Budgeted: the rest reserve at most maximumQuoteBatchSize lines (the
//      scheduled scan as a priority holder) for exactly as long as the quotes
//      take, renewed while they run.
//   3. Rolling: those lines are a rolling window (openCaptureQuoteWindow), so a
//      contract that settles in a second frees its line for the next one
//      instead of holding it to the slowest contract's ceiling.

export interface QuoteContractRequest {
  expiry: string; // YYYYMMDD
  strike: number;
  right: OptionType;
}

export interface QuoteContractsOptions {
  /** Scheduled scans only: reserve as a priority holder so live screens shed to it (see marketDataLineBudget.ts). */
  priorityLines?: boolean;
}

/** A quote is usable once it has a price (two-sided or last) and a model delta — what every ranking here needs. */
export function hasPriceAndDelta(quote: { bid: number | null; ask: number | null; last: number | null; delta: number | null }): boolean {
  const hasPrice = (quote.bid !== null && quote.ask !== null) || quote.last !== null;
  return hasPrice && quote.delta !== null;
}

const oneShotQuoteTimeoutMs = 8_000;
const reservationTtlSeconds = 30;
const reservationRenewIntervalMs = 10_000;

function fromPooledQuote(contract: QuoteContractRequest, quote: PooledQuote): OptionQuote {
  return { expiry: contract.expiry, strike: contract.strike, right: contract.right, bid: quote.bid, ask: quote.ask, last: quote.last, impliedVolatility: quote.impliedVolatility, delta: quote.delta, gamma: quote.gamma, vega: quote.vega, theta: quote.theta };
}

function fromCapturedQuote(quote: CapturedOptionQuote): OptionQuote {
  return { expiry: quote.expiry, strike: quote.strike, right: quote.right === "C" ? OptionType.Call : OptionType.Put, bid: quote.bid, ask: quote.ask, last: quote.last, impliedVolatility: quote.impliedVolatility, delta: quote.delta, gamma: quote.gamma, vega: quote.vega, theta: quote.theta };
}

export async function quoteContracts(ib: IBApi, symbol: string, contracts: QuoteContractRequest[], options: QuoteContractsOptions = {}): Promise<OptionQuote[]> {
  if (contracts.length === 0) return [];

  const quotes: OptionQuote[] = [];
  const notPooled: QuoteContractRequest[] = [];
  for (const contract of contracts) {
    const pooled = peekPooledQuote({ key: `${contract.expiry}|${contract.strike}|${contract.right}`, legType: "option", symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right });
    if (pooled && hasPriceAndDelta(pooled)) quotes.push(fromPooledQuote(contract, pooled));
    else notPooled.push(contract);
  }
  if (notPooled.length === 0) return quotes;

  // Takes what fits (approved 2026-09-24): first ask for the full window,
  // then, when the budget is short (a manual scan while the 10:00 ET capture
  // and Day Signals hold their priority lines), whatever is free — the
  // rolling window just runs narrower. Only a budget with nothing free fails.
  const wanted = Math.min(maximumQuoteBatchSize, notPooled.length);
  const holder = `${options.priorityLines ? "tradeAlertScan" : "optionQuote"}:${symbol}:${randomUUID()}`;
  const priority = options.priorityLines ?? false;
  let reservation = await reserveMarketDataLines(holder, wanted, reservationTtlSeconds, { priority });
  let lines = wanted;
  if (!reservation.ok && reservation.availableLines > 0) {
    lines = reservation.availableLines;
    reservation = await reserveMarketDataLines(holder, lines, reservationTtlSeconds, { priority });
  }
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, symbol, wanted));
  const renewTimer = setInterval(() => {
    renewMarketDataLineReservation(holder, reservationTtlSeconds).catch((error) => console.warn(`Failed to renew IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }, reservationRenewIntervalMs);

  const startedAt = Date.now();
  const window = openCaptureQuoteWindow(ib, { concurrency: lines, timeoutMs: oneShotQuoteTimeoutMs, isSettled: (quote) => quote.errorCode !== null || hasPriceAndDelta(quote) });
  try {
    const captured = await window.capture(
      symbol,
      notPooled.map((contract) => ({ expiry: contract.expiry, strike: contract.strike, right: contract.right === OptionType.Call ? "C" : "P" })),
    );
    const ready = captured.filter(hasPriceAndDelta).length;
    console.log(`${symbol}: ${captured.length} contracts quoted in ${Date.now() - startedAt}ms over ${lines} lines (${ready} with price+delta, ${quotes.length} from the pool)`);
    quotes.push(...captured.map(fromCapturedQuote));
  } finally {
    window.close();
    clearInterval(renewTimer);
    releaseMarketDataLines(holder).catch((error) => console.warn(`Failed to release IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }
  return quotes;
}

/** One contract's quote (pool first, else one line), or null when it has no usable price/delta right now. */
export async function quoteSingleContract(ib: IBApi, symbol: string, expiryYyyymmdd: string, strike: number, right: OptionType): Promise<OptionQuote | null> {
  const [quote] = await quoteContracts(ib, symbol, [{ expiry: expiryYyyymmdd, strike, right }]);
  return quote && hasPriceAndDelta(quote) ? quote : null;
}
