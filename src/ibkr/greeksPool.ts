import { subscribeToPooledQuote, settleGraceMs } from "./marketDataPool.js";
import type { Greeks, GreeksContract } from "./fetchLiveGreeks.js";

const emptyGreeks: Greeks = { delta: null, gamma: null, vega: null, theta: null };

function toGreeksContract(contract: GreeksContract) {
  return { key: contract.key, legType: "option" as const, symbol: contract.symbol, expiry: contract.expiry, strike: contract.strike, right: contract.right };
}

// Thin greeks-shaped view over marketDataPool.ts (the one real pool — see
// its header comment) — kept as its own file/signatures so every consumer
// migrated before the 2026-09-24 pool merge (positions.ts) needed zero
// changes when price and greeks pooling were unified into one subscription
// per contract.
export async function subscribeToPooledGreeks(contract: GreeksContract, onUpdate: (greeks: Greeks) => void): Promise<() => void> {
  return subscribeToPooledQuote(toGreeksContract(contract), (quote) =>
    onUpdate({ delta: quote.delta, gamma: quote.gamma, vega: quote.vega, theta: quote.theta, impliedVolatility: quote.impliedVolatility, underlyingPrice: quote.underlyingPrice }),
  );
}

/**
 * Streaming-handler-shaped wrapper (drop-in replacement for
 * fetchLiveGreeks.ts's streamLiveGreeks as a live-data SOURCE only — the
 * caller's own snapshot-fallback/never-regress logic for a still-empty
 * first reading is untouched): subscribes every contract, emits one
 * combined snapshot after a settle grace period, then a fresh snapshot on
 * every genuine change, until `signal` aborts. A Gateway restart is
 * invisible here, same as pricePool.ts's streamPooledPrices.
 */
export async function streamPooledGreeks(contracts: GreeksContract[], onUpdate: (greeksByKey: Record<string, Greeks>) => void, signal: AbortSignal): Promise<void> {
  if (contracts.length === 0) return;
  const greeksByKey: Record<string, Greeks> = {};
  for (const contract of contracts) greeksByKey[contract.key] = emptyGreeks;
  let settled = false;
  const emit = () => onUpdate({ ...greeksByKey });

  const unsubscribes = await Promise.all(
    contracts.map((contract) =>
      subscribeToPooledGreeks(contract, (greeks) => {
        greeksByKey[contract.key] = greeks;
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
