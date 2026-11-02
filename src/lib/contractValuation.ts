import { tradingSessionsPerYear } from "./tradingSessionsHeld.js";

// A sale's yield, as every yield on the platform (Marcelo 2026-10-29): dollars per contract ÷ the contract's exposure ×
// 252 ÷ N, N the trading sessions from the quote's to the expiry's, both in full (tradingSessionsHeld.ts), at least one.

/** A per-contract dollar amount as a yearly rate on the contract's exposure over the trading sessions it is held, at least one (a yield; tradingSessionsHeld.ts). */
export function yieldOnExposure(dollars: number, exposureDollars: number, sessionsHeld: number): number {
  return (dollars / exposureDollars) * (tradingSessionsPerYear / Math.max(sessionsHeld, 1));
}
