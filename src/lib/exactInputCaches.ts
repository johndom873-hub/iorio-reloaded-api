// The exact-input caches of implied volatilities (impliedVolatilitySurface.ts) and valuations (contractValuation.ts)
// pay off only where the same inputs come back: a backtest scores each look ahead and then for real, from quotes that
// do not move between the two. Live inputs move with every tick, so in the API and Pluto's agent those caches would
// only fill up to their limits and stay full. They are off unless a process turns them on: the backtest job process
// and each of its scoring workers (every worker thread has its own copy of these modules).

let exactInputCachesEnabled = false;

export function enableExactInputCaches(): void {
  exactInputCachesEnabled = true;
}

export function exactInputCachesAreEnabled(): boolean {
  return exactInputCachesEnabled;
}
