import { OptionType } from "@stoqey/ib";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { ibkrMarketDataLinesEnabled } from "../config/env.js";
import { subscribeToPooledQuote, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { LiveOptionQuote } from "../lib/optionContractKey.js";
import { maximumLiveQuoteAgeMs } from "../lib/signalSnapshotLiveQuotes.js";
import type { PlutoSettings } from "./settingsStore.js";

// Pluto's own market data (design round 4, 2026-09-28): one stock line per enabled ticker plus SPY,
// held for the session on Pluto's own IBKR connection (the shared live pool in this process), under a
// priority reservation in the shared line ledger so the web dyno's screens shed to it. The stock prices are inputs to
// the analysis (and SPY to the stress check), never triggers: Day Signals updates drive the loop (Marcelo, 2026-10-06).
// Option quotes are never streamed continuously: the contracts about to be decided on get a short burst.

export const plutoLineHolder = "pluto_agent";

export interface WatchedStock {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  previousClose: number | null;
  updatedAtMs: number | null;
}

export class PlutoMarketWatch {
  private readonly stocks = new Map<string, WatchedStock>();
  private readonly unsubscribers = new Map<string, () => void>();

  constructor(private settings: PlutoSettings) {}

  updateSettings(settings: PlutoSettings): void {
    this.settings = settings;
  }

  snapshot(symbol: string): WatchedStock | null {
    return this.stocks.get(symbol) ?? null;
  }

  spyDayChangePct(): number | null {
    const spy = this.stocks.get("SPY");
    if (!spy || spy.last === null || spy.previousClose === null || !(spy.previousClose > 0)) return null;
    return ((spy.last - spy.previousClose) / spy.previousClose) * 100;
  }

  /**
   * Subscribes one stock line per symbol plus SPY. The lines are booked by this process's quote pool, under
   * Pluto's own priority row, for exactly what is subscribed: these stock lines all session, and a burst's
   * option lines only while the burst runs. Short of lines, the pool pauses option lines first, so a burst
   * gets fewer quotes before any stock line pauses.
   */
  async watch(symbols: string[]): Promise<{ ok: boolean; detail: string }> {
    if (!ibkrMarketDataLinesEnabled()) {
      await this.stop();
      return { ok: false, detail: "IBKR market-data lines are disabled in this environment" };
    }
    const wanted = new Set([...symbols, "SPY"]);
    for (const symbol of [...this.stocks.keys()]) {
      if (!wanted.has(symbol)) {
        this.unsubscribers.get(symbol)?.();
        this.unsubscribers.delete(symbol);
        this.stocks.delete(symbol);
      }
    }
    for (const symbol of wanted) await this.subscribeStock(symbol);
    return { ok: true, detail: `${wanted.size} stock lines; a quote burst adds up to ${this.settings.burstLines} more for ${this.settings.burstSettleSeconds} s` };
  }

  /**
   * A ticker switched on mid-session (Marcelo 2026-11-25): its stock line is subscribed at once, not at housekeeping's next
   * tick, and this waits up to timeoutMs for a two-sided quote no older than maximumLiveQuoteAgeMs, so the round that
   * follows can price a share order. Answers whether one arrived; the line stays either way (housekeeping keeps or drops it).
   * Example: RKLB switched on at 15:15:41 UTC on 2026-11-25 was looked at 21 s later, before its line existed, and its
   * first purchase was blocked.
   */
  async watchNowAndAwaitQuote(symbol: string, timeoutMs: number, nowMs: () => number = Date.now, pollMs = 250): Promise<boolean> {
    if (!ibkrMarketDataLinesEnabled()) return false;
    await this.subscribeStock(symbol);
    const deadline = nowMs() + timeoutMs;
    while (!this.hasFreshTwoSidedQuote(symbol, nowMs())) {
      if (nowMs() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return true;
  }

  /** Whether the stock has a bid and an ask (bid above 0, ask at or above it) received within maximumLiveQuoteAgeMs, the order route's rule. */
  hasFreshTwoSidedQuote(symbol: string, nowMs: number): boolean {
    const stock = this.stocks.get(symbol);
    if (!stock || stock.updatedAtMs === null || nowMs - stock.updatedAtMs > maximumLiveQuoteAgeMs) return false;
    return stock.bid !== null && stock.ask !== null && stock.bid > 0 && stock.ask >= stock.bid;
  }

  /** One stock line, once: the entry is set before the subscription is awaited, so a concurrent call never subscribes it twice. */
  private async subscribeStock(symbol: string): Promise<void> {
    if (this.stocks.has(symbol)) return;
    const stock: WatchedStock = { symbol, last: null, bid: null, ask: null, previousClose: null, updatedAtMs: null };
    this.stocks.set(symbol, stock);
    const unsubscribe = await subscribeToPooledQuote({ key: `pluto-stock-${symbol}`, legType: "stock", symbol }, (quote) => this.onStockQuote(stock, quote));
    this.unsubscribers.set(symbol, unsubscribe);
  }

  private onStockQuote(stock: WatchedStock, quote: PooledQuote): void {
    stock.last = quote.last;
    stock.bid = quote.bid;
    stock.ask = quote.ask;
    if (quote.previousClose !== null) stock.previousClose = quote.previousClose;
    stock.updatedAtMs = Date.now();
  }

  /**
   * A focused quote burst: subscribes up to burstLines option contracts, waits the settle time, returns
   * every two-sided quote received with its receipt time, and releases the lines again.
   */
  async burst(symbol: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[]): Promise<LiveOptionQuote[]> {
    const chosen = contracts.slice(0, this.settings.burstLines);
    const quotes = new Map<string, LiveOptionQuote>();
    const unsubscribers: Array<() => void> = [];
    try {
      for (const contract of chosen) {
        const priceContract: PriceContract = { key: `pluto-burst-${symbol}-${contract.expiry}-${contract.strike}-${contract.right}`, legType: "option", symbol, expiry: contract.expiry.replace(/-/g, ""), strike: contract.strike, right: contract.right === "C" ? OptionType.Call : OptionType.Put };
        unsubscribers.push(
          await subscribeToPooledQuote(priceContract, (quote) => {
            if (quote.bid === null || quote.ask === null) return;
            quotes.set(priceContract.key, { expiry: contract.expiry, strike: contract.strike, right: contract.right, bid: quote.bid, ask: quote.ask, quotedAt: new Date().toISOString() });
          }),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.settings.burstSettleSeconds * 1000));
    } finally {
      for (const unsubscribe of unsubscribers) unsubscribe();
    }
    return [...quotes.values()];
  }

  async stop(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.stocks.clear();
  }
}
