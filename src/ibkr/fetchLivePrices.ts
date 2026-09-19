import { EventName, MarketDataType, Option, OptionType, Stock, type IBApi } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice } from "./requestMarketData.js";

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
export async function fetchLivePrices(contracts: PriceContract[]): Promise<Record<string, number | null>> {
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

function buildContract(contract: PriceContract): Contract {
  return contract.legType === "stock"
    ? new Stock(contract.symbol, "SMART", "USD")
    : new Option(contract.symbol, contract.expiry!, contract.strike!, contract.right!, "SMART");
}

// How long to wait for FROZEN ticks to land before emitting the first
// update regardless of what's arrived — FROZEN data isn't gated on live
// market activity, so this is a short, fixed grace period, not a safety
// ceiling for something that might not happen. Measured
// (tmp/testFrozenMarketData.ts, 2026-09-09, real open option legs):
// 2.4-2.8s for all 4 legs.
const frozenGraceMs = 3_000;

/**
 * Live-upgrading variant for the SSE-backed screens (approved 2026-09-09):
 * emits FROZEN prices first — fast, reliable, not gated on a live trade
 * occurring (see fetchLivePrices' header comment on why plain REALTIME
 * snapshots are unreliable for options) — then switches to a genuine
 * REALTIME streaming subscription and emits again every time a price
 * actually changes, for as long as `signal` stays unaborted. The frozen
 * emission is clearly non-live; callers should treat it as a starting point
 * to upgrade from, not a live figure, until a post-frozen update arrives.
 * `status.frozenPhaseComplete` is false until the frozen phase has ended, so
 * a caller that would rather not show a partially-priced first reading can
 * hold back until every contract has a price or that flag turns true.
 *
 * Always opens its own one-shot connection (not the shared read
 * connection) — a stream is held open for the caller's whole SSE session,
 * which is a fundamentally different lifetime than the shared connection's
 * fast-in-fast-out reads, same reasoning as streamOrderLegQuote.ts /
 * streamTickerDetail.ts already use for their own live subscriptions.
 */
export async function streamLivePrices(
  contracts: PriceContract[],
  onUpdate: (prices: Record<string, number | null>, status: { frozenPhaseComplete: boolean }) => void,
  signal: AbortSignal,
): Promise<void> {
  if (contracts.length === 0) return;

  // Shared read connection first (no per-stream tunnel + handshake, ~5.4s
  // measured 2026-09-19), one-shot connection only when it isn't available.
  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `streamLivePrices: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }
  const connection = borrowed
    ? { ib: borrowed.ib, disconnect: borrowed.release }
    : await connectToIbkrGateway();
  const { ib } = connection;

  const priceByKey = new Map<string, number | null>();
  contracts.forEach((contract) => priceByKey.set(contract.key, null));
  const reqIdToContract = new Map<number, PriceContract>();
  const allReqIds = new Set<number>();
  let nextOneShotReqId = 1;
  const allocateReqId = () => (borrowed ? sharedReadConnection.allocateReqId() : nextOneShotReqId++);
  // False until the frozen phase has ended — reported to the caller so it
  // can hold back a partially-priced first reading (see streamLivePrices'
  // header comment).
  let frozenPhaseComplete = false;

  function onTickPrice(reqId: number, tickType: number, price: number) {
    const contract = reqIdToContract.get(reqId);
    if (!contract || price <= 0) return;
    if (!lastTickTypes.includes(tickType)) return;
    if (priceByKey.get(contract.key) === price) return;
    priceByKey.set(contract.key, price);
    onUpdate(Object.fromEntries(priceByKey), { frozenPhaseComplete });
  }

  function onError(error: Error, code: number, reqId: number) {
    const contract = reqIdToContract.get(reqId);
    if (!contract) return;
    if (isDelayedDataFallbackNotice(code)) return;
    console.error(`streamLivePrices error for ${contract.symbol} (${contract.legType}, code ${code}): ${error.message}`);
  }

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.error, onError);

  try {
    // Phase 1: FROZEN — fast, not gated on live activity. Snapshot mode so
    // IBKR doesn't leave a long-lived subscription open under these reqIds
    // (we're about to request fresh ones for phase 2 anyway).
    ib.reqMarketDataType(MarketDataType.FROZEN);
    for (const contract of contracts) {
      const reqId = allocateReqId();
      reqIdToContract.set(reqId, contract);
      allReqIds.add(reqId);
      ib.reqMktData(reqId, buildContract(contract), "", true, false);
    }
    await new Promise((resolve) => setTimeout(resolve, frozenGraceMs));
    frozenPhaseComplete = true;
    onUpdate(Object.fromEntries(priceByKey), { frozenPhaseComplete });

    if (signal.aborted) return;

    // Phase 2: switch to REALTIME, fresh reqIds, genuine streaming
    // subscription (snapshot=false) — kept open until the caller aborts.
    // Only a real change re-emits (the onTickPrice guard above), so this
    // won't spam identical values.
    reqIdToContract.clear();
    ib.reqMarketDataType(MarketDataType.REALTIME);
    for (const contract of contracts) {
      const reqId = allocateReqId();
      reqIdToContract.set(reqId, contract);
      allReqIds.add(reqId);
      ib.reqMktData(reqId, buildContract(contract), "", false, false);
    }

    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    for (const reqId of allReqIds) {
      ib.cancelMktData(reqId);
    }
    ib.removeListener(EventName.tickPrice, onTickPrice);
    ib.removeListener(EventName.error, onError);
    connection.disconnect();
  }
}
