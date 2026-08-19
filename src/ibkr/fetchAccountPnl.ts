import { EventName } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface AccountPnl {
  dailyPnl: number | null;
  unrealizedPnl: number | null;
  realizedPnl: number | null;
}

/**
 * One-shot connect/fetch/disconnect, following fetchAccountSummary.ts's
 * pattern. reqPnL needs a specific account ID (unlike reqAccountSummary's
 * "All" group), so this first asks for the managed-accounts list — IBKR
 * sends it automatically shortly after connecting once requested — and
 * uses the first one. Fine for this single-account paper setup; would need
 * revisiting if multiple IBKR accounts are ever managed under one login.
 */
export async function fetchAccountPnl(): Promise<AccountPnl> {
  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  const reqId = 9002;

  try {
    return await new Promise<AccountPnl>((resolve, reject) => {
      let accountId: string | null = null;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Account PnL timeout."));
      }, 15_000);

      function onManagedAccounts(accountsList: string) {
        accountId = accountsList.split(",")[0]?.trim() ?? null;
        if (!accountId) {
          cleanup();
          reject(new Error("No managed accounts returned by IBKR."));
          return;
        }
        ib.reqPnL(reqId, accountId);
      }

      function onPnl(id: number, dailyPnL: number, unrealizedPnL?: number, realizedPnL?: number) {
        if (id !== reqId) return;
        cleanup();
        resolve({
          dailyPnl: dailyPnL,
          unrealizedPnl: unrealizedPnL ?? null,
          realizedPnl: realizedPnL ?? null,
        });
      }

      function cleanup() {
        clearTimeout(timer);
        ib.off(EventName.managedAccounts, onManagedAccounts);
        ib.off(EventName.pnl, onPnl);
      }

      ib.on(EventName.managedAccounts, onManagedAccounts);
      ib.on(EventName.pnl, onPnl);
      ib.reqManagedAccts();
    });
  } finally {
    ib.cancelPnL(reqId);
    connection.disconnect();
  }
}
