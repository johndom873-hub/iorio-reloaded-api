import { EventName, Option, OptionType, Stock, type IBApi } from "@stoqey/ib";
import type { Contract } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { isDelayedDataFallbackNotice, requestRealtimeMarketData } from "./requestMarketData.js";

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

function requestLivePrices(ib: IBApi, allocateReqId: () => number, contracts: PriceContract[]): Promise<Record<string, number | null>> {
  requestRealtimeMarketData(ib);

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
    // Real-time last=4, delayed last=68 — see fetchOptionChain.ts's comment
    // on why both are accepted.
    if (tickType !== 4 && tickType !== 68) return;
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
 * instead of Greeks. Used by the daily P&L snapshot job to mark open
 * positions to market (see the unrealized-P&L formula sign-off, 2026-08-20).
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
