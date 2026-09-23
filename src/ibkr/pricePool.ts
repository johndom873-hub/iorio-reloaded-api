import { subscribeToPooledQuote, settleGraceMs } from "./marketDataPool.js";
import type { PriceContract } from "./fetchLivePrices.js";

// Thin price-shaped view over marketDataPool.ts (the one real pool — see its
// header comment) — kept as its own file/signatures so every consumer
// migrated before the 2026-09-24 pool merge (positions.ts, positionExposure.ts,
// tradeAlerts.ts, signalsProducers.ts, pricePerformance.ts) needed zero
// changes when price and greeks pooling were unified into one subscription
// per contract.
export async function subscribeToPooledPrice(contract: PriceContract, onUpdate: (price: number | null) => void): Promise<() => void> {
  return subscribeToPooledQuote(contract, (quote) => onUpdate(quote.last));
}

/**
 * Streaming-handler-shaped wrapper (drop-in replacement for
 * fetchLivePrices.ts's streamLivePrices as a live-data SOURCE only — every
 * caller's own snapshot-fallback/never-regress logic for a still-null first
 * reading is untouched): subscribes every contract, emits one combined
 * snapshot after a settle grace period once they've all registered, then a
 * fresh snapshot on every price change, until `signal` aborts. A Gateway
 * restart is invisible here — the underlying pool keeps this stream's
 * subscriptions registered and silently re-establishes them once the shared
 * connection recovers.
 */
export async function streamPooledPrices(
  contracts: PriceContract[],
  onUpdate: (pricesByKey: Record<string, number | null>, status: { frozenPhaseComplete: boolean }) => void,
  signal: AbortSignal,
): Promise<void> {
  if (contracts.length === 0) return;
  const pricesByKey: Record<string, number | null> = {};
  for (const contract of contracts) pricesByKey[contract.key] = null;
  let settled = false;
  const emit = () => onUpdate({ ...pricesByKey }, { frozenPhaseComplete: settled });

  const unsubscribes = await Promise.all(
    contracts.map((contract) =>
      subscribeToPooledPrice(contract, (price) => {
        pricesByKey[contract.key] = price;
        if (settled) emit();
      }),
    ),
  );
  if (signal.aborted) {
    for (const unsubscribe of unsubscribes) unsubscribe();
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, settleGraceMs));
  settled = true;
  emit();

  try {
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
}

/** Thin convenience wrapper of streamPooledPrices for stock-only symbol lists (Price Performance, Trade Alerts, Signals list) — no frozenPhaseComplete status needed by any of those callers. */
export async function streamPooledStockPrices(symbols: string[], onUpdate: (pricesBySymbol: Record<string, number | null>) => void, signal: AbortSignal): Promise<void> {
  if (symbols.length === 0) return;
  await streamPooledPrices(
    symbols.map((symbol) => ({ key: symbol, legType: "stock" as const, symbol })),
    (prices) => onUpdate(prices),
    signal,
  );
}
