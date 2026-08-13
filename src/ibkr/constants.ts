// IB Gateway's own fixed port convention (not deployment config — this never varies).
// See PROGRESS.md "IBKR paper (demo) trading account" decision.
export const ibkrGatewayPortByTradingMode: Record<"paper" | "live", number> = {
  paper: 4002,
  live: 4001,
};
