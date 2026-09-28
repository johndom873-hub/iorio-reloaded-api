import { OptionType } from "@stoqey/ib";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { releaseMarketDataLines, reserveMarketDataLines } from "../ibkr/marketDataLineBudget.js";
import { subscribeToPooledQuote, type PooledQuote } from "../ibkr/marketDataPool.js";
import type { LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import type { PlutoSettings } from "./settingsStore.js";

// Pluto's own market data (design round 4, 2026-09-28): one stock line per enabled ticker plus SPY,
// held for the session on Pluto's own IBKR connection (the shared live pool in this process), under a
// priority reservation in the shared line ledger so the web dyno's screens shed to it. Option quotes
// are never streamed continuously: a triggered ticker gets a short burst on a small pool of lines.

export const plutoLineHolder = "pluto_agent";
const lineReservationTtlSeconds = 120;

export interface WatchedStock {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  previousClose: number | null;
  /** Spot at the ticker's last Pluto evaluation; the spot-move trigger measures against it. */
  evaluatedAtSpot: number | null;
  updatedAtMs: number | null;
}

export interface SpotMoveTrigger {
  symbol: string;
  spot: number;
  fromSpot: number;
  movePct: number;
}

export type SpotMoveListener = (trigger: SpotMoveTrigger) => void;

export class PlutoMarketWatch {
  private readonly stocks = new Map<string, WatchedStock>();
  private readonly unsubscribers = new Map<string, () => void>();
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private linesHeld = 0;
  private listener: SpotMoveListener | null = null;

  constructor(private settings: PlutoSettings) {}

  updateSettings(settings: PlutoSettings): void {
    this.settings = settings;
  }

  onSpotMove(listener: SpotMoveListener): void {
    this.listener = listener;
  }

  snapshot(symbol: string): WatchedStock | null {
    return this.stocks.get(symbol) ?? null;
  }

  spyDayChangePct(): number | null {
    const spy = this.stocks.get("SPY");
    if (!spy || spy.last === null || spy.previousClose === null || !(spy.previousClose > 0)) return null;
    return ((spy.last - spy.previousClose) / spy.previousClose) * 100;
  }

  /** Records the spot a ticker was just evaluated at, so the next trigger measures from here. */
  markEvaluated(symbol: string): void {
    const stock = this.stocks.get(symbol);
    if (stock) stock.evaluatedAtSpot = stock.last;
  }

  /** Reserves lines for the given symbols (+ SPY + the burst pool) and (re)subscribes their stock lines. */
  async watch(symbols: string[]): Promise<{ ok: boolean; detail: string }> {
    const wanted = new Set([...symbols, "SPY"]);
    const linesNeeded = wanted.size + this.settings.burstLines;
    const reservation = await reserveMarketDataLines(plutoLineHolder, linesNeeded, lineReservationTtlSeconds, { priority: true });
    if (!reservation.ok) {
      await this.stop();
      return { ok: false, detail: reservation.disabled ? "IBKR market-data lines are disabled in this environment" : `only ${reservation.availableLines} IBKR lines free, Pluto needs ${linesNeeded}` };
    }
    this.linesHeld = linesNeeded;
    if (!this.renewTimer) {
      this.renewTimer = setInterval(() => {
        reserveMarketDataLines(plutoLineHolder, this.linesHeld, lineReservationTtlSeconds, { priority: true }).catch((error) => console.warn(`Pluto lines: renew failed — ${error instanceof Error ? error.message : error}`));
      }, (lineReservationTtlSeconds * 1000) / 3);
      this.renewTimer.unref?.();
    }
    for (const symbol of [...this.stocks.keys()]) {
      if (!wanted.has(symbol)) {
        this.unsubscribers.get(symbol)?.();
        this.unsubscribers.delete(symbol);
        this.stocks.delete(symbol);
      }
    }
    for (const symbol of wanted) {
      if (this.stocks.has(symbol)) continue;
      const stock: WatchedStock = { symbol, last: null, bid: null, ask: null, previousClose: null, evaluatedAtSpot: null, updatedAtMs: null };
      this.stocks.set(symbol, stock);
      const unsubscribe = await subscribeToPooledQuote({ key: `pluto-stock-${symbol}`, legType: "stock", symbol }, (quote) => this.onStockQuote(stock, quote));
      this.unsubscribers.set(symbol, unsubscribe);
    }
    return { ok: true, detail: `${wanted.size} stock lines + ${this.settings.burstLines} burst lines reserved` };
  }

  private onStockQuote(stock: WatchedStock, quote: PooledQuote): void {
    stock.last = quote.last;
    stock.bid = quote.bid;
    stock.ask = quote.ask;
    if (quote.previousClose !== null) stock.previousClose = quote.previousClose;
    stock.updatedAtMs = Date.now();
    if (stock.symbol === "SPY" || stock.last === null || !this.listener) return;
    if (stock.evaluatedAtSpot === null) {
      stock.evaluatedAtSpot = stock.last; // the first tick is the baseline, never a trigger
      return;
    }
    const movePct = Math.abs((stock.last - stock.evaluatedAtSpot) / stock.evaluatedAtSpot) * 100;
    if (movePct >= this.settings.spotMoveTriggerPct) this.listener({ symbol: stock.symbol, spot: stock.last, fromSpot: stock.evaluatedAtSpot, movePct });
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
    if (this.renewTimer) {
      clearInterval(this.renewTimer);
      this.renewTimer = null;
    }
    for (const unsubscribe of this.unsubscribers.values()) unsubscribe();
    this.unsubscribers.clear();
    this.stocks.clear();
    if (this.linesHeld > 0) {
      this.linesHeld = 0;
      await releaseMarketDataLines(plutoLineHolder).catch((error) => console.warn(`Pluto lines: release failed — ${error instanceof Error ? error.message : error}`));
    }
  }
}
