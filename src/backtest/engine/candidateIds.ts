// The id an action records for the contract it sold: "SMCI:cash_secured_put:2026-03-20:47". Stored with every session's
// actions (backtest_actions.candidate_id), so the format never changes.

export function openCandidateId(symbol: string, candidate: { strategyKey: "covered_call" | "cash_secured_put"; expiry: string; strike: number }): string {
  return `${symbol}:${candidate.strategyKey}:${candidate.expiry}:${candidate.strike}`;
}
