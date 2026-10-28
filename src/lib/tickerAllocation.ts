// How tickers share a pool, the same in Pluto (the pool: its capital budget) and the lab (the pool: the session's account):
// each ticker's allocation is a % of the pool, set or an equal share (Marcelo 2026-10-15), and its pot is that allocation
// raised by the excess allowance (Marcelo 2026-10-28), so the pots may add up to more than the pool, whose cash they share.

/**
 * Each ticker's allocation, % of the pool (formula approved by Marcelo 2026-10-15): a set allocation as is; every ticker
 * without one gets (100 − the set allocations) ÷ the number of tickers without one, never below 0. Example: 4 tickers,
 * one set to 40% → the other three get 20% each.
 */
export function effectiveAllocationPctBySymbol(tickers: readonly { symbol: string; allocationPct: number | null }[]): Map<string, number> {
  const setTotal = tickers.reduce((total, ticker) => total + (ticker.allocationPct ?? 0), 0);
  const unsetCount = tickers.filter((ticker) => ticker.allocationPct === null).length;
  const equalShare = unsetCount === 0 ? 0 : Math.max(0, 100 - setTotal) / unsetCount;
  return new Map(tickers.map((ticker) => [ticker.symbol, ticker.allocationPct ?? equalShare]));
}

/**
 * A ticker's pot as a share of the account's value, the pool being `poolPctOfAccount` % of it (the lab: 100):
 *   pot = allocation % × (1 + excess allowance %) × pool %
 * Example: 24 tickers on an equal share (4.1667%) and an allowance of 26.3158% on a $1,900,000 account: each pot is
 * 4.1667% × 1.263158 = 5.2632% of the account, $100,000; together $2,400,000 on the $1,900,000.
 */
export function tickerPotShare(allocationPct: number, excessAllowancePct: number, poolPctOfAccount: number): number {
  return (allocationPct * (100 + excessAllowancePct) * poolPctOfAccount) / 1_000_000;
}
