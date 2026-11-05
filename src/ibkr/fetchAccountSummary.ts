import { EventName, type IBApi } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { sharedReadConnection } from "./sharedReadConnection.js";
import { dedupeInFlight } from "../lib/dedupeInFlight.js";

export interface AccountSummary {
  netLiquidationValue: number | null;
  buyingPower: number | null;
  totalCashValue: number | null;
  grossPositionValue: number | null;
  // Added for Iorio Pulse's IBKR node ("Margin excess") — IBKR's own
  // "excess liquidity" figure, additive to the existing tags so every
  // existing caller (dashboard.ts, riskLimits.ts) is unaffected.
  excessLiquidity: number | null;
  // The cash account's settled cash (Marcelo 2026-10-31): IBKR refuses a purchase the settled cash does not pay for, so
  // Vol Farmer v4 sizes its purchases on it too.
  settledCash: number | null;
}

// $LEDGER:USD adds the account's USD ledger, whose ExchangeRate is the account's base currency per US dollar.
const requestedTags = "NetLiquidation,BuyingPower,TotalCashValue,SettledCash,GrossPositionValue,ExcessLiquidity,$LEDGER:USD";

const summaryFieldOfTag: Record<string, keyof AccountSummary> = {
  NetLiquidation: "netLiquidationValue",
  BuyingPower: "buyingPower",
  TotalCashValue: "totalCashValue",
  GrossPositionValue: "grossPositionValue",
  ExcessLiquidity: "excessLiquidity",
  SettledCash: "settledCash",
};

export type ReportedAccountFigures = Partial<Record<keyof AccountSummary, { value: number; currency: string }>>;

/**
 * Every figure in US dollars (Marcelo 2026-11-05). IBKR sends them in the account's base currency: USD on prod, SGD on
 * staging's paper account (linked to Juan's account). A figure in another currency is divided by IBKR's exchange rate
 * (that currency per US dollar); with no usable rate the summary fails rather than show another currency as dollars.
 * Example: NetLiquidation 982,977 SGD at 1.2762 SGD per USD → $770,237.
 */
export function accountFiguresInUsd(reported: ReportedAccountFigures, usdExchangeRate: number | null): AccountSummary {
  const summary: AccountSummary = { netLiquidationValue: null, buyingPower: null, totalCashValue: null, grossPositionValue: null, excessLiquidity: null, settledCash: null };
  for (const field of Object.keys(summary) as (keyof AccountSummary)[]) {
    const figure = reported[field];
    if (figure === undefined) continue;
    if (figure.currency === "USD") {
      summary[field] = figure.value;
      continue;
    }
    if (usdExchangeRate === null || !Number.isFinite(usdExchangeRate) || !(usdExchangeRate > 0)) {
      throw new Error(`IBKR reports the account in ${figure.currency || "an unnamed currency"} and sent no exchange rate to the US dollar, so its figures cannot be shown in dollars.`);
    }
    summary[field] = figure.value / usdExchangeRate;
  }
  return summary;
}

function requestAccountSummary(ib: IBApi, reqId: number): Promise<AccountSummary> {
  return new Promise<AccountSummary>((resolve, reject) => {
    const reported: ReportedAccountFigures = {};
    let usdExchangeRate: number | null = null;

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Account summary timeout."));
    }, 15_000);

    function onAccountSummary(id: number, _account: string, tag: string, value: string, currency: string) {
      if (id !== reqId) return;
      // An empty string is "no value", not zero: Number("") is 0, which would record a figure IBKR never sent.
      if (value.trim() === "") return;
      const numericValue = Number(value);
      if (Number.isNaN(numericValue)) return;
      if (tag === "$LEDGER-ExchangeRate" && currency === "USD") usdExchangeRate = numericValue;
      const field = summaryFieldOfTag[tag];
      if (field) reported[field] = { value: numericValue, currency };
    }

    function onAccountSummaryEnd(id: number) {
      if (id !== reqId) return;
      cleanup();
      try {
        resolve(accountFiguresInUsd(reported, usdExchangeRate));
      } catch (error) {
        reject(error);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      ib.removeListener(EventName.accountSummary, onAccountSummary);
      ib.removeListener(EventName.accountSummaryEnd, onAccountSummaryEnd);
    }

    // .on(), not .once() — see project_eventemitter_once_concurrent_listeners
    // memory. On the shared connection (sharedReadConnection.ts), multiple
    // concurrent fetchAccountSummary() calls register their own
    // onAccountSummaryEnd on the same IBApi instance. A .once() listener
    // self-removes on the *next* emission of accountSummaryEnd regardless of
    // which reqId it carries — so one call's real completion silently
    // unregisters every other in-flight call's listener before its own
    // accountSummaryEnd ever arrives, hanging it until the 15s timeout. Real
    // bug hit 2026-09-09: Dashboard fires /available-cash and /portfolio
    // concurrently, both call this — the second one timed out and rendered
    // "–" instead of a real number. cleanup() below still removes this
    // listener explicitly once *this* call's own reqId actually completes.
    ib.on(EventName.accountSummary, onAccountSummary);
    ib.on(EventName.accountSummaryEnd, onAccountSummaryEnd);
    ib.reqAccountSummary(reqId, "All", requestedTags);
  });
}

/**
 * Tries the shared read connection first (sharedReadConnection.ts — reused
 * across requests, no per-call connect cost) and only falls back to the
 * one-shot connect/fetch/disconnect pattern below when the shared connection
 * itself isn't available. A failure *during* the account summary request
 * (e.g. a timeout) is not treated as a reason to fall back and retry — it
 * propagates normally, same as before this change.
 *
 * Deduplicated (see dedupeInFlight.ts) — /dashboard/portfolio and
 * /risk-limits/exposure both call this with no arguments, and load together
 * on the Dashboard.
 */
export const fetchAccountSummary = dedupeInFlight(fetchAccountSummaryUncached);

async function fetchAccountSummaryUncached(): Promise<AccountSummary> {
  let borrowed: Awaited<ReturnType<typeof sharedReadConnection.borrow>> | null = null;
  try {
    borrowed = await sharedReadConnection.borrow();
  } catch (error) {
    console.log(
      `fetchAccountSummary: shared read connection unavailable (${error instanceof Error ? error.message : error}), falling back to a one-shot connection.`,
    );
  }

  if (borrowed) {
    const { ib, release } = borrowed;
    const reqId = sharedReadConnection.allocateReqId();
    try {
      return await requestAccountSummary(ib, reqId);
    } finally {
      ib.cancelAccountSummary(reqId);
      release();
    }
  }

  const connection = await connectToIbkrGateway();
  const { ib } = connection;
  const reqId = 9001;
  try {
    return await requestAccountSummary(ib, reqId);
  } finally {
    ib.cancelAccountSummary(reqId);
    connection.disconnect();
  }
}
