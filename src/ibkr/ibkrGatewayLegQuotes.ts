import { EventName, MarketDataType, type IBApi } from "@stoqey/ib";
import { buildLegContract, type OrderLegPayload } from "./ibkrGatewayOrderPayload.js";
import { allocateQuoteSnapshotRequestId } from "./quoteSnapshotRequestIds.js";

// Runs on the VPS worker (hence the ibkrGateway* name): a one-shot REAL-TIME bid/ask snapshot for each leg of an order, on the
// worker's own Gateway connection, right before the order is placed. A snapshot is not a streaming line: it is requested, answered
// within a second or two, and cancelled in the same call, so it never holds one of the shared market-data lines (the 90-line budget
// leaves headroom for exactly this kind of one-shot lookup). Only real-time ticks count: IBKR substitutes DELAYED data (ticks 66/67)
// when the account is not entitled, and a 15-minute-old quote is no basis for a price check.

const bidTick = 1;
const askTick = 2;
const delayedBidTick = 66;
const delayedAskTick = 67;

export const legQuoteSnapshotTimeoutMs = 6_000;

export interface LegQuoteSnapshot {
  bid: number | null;
  ask: number | null;
}

export interface LegQuoteSnapshotResult {
  /** One entry per leg, in order; a side that did not arrive is null. */
  quotes: LegQuoteSnapshot[];
  /** What IBKR said that explains a missing quote (errors, delayed-only data), for the refusal message. */
  notes: string[];
}

type SnapshotApi = Pick<IBApi, "on" | "removeListener" | "reqMarketDataType" | "reqMktData" | "cancelMktData">;

export function fetchLegQuoteSnapshots(
  ib: SnapshotApi,
  legs: OrderLegPayload[],
  options: { timeoutMs?: number; allocateRequestId?: () => number } = {},
): Promise<LegQuoteSnapshotResult> {
  const timeoutMs = options.timeoutMs ?? legQuoteSnapshotTimeoutMs;
  const allocateRequestId = options.allocateRequestId ?? allocateQuoteSnapshotRequestId;
  const quotes: LegQuoteSnapshot[] = legs.map(() => ({ bid: null, ask: null }));
  const notes: string[] = [];
  const legIndexByRequestId = new Map<number, number>();
  const pending = new Set<number>();
  const sawDelayedOnly = new Set<number>();
  let finish: () => void = () => {};

  const isComplete = (index: number) => quotes[index]!.bid !== null && quotes[index]!.ask !== null;
  const settle = (requestId: number) => {
    if (pending.delete(requestId) && pending.size === 0) finish();
  };

  const onTickPrice = (requestId: number, field: number, price: number) => {
    const index = legIndexByRequestId.get(requestId);
    if (index === undefined) return;
    if (field === delayedBidTick || field === delayedAskTick) {
      if (price > 0) sawDelayedOnly.add(index);
      return;
    }
    if (field !== bidTick && field !== askTick) return;
    // IBKR reports -1 for "no quote on this side"; a real side is never negative. Zero is kept (a zero bid on a far out-of-the-money option).
    if (!Number.isFinite(price) || price < 0) return;
    if (field === bidTick) quotes[index]!.bid = price;
    else quotes[index]!.ask = price;
    if (isComplete(index)) settle(requestId);
  };
  const onSnapshotEnd = (requestId: number) => {
    if (legIndexByRequestId.has(requestId)) settle(requestId);
  };
  const onError = (error: Error, code: number, requestId: number) => {
    const index = legIndexByRequestId.get(requestId);
    if (index === undefined) return;
    // 10089/10091/10167: "using delayed data" notices, not failures. Informational 21xx codes likewise.
    if (code === 10089 || code === 10091 || code === 10167 || (code >= 2100 && code <= 2169)) return;
    notes.push(`IBKR error ${code} for leg ${index + 1}: ${error.message}`);
    settle(requestId);
  };

  ib.on(EventName.tickPrice, onTickPrice);
  ib.on(EventName.tickSnapshotEnd, onSnapshotEnd);
  ib.on(EventName.error, onError);

  return (async () => {
    try {
      // Connection-wide, and the worker connection holds no other subscription, so asking for real-time here disturbs nothing.
      ib.reqMarketDataType(MarketDataType.REALTIME);
      for (const [index, leg] of legs.entries()) {
        const requestId = allocateRequestId();
        legIndexByRequestId.set(requestId, index);
        pending.add(requestId);
        ib.reqMktData(requestId, buildLegContract(leg), "", true, false);
      }
      if (pending.size > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, timeoutMs);
          finish = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      for (const index of sawDelayedOnly) {
        if (!isComplete(index)) notes.push(`IBKR sent only delayed quotes for leg ${index + 1} (the account is not entitled to real-time data for it)`);
      }
      return { quotes, notes };
    } finally {
      for (const requestId of legIndexByRequestId.keys()) ib.cancelMktData(requestId);
      ib.removeListener(EventName.tickPrice, onTickPrice);
      ib.removeListener(EventName.tickSnapshotEnd, onSnapshotEnd);
      ib.removeListener(EventName.error, onError);
    }
  })();
}
