import { EventName, MarketDataType, Option, OptionType, Stock, type IBApi } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";
import { loadFallbackStockPrices, recordStockPrices } from "../lib/priceService.js";
import { randomUUID } from "node:crypto";
import { describeMarketDataLineShortage, releaseMarketDataLines, reserveMarketDataLines } from "./marketDataLineBudget.js";

// Snapshot requests occupy lines for the seconds they are outstanding, so
// they are budgeted too (2026-09-24): one short reservation per call. The
// chain capture's spot fetch runs as a priority holder like the capture.
const snapshotReservationTtlSeconds = 15;

export interface FetchLivePricesOptions {
  priorityLines?: boolean;
}

export interface PriceContract {
  key: string;
  legType: "stock" | "option";
  symbol: string;
  expiry?: string; // YYYYMMDD, option legs only
  strike?: number; // option legs only
  right?: OptionType; // option legs only
}

// Safety-net ceiling only, not the expected outcome — see the snapshot-mode
// note below. Real measurements (tmp/testSnapshotModeForCurrentPrices.ts,
// 2026-09-09, 14 real shortlisted tickers): p90 1822ms, max 1822ms. This
// gives real headroom above that before falling back to whatever prices
// happened to arrive.
const snapshotTimeoutMs = 6_000;

// Only `last` is ever used as a price (decided 2026-09-19). IBKR also sends
// the PREVIOUS session's close (tick 9/75) with every FROZEN reading; it was
// once accepted as a fallback for contracts with no last, but it is
// yesterday's number — worse than showing nothing — and, because it arrives
// right after the last, a last-tick-wins handler priced stocks at
// yesterday's close (AAOI 98.06 shown while last was 104.90, found
// 2026-09-18). A contract with no last is simply null.
// Real-time last=4, delayed last=68 — see fetchOptionChain.ts's comment on
// why both are accepted.
const lastTickTypes = [4, 68];

function requestLivePrices(ib: IBApi, allocateReqId: () => number, contracts: PriceContract[]): Promise<Record<string, number | null>> {
  // FROZEN, not REALTIME — same reasoning as streamLivePrices' phase 1 below:
  // FROZEN returns the last known price immediately rather than gating on a
  // live trade occurring during the snapshot window, which a quiet option
  // may never produce. Fixed 2026-09-11 after this caused open positions
  // (e.g. a thinly-traded option leg) to silently lose their MV/P&L for the
  // whole position — see fetchLivePrices' own header comment.
  ib.reqMarketDataType(MarketDataType.FROZEN);

  const priceByKey = new Map<string, number | null>();
  const reqIdToContract = new Map<number, PriceContract>();
  // Tracks contracts still waiting — lets the wait below resolve as soon as
  // every requested contract is done, rather than a fixed timer. A contract
  // counts as done the moment EITHER its real price arrives OR IBKR signals
  // tickSnapshotEnd, whichever comes first — not tickSnapshotEnd alone.
  // Found 2026-09-09 (see tmp/testPortfolioContractsIsolated.ts, run on a
  // completely isolated, uncontended connection): IBKR reliably sends
  // tickSnapshotEnd for a STOCK's last price, but for an OPTION's last price
  // specifically, tickSnapshotEnd did not fire even once across 4 real
  // option legs, despite the actual price ticking in correctly for all 4 —
  // apparently gated on an actual trade occurring during the snapshot
  // window, which a quiet option may just never produce. Waiting on
  // tickSnapshotEnd alone meant every batch containing an option leg
  // (portfolio, exposure, pnl) reliably hit the full ceiling regardless of
  // account load. The data we actually want (the price) already arrived —
  // no reason to keep waiting for a second signal on top of it.
  const pendingReqIds = new Set<number>();
  let onAllReceived: (() => void) | null = null;

  function markDone(reqId: number) {
    if (pendingReqIds.delete(reqId) && pendingReqIds.size === 0) onAllReceived?.();
  }

  function onTickPrice(reqId: number, tickType: number, price: number) {
    const contract = reqIdToContract.get(reqId);
    if (!contract || price <= 0) return;
    if (!lastTickTypes.includes(tickType)) return;
    priceByKey.set(contract.key, price);
    markDone(reqId);
  }

  function onTickSnapshotEnd(reqId: number) {
    markDone(reqId);
  }

  function onError(error: Error, code: number, reqId: number) {
    const contract = reqIdToContract.get(reqId);
    if (!contract) return;
    // Informational "using delayed data" notices, expected.
    if (isDelayedDataFallbackNotice(code)) return;
    console.error(`Live price error for ${contract.symbol} (${contract.legType}, code ${code}): ${error.message}`);
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickSnapshotEnd, onTickSnapshotEnd);
  ib.on(EventName.error, onError);

  return (async () => {
    try {
      for (const contract of contracts) {
        const reqId = allocateReqId();
        reqIdToContract.set(reqId, contract);
        pendingReqIds.add(reqId);
        priceByKey.set(contract.key, null);
        const ibContract: Contract =
          contract.legType === "stock"
            ? new Stock(contract.symbol, "SMART", "USD")
            : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right!, "SMART");
        // snapshot=true — see the pendingReqIds comment above.
        ib.reqMktData(reqId, ibContract, "", true, false);
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, snapshotTimeoutMs);
        onAllReceived = () => {
          clearTimeout(timer);
          resolve();
        };
      });

      return Object.fromEntries(priceByKey);
    } finally {
      for (const reqId of reqIdToContract.keys()) {
        ib.cancelMktData(reqId);
      }
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.removeListener(EventName.tickSnapshotEnd, onTickSnapshotEnd);
      ib.removeListener(EventName.error, onError);
    }
  })();
}

