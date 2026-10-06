import { OptionType } from "@stoqey/ib";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { ibkrMarketDataLinesEnabled } from "../config/env.js";
import { subscribeToPooledQuote, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { LiveOptionQuote } from "../lib/signalsLiveScoring.js";
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
    for (const symbol of wanted) {
      if (this.stocks.has(symbol)) continue;
      const stock: WatchedStock = { symbol, last: null, bid: null, ask: null, previousClose: null, updatedAtMs: null };
      this.stocks.set(symbol, stock);
      const unsubscribe = await subscribeToPooledQuote({ key: `pluto-stock-${symbol}`, legType: "stock", symbol }, (quote) => this.onStockQuote(stock, quote));
      this.unsubscribers.set(symbol, unsubscribe);
    }
    return { ok: true, detail: `${wanted.size} stock lines; a quote burst adds up to ${this.settings.burstLines} more for ${this.settings.burstSettleSeconds} s` };
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
