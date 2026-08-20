import { EventName } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface AccountLedgerPnl {
  realizedPnl: number | null;
  unrealizedPnl: number | null;
}

/**
 * Replaces the old reqPnL-based fetchAccountPnl.ts (deleted 2026-08-20) —
 * reqPnL proved unreliable against the paper account (two full ~200s
 * subscription attempts, ~400s combined, produced zero pnl events; see
 * git history for the diagnostics). reqAccountUpdates' $LEDGER-* values
 * carry the same realized/unrealized figures and, like reqAccountSummary,
 * respond within under a second every time it's been tested.
 *
 * IBKR breaks $LEDGER values out per currency plus one "BASE" entry that's
 * the account-total figure converted to the account's base currency —
 * that's the one this reads; per-currency entries (e.g. "SGD") are
 * ignored. There is no daily_pnl equivalent in this data — that field is
 * intentionally left unpopulated by the daily snapshot job (2026-08-20
 * decision: not worth resurrecting the broken reqPnL path just for it).
 */
export async function fetchAccountLedgerPnl(): Promise<AccountLedgerPnl> {
  const connection = await connectToIbkrGateway();
  const { ib } = connection;

  try {
    return await new Promise<AccountLedgerPnl>((resolve, reject) => {
      const ledger: AccountLedgerPnl = { realizedPnl: null, unrealizedPnl: null };
      let accountName: string | null = null;

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Account ledger PnL timeout."));
      }, 15_000);

      function onUpdateAccountValue(key: string, value: string, currency: string, account: string) {
        accountName = account;
        if (currency !== "BASE") return;
        const numericValue = Number(value);
        if (Number.isNaN(numericValue)) return;
        if (key === "$LEDGER-RealizedPnL") ledger.realizedPnl = numericValue;
        if (key === "$LEDGER-UnrealizedPnL") ledger.unrealizedPnl = numericValue;
      }

      function onAccountDownloadEnd() {
        cleanup();
        resolve(ledger);
      }

      function cleanup() {
        clearTimeout(timer);
        ib.off(EventName.updateAccountValue, onUpdateAccountValue);
        ib.off(EventName.accountDownloadEnd, onAccountDownloadEnd);
        if (accountName) ib.reqAccountUpdates(false, accountName);
      }

      ib.on(EventName.updateAccountValue, onUpdateAccountValue);
      ib.on(EventName.accountDownloadEnd, onAccountDownloadEnd);
      ib.reqAccountUpdates(true, "");
    });
  } finally {
    connection.disconnect();
  }
}
