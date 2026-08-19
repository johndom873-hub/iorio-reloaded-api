import { EventName } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";

export interface AccountSummary {
  netLiquidationValue: number | null;
  buyingPower: number | null;
  totalCashValue: number | null;
  grossPositionValue: number | null;
}

const requestedTags = "NetLiquidation,BuyingPower,TotalCashValue,GrossPositionValue";

/** One-shot connect/fetch/disconnect, following fetchTickerOverview.ts's fetchPriceBars pattern. */
export async function fetchAccountSummary(): Promise<AccountSummary> {
  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  const reqId = 9001;

  try {
    return await new Promise<AccountSummary>((resolve, reject) => {
      const summary: AccountSummary = {
        netLiquidationValue: null,
        buyingPower: null,
        totalCashValue: null,
        grossPositionValue: null,
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Account summary timeout."));
      }, 15_000);

      function onAccountSummary(id: number, _account: string, tag: string, value: string) {
        if (id !== reqId) return;
        const numericValue = Number(value);
        if (Number.isNaN(numericValue)) return;
        if (tag === "NetLiquidation") summary.netLiquidationValue = numericValue;
        if (tag === "BuyingPower") summary.buyingPower = numericValue;
        if (tag === "TotalCashValue") summary.totalCashValue = numericValue;
        if (tag === "GrossPositionValue") summary.grossPositionValue = numericValue;
      }

      function onAccountSummaryEnd(id: number) {
        if (id !== reqId) return;
        cleanup();
        resolve(summary);
      }

      function cleanup() {
        clearTimeout(timer);
        ib.removeListener(EventName.accountSummary, onAccountSummary);
        ib.removeListener(EventName.accountSummaryEnd, onAccountSummaryEnd);
      }

      ib.on(EventName.accountSummary, onAccountSummary);
      ib.once(EventName.accountSummaryEnd, onAccountSummaryEnd);
      ib.reqAccountSummary(reqId, "All", requestedTags);
    });
  } finally {
    ib.cancelAccountSummary(reqId);
    connection.disconnect();
  }
}
