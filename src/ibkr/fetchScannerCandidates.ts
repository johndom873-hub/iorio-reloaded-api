import { EventName, Instrument, LocationCode, ScanCode, type ContractDetails } from "@stoqey/ib";
import type { IbkrConnection } from "./connectIbkr.js";

const scanTimeoutMs = 20_000;
const defaultNumberOfRows = 50;
const defaultMarketCapAboveUsd = 1_000_000_000;

export interface ScannerCandidate {
  symbol: string;
  conId: number | null;
  rank: number;
  scanCode: ScanCode;
}

/**
 * Runs one IBKR market scanner subscription (reqScannerSubscription) to
 * completion and resolves with every row returned. Caller owns the
 * connection's lifecycle; reqId must not be in use elsewhere on it.
 *
 * Only symbol/conId/rank come back — confirmed live 2026-09-25 (see
 * PROGRESS.md) that the scanner NEVER populates ContractDetails' other
 * fields (longName/industry/category/stockType) or the benchmark/projection
 * fields, regardless of scan code or ticker quality; this matches IBKR's own
 * docs ("no market data fields returned from the scanner... requested
 * separately with reqMktData"). Company name/sector/quote data are fetched
 * by a separate per-candidate enrichment step (enrichScannerCandidates.ts).
 *
 * Universe/liquidity filters are the native IBKR scan params: US-listed
 * common stock + ETF only, market cap floor. The market cap floor is passed
 * as the raw filter tag `marketCapAbove1e6` (units: millions), NOT the typed
 * ScannerSubscription.marketCapAbove field — that field maps to a
 * deprecated/non-functional IBKR wire field and silently returns zero rows
 * (root-caused live 2026-09-25, see PROGRESS.md).
 */
export function runScannerSubscription(
  connection: IbkrConnection,
  scanCode: ScanCode,
  reqId: number,
  options: { numberOfRows?: number; marketCapAboveUsd?: number; abovePriceUsd?: number } = {},
): Promise<ScannerCandidate[]> {
  return new Promise((resolve) => {
    const candidates: ScannerCandidate[] = [];

    const onScannerData = (id: number, rank: number, contractDetails: ContractDetails) => {
      if (id !== reqId) return;
      const contract = contractDetails.contract;
      if (!contract.symbol) return;
      candidates.push({ symbol: contract.symbol, conId: contract.conId ?? null, rank, scanCode });
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
    // on, not once: another request's end marker must not consume the listener before this request's own arrives (finish removes it).
    connection.ib.on(EventName.scannerDataEnd, onScannerDataEnd);
    connection.ib.on(EventName.error, onError);

    const marketCapAboveUsd = options.marketCapAboveUsd ?? defaultMarketCapAboveUsd;
    connection.ib.reqScannerSubscription(
      reqId,
      {
        numberOfRows: options.numberOfRows ?? defaultNumberOfRows,
        instrument: Instrument.STK,
        locationCode: LocationCode.STK_US,
        scanCode,
        stockTypeFilter: "CORP,ETF",
        ...(options.abovePriceUsd !== undefined ? { abovePrice: options.abovePriceUsd } : {}),
      },
      [],
      [{ tag: "marketCapAbove1e6", value: String(marketCapAboveUsd / 1_000_000) }],
    );
  });
}
