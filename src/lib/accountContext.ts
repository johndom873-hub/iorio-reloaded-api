import { fetchAccountSummary, type AccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps } from "./positionExposure.js";

// The account's free cash: the cash balance less what open cash-secured puts hold.

export interface AccountContext {
  freeCash: number;
}

/** `fetchSummary` lets a caller reuse a cached summary (Pluto's agent, accountSummaryCache.ts). */
export async function loadAccountContext(fetchSummary: () => Promise<AccountSummary> = fetchAccountSummary): Promise<AccountContext> {
  const [account, cashLockedInCsps] = await Promise.all([fetchSummary(), computeCashLockedInCsps()]);
  return accountContextFromCash(account.totalCashValue, cashLockedInCsps);
}

/** The same account context from a cash figure already fetched (Pluto's system checks read the summary once per round). */
export async function accountContextFromTotalCash(totalCashValue: number | null): Promise<AccountContext> {
  return accountContextFromCash(totalCashValue, await computeCashLockedInCsps());
}

function accountContextFromCash(totalCashValue: number | null, cashLockedInCsps: number): AccountContext {
  return { freeCash: Math.max(0, (totalCashValue ?? 0) - cashLockedInCsps) };
}

export interface SettledCashForTrading {
  /** The settled cash the cash-account rule draws on; null: unknown, so nothing is bought and no Put sold. */
  settledCash: number | null;
  /** True when the total cash stands in for a settled cash IBKR did not report (the paper account only). */
  totalCashStandsIn: boolean;
}

/**
 * IBKR reports SettledCash only for a cash account. The paper account is a margin account, so it reports none, and its
 * total cash stands in (its settled cash equals its total cash there). On the live account, a cash account, none
 * reported stays unknown. Example: paper, no SettledCash, total cash $445,878 → settled cash $445,878.
 */
export function settledCashForTrading(account: Pick<AccountSummary, "settledCash" | "totalCashValue">, tradingMode: "paper" | "live"): SettledCashForTrading {
  if (account.settledCash !== null) return { settledCash: account.settledCash, totalCashStandsIn: false };
  if (tradingMode === "paper" && account.totalCashValue !== null) return { settledCash: account.totalCashValue, totalCashStandsIn: true };
  return { settledCash: null, totalCashStandsIn: false };
}
