// IB Gateway's own fixed port convention (not deployment config — this never varies).
// See PROGRESS.md "IBKR paper (demo) trading account" decision.
export const ibkrGatewayPortByTradingMode: Record<"paper" | "live", number> = {
  paper: 4002,
  live: 4001,
};

// IBKR allows 50 outbound messages per second for ALL API clients of one
// Gateway combined (verified against IBKR's docs 2026-09-23). @stoqey/ib
// rate-limits per IBApi instance (default 40/s), so several instances on one
// Gateway — the web dyno's shared read + live connections, its one-shot
// connections, the VPS worker and a Scheduler job — could add up to well
// over 50 during a subscribe burst (a 90-line pool reconcile, a 50-line
// capture batch). Per-instance caps sized so the usual concurrent set
// (shared live + shared read + one one-shot/job + worker) sums to 50:
export const ibkrMessagesPerSecondBudget = {
  /** Shared live connection (the market-data pool's subscribe bursts). */
  sharedLive: 20,
  /** Shared read connection (snapshots, account summary, contract details). */
  sharedRead: 10,
  /** Every connectToIbkrGateway one-shot: web-dyno lookups and every Scheduler job. */
  oneShot: 15,
  /** VPS worker: orders, positions, executions — a handful of messages per minute. */
  worker: 5,
} as const;
