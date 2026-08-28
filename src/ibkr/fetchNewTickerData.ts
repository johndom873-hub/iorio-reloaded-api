import { EventName, MarketDataType, Stock } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import { captureMarketDataSnapshot } from "./captureMarketDataSnapshot.js";
import { db } from "../db/connection.js";

export interface NewTickerData {
  companyName: string | null;
  sector: string | null;
  conId: number | null;
  impliedVolatility: number | null;
  avgOptionVolume: number | null;
}

const contractDetailsTimeoutMs = 10_000;
// Shorter than captureMarketDataSnapshot's 15s batch-job default — this path
// is interactive (a person is watching a spinner), and avg_option_volume
// consistently never arrives under current delayed-data entitlements
// anyway, so waiting the full 15s just delays showing implied volatility
// (which usually does arrive within a couple seconds) for no benefit.
const interactiveMarketDataTimeoutMs = 5_000;
const contractDetailsReqId = 1;
const marketDataReqId = 2;

export interface ContractDetails {
  companyName: string | null;
  sector: string | null;
  // Null only if the lookup failed/timed out (e.g. unrecognized symbol) —
  // otherwise always present. streamTickerDetail.ts reuses this instead of
  // making its own separate reqContractDetails call for the option chain's
  // conId lookup: two concurrent reqContractDetails calls for the same
  // underlying stock, fired at connection start, were found to trigger the
  // same IBKR pacing/contention issue documented for fetchOptionChain.ts's
  // per-expiry strike lookups — see PROGRESS.md.
  conId: number | null;
}

// IBKR's `industry` field (GICS-style classification) is populated for
// individual stocks but consistently blank for ETFs — an ETF holds many
// companies across industries, so IBKR doesn't assign it one. `category`
// (e.g. "InvestmentSvc") is the closer analog IBKR does populate for funds;
// falling back to the literal "ETF" (from `stockType`) only when even that's
// blank, rather than leaving the sector null (found 2026-08-28: every ETF
// position was landing in the Dashboard/Risk & Limits "Unknown" bucket).
function resolveSector(details: { industry?: string; category?: string; stockType?: string }): string | null {
  return details.industry || details.category || (details.stockType === "ETF" ? "ETF" : null);
}

export function lookupContractDetails(
  connection: Awaited<ReturnType<typeof connectToIbkrGateway>>,
  reqId: number = contractDetailsReqId,
): Promise<ContractDetails> {
  return new Promise((resolve) => {
    let settled = false;

    const onContractDetails = (
      id: number,
      details: { longName?: string; industry?: string; category?: string; stockType?: string; contract: { conId?: number } },
    ) => {
      if (id !== reqId) return;
      finish({ companyName: details.longName || null, sector: resolveSector(details), conId: details.contract.conId ?? null });
    };

    const onEnd = (id: number) => {
      if (id === reqId) finish({ companyName: null, sector: null, conId: null });
    };

    // e.g. an invalid/unrecognized symbol — fail fast instead of waiting out
    // the full timeout for something that will never arrive.
    const onError = (_error: Error, _code: number, id: number) => {
      if (id === reqId) finish({ companyName: null, sector: null, conId: null });
    };

    const timer = setTimeout(() => finish({ companyName: null, sector: null, conId: null }), contractDetailsTimeoutMs);

    function finish(result: ContractDetails) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.contractDetails, onContractDetails);
      connection.ib.off(EventName.contractDetailsEnd, onEnd);
      connection.ib.off(EventName.error, onError);
      resolve(result);
    }

    connection.ib.on(EventName.contractDetails, onContractDetails);
    connection.ib.once(EventName.contractDetailsEnd, onEnd);
    connection.ib.on(EventName.error, onError);
  });
}

/**
 * Cached wrapper around lookupContractDetails, approved 2026-08-27 (see
 * PROGRESS.md "Contract details cache"). conId/company name/sector are
 * effectively immutable for a given symbol, but every call site below used
 * to re-fetch them live from IBKR on every single call — the exact call
 * this codebase has already hit real pacing/contention bugs on twice (the
 * AMAT 25s timeout, and firing this concurrently with a second lookup
 * silently starving both). company_name/sector were already persisted to
 * `tickers` at ticker-creation time (screener.ts); this adds `ibkr_contract_id`
 * to that same row and reads all three from there first.
 *
 * Fails open: a symbol with no `tickers` row (shouldn't happen for any of
 * today's call sites, which all operate on an already-tracked ticker, but
 * not guaranteed forever) just fetches live and returns without persisting
 * — this function never inserts a new `tickers` row itself, only updates
 * an existing one, so an arbitrary quote lookup can't silently expand the
 * tracked-ticker universe.
 *
 * Does both steps lookupContractDetails' callers used to do by hand
 * (register the promise, then fire reqContractDetails) — cache-hit callers
 * skip both entirely.
 */
export async function getCachedContractDetails(
  connection: Awaited<ReturnType<typeof connectToIbkrGateway>>,
  symbol: string,
  reqId: number = contractDetailsReqId,
): Promise<ContractDetails> {
  const ticker = await db("tickers").where({ symbol }).first();
  if (ticker?.ibkr_contract_id != null) {
    return { companyName: ticker.company_name || null, sector: ticker.sector || null, conId: ticker.ibkr_contract_id };
  }

  const detailsPromise = lookupContractDetails(connection, reqId);
  connection.ib.reqContractDetails(reqId, new Stock(symbol, "SMART", "USD"));
  const details = await detailsPromise;

  if (ticker && details.conId != null) {
    await db("tickers")
      .where({ symbol })
      .update({ ibkr_contract_id: details.conId, company_name: details.companyName, sector: details.sector });
  }

  return details;
}

/**
 * Everything needed to show a freshly-added ticker in the Screener
 * immediately, rather than waiting for the next daily capture job run:
 * company name/sector (reqContractDetails) + implied volatility/avg option
 * volume (same delayed-data capture the daily job uses). One IBKR
 * connection for both, since they're always needed together at ticker
 * creation — connects per-request and disconnects when done, same
 * rationale as the rest of the ticker-creation path (rare manual action,
 * not a hot path, not worth a persistent server-side connection).
 */
export async function fetchNewTickerData(symbol: string): Promise<NewTickerData> {
  const connection = await connectToIbkrGateway();
  try {
    connection.ib.reqMarketDataType(MarketDataType.DELAYED);

    const contractDetailsPromise = lookupContractDetails(connection);
    connection.ib.reqContractDetails(contractDetailsReqId, new Stock(symbol, "SMART", "USD"));

    const [contractDetails, marketData] = await Promise.all([
      contractDetailsPromise,
      captureMarketDataSnapshot(connection, marketDataReqId, symbol, interactiveMarketDataTimeoutMs),
    ]);

    return { ...contractDetails, ...marketData };
  } finally {
    connection.disconnect();
  }
}
