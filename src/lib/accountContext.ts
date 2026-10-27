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
