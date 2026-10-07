import { fetchAccountSummary, type AccountSummary } from "../ibkr/fetchAccountSummary.js";

// Pluto's account summary, reused for up to a minute (Marcelo, 2026-10-07). Every analysis round asked IBKR twice (the system
// checks' account value and the sizing's free cash), about 3,000 times a session; IBKR itself refreshes these values about every
// three minutes, and the order routes re-check cash when an order is confirmed. A failed request is never cached.

export const accountSummaryCacheMs = 60_000;

let cached: { summary: AccountSummary; fetchedAtMs: number } | null = null;
let inFlight: Promise<AccountSummary> | null = null;

export async function fetchPlutoAccountSummary(nowMs: number = Date.now(), fetch: () => Promise<AccountSummary> = fetchAccountSummary): Promise<AccountSummary> {
  if (cached && nowMs - cached.fetchedAtMs < accountSummaryCacheMs) return cached.summary;
  inFlight ??= fetch()
    .then((summary) => {
      cached = { summary, fetchedAtMs: Date.now() };
      return summary;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Test hook. */
export function resetPlutoAccountSummaryCacheForTests(): void {
  cached = null;
  inFlight = null;
}
