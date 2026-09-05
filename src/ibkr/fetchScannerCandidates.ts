import { EventName, Instrument, LocationCode, ScanCode, type ContractDetails } from "@stoqey/ib";
import type { IbkrConnection } from "./connectIbkr.js";

const scanTimeoutMs = 20_000;
const defaultNumberOfRows = 50;
const defaultMarketCapAboveUsd = 1_000_000_000;

export interface ScannerCandidate {
  symbol: string;
  companyName: string | null;
  sector: string | null;
  conId: number | null;
  rank: number;
  scanCode: ScanCode;
  // Raw scannerData fields, kept alongside the parsed numeric value below —
  // NOT YET VERIFIED against live market data (see tmp/testScannerSubscription.ts;
  // every field came back empty on a weekend run with no market data).
  // ivVsHistRatio is best-effort parsed from `benchmark`/`projection` and is
  // null whenever the format doesn't match a plain number, rather than risk
  // storing a wrong value.
  rawBenchmark: string;
  rawProjection: string;
  ivVsHistRatio: number | null;
}

// Same industry/category-with-ETF-fallback logic as fetchNewTickerData.ts's
// resolveSector — kept duplicated (not imported) since scannerData's
// ContractDetails shape and reqContractDetails' callback shape are distinct
// types in @stoqey/ib, even though the fields happen to be named alike.
function resolveSector(details: { industry?: string; category?: string; stockType?: string }): string | null {
  return details.industry || details.category || (details.stockType === "ETF" ? "ETF" : null);
}

// benchmark/projection are documented by IBKR as scan-specific free-form
// strings, populated for some scan codes and blank for others — parse
// defensively, never throw, never guess at a value that doesn't parse
// cleanly as a plain decimal.
function parseNumericField(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^0-9.\-]/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Runs one IBKR market scanner subscription (reqScannerSubscription) to
 * completion and resolves with every row returned. Caller owns the
 * connection's lifecycle; reqId must not be in use elsewhere on it.
 *
 * Universe/liquidity filters are the native IBKR scan params (see
 * PROGRESS.md's Screener discovery decision, 2026-09-05): US-listed common
 * stock + ETF only, market cap floor. IV/volume-based filtering happens via
 * scanCode selection, not a numeric param — IBKR has no raw "IV between X
 * and Y" filter.
 */
export function runScannerSubscription(
  connection: IbkrConnection,
  scanCode: ScanCode,
  reqId: number,
  options: { numberOfRows?: number; marketCapAboveUsd?: number; abovePriceUsd?: number } = {},
): Promise<ScannerCandidate[]> {
  return new Promise((resolve) => {
    const candidates: ScannerCandidate[] = [];

    const onScannerData = (
      id: number,
      rank: number,
      contractDetails: ContractDetails,
      _distance: string,
      benchmark: string,
      projection: string,
    ) => {
      if (id !== reqId) return;
      const contract = contractDetails.contract;
      if (!contract.symbol) return;

      candidates.push({
        symbol: contract.symbol,
        companyName: contractDetails.longName || null,
        sector: resolveSector(contractDetails),
        conId: contract.conId ?? null,
        rank,
        scanCode,
        rawBenchmark: benchmark,
        rawProjection: projection,
        ivVsHistRatio: parseNumericField(projection) ?? parseNumericField(benchmark),
      });
    };

    const onScannerDataEnd = (id: number) => {
      if (id !== reqId) return;
      finish();
    };

    const onError = (_error: Error, _code: number, id: number) => {
      if (id !== reqId) return;
      // A scan that errors out (e.g. "no items retrieved" outside market
      // hours) resolves with whatever partial data arrived — same
      // fail-open behavior as the rest of the IBKR fetch modules, so one
      // bad scan code doesn't abort the whole job run.
      finish();
    };

    const timer = setTimeout(finish, scanTimeoutMs);
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      connection.ib.off(EventName.scannerData, onScannerData);
      connection.ib.off(EventName.scannerDataEnd, onScannerDataEnd);
      connection.ib.off(EventName.error, onError);
      connection.ib.cancelScannerSubscription(reqId);
      resolve(candidates);
    }

    connection.ib.on(EventName.scannerData, onScannerData);
    connection.ib.once(EventName.scannerDataEnd, onScannerDataEnd);
    connection.ib.on(EventName.error, onError);

    connection.ib.reqScannerSubscription(
      reqId,
      {
        numberOfRows: options.numberOfRows ?? defaultNumberOfRows,
        instrument: Instrument.STK,
        locationCode: LocationCode.STK_US,
        scanCode,
        stockTypeFilter: "CORP,ETF",
        marketCapAbove: options.marketCapAboveUsd ?? defaultMarketCapAboveUsd,
        ...(options.abovePriceUsd !== undefined ? { abovePrice: options.abovePriceUsd } : {}),
      },
      [],
      [],
    );
  });
}
