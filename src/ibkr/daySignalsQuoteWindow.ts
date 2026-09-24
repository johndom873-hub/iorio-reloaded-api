import { EventName, Option, OptionType, Stock, type Contract, type IBApi } from "@stoqey/ib";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";

// The Day Signals loop's quote fetcher (approved 2026-09-24): a rolling
// window of N market-data lines over a list of contracts. Every contract
// gets its own line and is cancelled the moment it settles, and the next
// contract takes the slot — no batch barrier waiting on the slowest
// contract (captureOptionQuoteBatch.ts's shape, where one far-OTM contract
// that never quotes holds every line to the ceiling). Throughput is
// therefore N ÷ the average settle time, not N ÷ the ceiling.
//
// A contract settles on: a two-sided quote (bid and ask both > 0); an
// explicit IBKR "no data" (-1) on either side, which is how an unquoted
// contract answers (seen live 2026-09-21 pre-market — whether it also holds
// during the session is one of the things the staging soak checks); an
// IBKR error for its request; or the per-contract timeout. Bid/ask/last are
// the only fields needed: scoring computes delta, vega and IV from the
// fitted surface itself (signalCandidates.ts).

const bidTickTypes = new Set([1, 66]);
const askTickTypes = new Set([2, 67]);
const lastTickTypes = new Set([4, 68]);

export interface WindowContract {
  key: string;
  legType: "stock" | "option";
  symbol: string;
  expiry?: string; // YYYYMMDD, options only
  strike?: number;
  right?: "C" | "P";
}

export interface WindowQuote {
  bid: number | null;
  ask: number | null;
  last: number | null;
  errorCode: number | null;
  timedOut: boolean;
  settledAt: Date;
}

export interface RollingQuoteWindowOptions {
  ib: IBApi;
  allocateReqId: () => number;
  concurrency: number;
  timeoutMs: number;
  signal: AbortSignal;
  onSettled: (contract: WindowContract, quote: WindowQuote) => void;
  now?: () => Date;
}

export interface RollingQuoteWindowResult {
  settled: number;
  /** True when the IBKR connection dropped mid-run: in-flight contracts were abandoned (not reported) and the rest of the list never ran. */
  disconnected: boolean;
  aborted: boolean;
}

interface Pending {
  contract: WindowContract;
  bid: number | null;
  ask: number | null;
  last: number | null;
  noDataOnASide: boolean;
  timer: ReturnType<typeof setTimeout>;
}

function buildIbkrContract(contract: WindowContract): Contract {
  return contract.legType === "stock" ? new Stock(contract.symbol, "SMART", "USD") : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right === "C" ? OptionType.Call : OptionType.Put, "SMART");
}

export function runRollingQuoteWindow(contracts: WindowContract[], options: RollingQuoteWindowOptions): Promise<RollingQuoteWindowResult> {
  const now = options.now ?? (() => new Date());
  return new Promise<RollingQuoteWindowResult>((resolve) => {
    const queue = [...contracts];
    const pending = new Map<number, Pending>();
    let settledCount = 0;
    let finished = false;

    function finish(result: Omit<RollingQuoteWindowResult, "settled">): void {
      if (finished) return;
      finished = true;
      for (const [reqId, entry] of pending) {
        clearTimeout(entry.timer);
        try {
          options.ib.cancelMktData(reqId);
        } catch {
          // the connection may already be gone
        }
      }
      pending.clear();
      options.ib.removeListener(EventName.tickPrice, onTickPrice);
      options.ib.removeListener(EventName.error, onError);
      options.ib.removeListener(EventName.disconnected, onDisconnected);
      options.signal.removeEventListener("abort", onAbort);
      resolve({ ...result, settled: settledCount });
    }

    function settle(reqId: number, errorCode: number | null, timedOut: boolean): void {
      const entry = pending.get(reqId);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(reqId);
      options.ib.cancelMktData(reqId);
      settledCount += 1;
      options.onSettled(entry.contract, { bid: entry.bid, ask: entry.ask, last: entry.last, errorCode, timedOut, settledAt: now() });
      pump();
    }

    function pump(): void {
      if (finished) return;
      while (pending.size < options.concurrency && queue.length > 0) {
        const contract = queue.shift()!;
        const reqId = options.allocateReqId();
        const entry: Pending = { contract, bid: null, ask: null, last: null, noDataOnASide: false, timer: setTimeout(() => settle(reqId, null, true), options.timeoutMs) };
        pending.set(reqId, entry);
        options.ib.reqMktData(reqId, buildIbkrContract(contract), "", false, false);
      }
      if (pending.size === 0 && queue.length === 0) finish({ disconnected: false, aborted: false });
    }

    function onTickPrice(reqId: number, tickType: number, price: number): void {
      const entry = pending.get(reqId);
      if (!entry) return;
      const value = price > 0 ? price : null;
      if (bidTickTypes.has(tickType)) {
        entry.bid = value;
        if (value === null) entry.noDataOnASide = true;
      } else if (askTickTypes.has(tickType)) {
        entry.ask = value;
        if (value === null) entry.noDataOnASide = true;
      } else if (lastTickTypes.has(tickType)) {
        entry.last = value;
        return;
      } else return;
      if ((entry.bid !== null && entry.ask !== null) || entry.noDataOnASide) settle(reqId, null, false);
    }

    function onError(_error: Error, code: number, reqId: number): void {
      if (!pending.has(reqId) || isDelayedDataFallbackNotice(code)) return;
      settle(reqId, code, false);
    }

    function onDisconnected(): void {
      finish({ disconnected: true, aborted: false });
    }

    function onAbort(): void {
      finish({ disconnected: false, aborted: true });
    }

    if (contracts.length === 0) {
      resolve({ settled: 0, disconnected: false, aborted: false });
      return;
    }
    if (options.signal.aborted) {
      resolve({ settled: 0, disconnected: false, aborted: true });
      return;
    }
    options.ib.on(EventName.tickPrice, onTickPrice);
    options.ib.on(EventName.error, onError);
    options.ib.once(EventName.disconnected, onDisconnected);
    options.signal.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
