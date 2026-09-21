// IBKR paper account ids start with "DU" (e.g. DUR######); live individual
// accounts are "U" + digits. Anything else, a mix of both, or no accounts at
// all is "unknown" — never guessed, since this feeds a paper/live safety check.
export type DetectedTradingMode = "paper" | "live" | "unknown";

export function detectTradingModeFromAccountIds(accountIds: string[]): DetectedTradingMode {
  if (accountIds.length === 0) return "unknown";
  if (accountIds.every((accountId) => /^DU/i.test(accountId))) return "paper";
  if (accountIds.every((accountId) => /^U\d+$/i.test(accountId))) return "live";
  return "unknown";
}