/**
 * Sibling of fetchLiveGreeks.ts — same shape, but captures last price
 * instead of Greeks. Used by the Positions table's plain (non-streaming)
 * P&L endpoint and by the daily P&L snapshot job to mark open positions to
 * market (see the unrealized-P&L formula sign-off, 2026-08-20). Requests
 * FROZEN data (see requestLivePrices above) rather than REALTIME.
 *
 * Tries the shared read connection first (sharedReadConnection.ts — reused
 * across requests, no per-call connect cost) and falls back to a one-shot
 * connection only when the shared one isn't available.
 */
async function fetchLivePricesFromIbkr(contracts: PriceContract[]): Promise<Record<string, number | null>> {
  if (contracts.length === 0) return {};

  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `fetchLivePrices: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }

  if (borrowed) {
    const { ib, release } = borrowed;
    try {
      return await requestLivePrices(ib, () => sharedReadConnection.allocateReqId(), contracts);
    } finally {
      release();
    }
  }

  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  try {
    let nextReqId = 30_000;
    return await requestLivePrices(ib, () => nextReqId++, contracts);
  } finally {
    connection.disconnect();
  }
}


/**
 * Stock prices are shared platform-wide (src/lib/priceService.ts, approved 2026-09-19): every real last trade received
 * here is recorded, and a stock with no last right now is filled from the stored last known good price (or the latest
 * daily close) instead of coming back null — so every screen shows the same number. Option legs are unchanged.
 */
function stockSymbolsOf(contracts: PriceContract[]): string[] {
  return contracts.filter((contract) => contract.legType === "stock").map((contract) => contract.symbol);
}

function fillStockGaps(contracts: PriceContract[], prices: Record<string, number | null>, fallback: Map<string, { price: number }>): Record<string, number | null> {
  const filled = { ...prices };
  for (const contract of contracts) {
    if (contract.legType !== "stock" || (filled[contract.key] ?? null) !== null) continue;
    filled[contract.key] = fallback.get(contract.symbol)?.price ?? null;
  }
  return filled;
}

function recordRealStockPrices(contracts: PriceContract[], prices: Record<string, number | null>, source: "live" | "frozen"): void {
  const entries = contracts
    .filter((contract) => contract.legType === "stock" && (prices[contract.key] ?? 0) > 0)
    .map((contract) => ({ symbol: contract.symbol, price: prices[contract.key] as number, source }));
  if (entries.length > 0) void recordStockPrices(entries);
}

export async function fetchLivePrices(contracts: PriceContract[], options: FetchLivePricesOptions = {}): Promise<Record<string, number | null>> {
  if (contracts.length === 0) return {};
  const holder = `snapshot:prices:${randomUUID()}`;
  const reservation = await reserveMarketDataLines(holder, contracts.length, snapshotReservationTtlSeconds, { priority: options.priorityLines ?? false });
  if (!reservation.ok) throw new Error(describeMarketDataLineShortage(reservation, `a ${contracts.length}-contract price snapshot`, contracts.length));
  try {
    const [prices, fallback] = await Promise.all([fetchLivePricesFromIbkr(contracts), loadFallbackStockPrices(stockSymbolsOf(contracts))]);
    recordRealStockPrices(contracts, prices, "frozen");
    return fillStockGaps(contracts, prices, fallback);
  } finally {
    releaseMarketDataLines(holder).catch((error) => console.warn(`Failed to release IBKR market data line reservation ${holder}: ${error instanceof Error ? error.message : error}`));
  }
}

function buildContract(contract: PriceContract): Contract {
  return contract.legType === "stock"
    ? new Stock(contract.symbol, "SMART", "USD")
    : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right!, "SMART");
}
