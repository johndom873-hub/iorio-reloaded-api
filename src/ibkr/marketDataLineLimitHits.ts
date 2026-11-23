import { EventName, type IBApi } from "@stoqey/ib";
import { db } from "../db/connection.js";
import { environment } from "../config/env.js";
import { loadMarketDataLineBudget, type MarketDataLineBudget } from "./marketDataLineBudget.js";

export const minimumMillisecondsBetweenRecordedLineLimitHits = 5 * 60_000;
export const liveNetLiquidationTimeoutMs = 3_000;
// An account summary needs a request id of its own on whichever connection asks; far above any id the app allocates.
export const lineLimitHitAccountSummaryRequestId = 1_999_999_101;

export interface MarketDataLineLimitHit {
  requestId: number;
  code: number;
  message: string;
}

export interface LineReservationRow {
  holder: string;
  lines: number;
  priority: boolean;
}

export interface MarketDataLineLimitHitRow {
  process: string;
  trading_mode: string;
  request_id: number;
  ibkr_code: number;
  ibkr_message: string;
  budget: number;
  estimated_ibkr_ceiling: number;
  ledger_lines_in_use: number;
  ledger_reservations: string;
  live_net_liquidation: number | null;
  refusals_not_recorded_before: number;
}

export interface MarketDataLineLimitHitRecorderDependencies {
  processLabel: string;
  tradingMode: string;
  fetchLiveNetLiquidation: () => Promise<number | null>;
  loadReservations: () => Promise<LineReservationRow[]>;
  loadBudget: () => Promise<MarketDataLineBudget>;
  insertHit: (row: MarketDataLineLimitHitRow) => Promise<void>;
  now?: () => number;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * Every refusal is logged; one per process every 5 minutes is also stored, with the app's ledger and the live net
 * liquidation at that moment. The refusals in between are counted onto the next stored row (refusals_not_recorded_before).
 * Never throws: a failure to store is logged and the refusal is otherwise ignored, as before.
 */
export function createMarketDataLineLimitHitRecorder(dependencies: MarketDataLineLimitHitRecorderDependencies): (hit: MarketDataLineLimitHit) => Promise<void> {
  const now = dependencies.now ?? Date.now;
  let lastRecordedAt = Number.NEGATIVE_INFINITY;
  let refusalsNotRecorded = 0;
  let recordingInProgress = false;

  return async function recordMarketDataLineLimitHit(hit: MarketDataLineLimitHit): Promise<void> {
    console.warn(`IBKR refused a market-data line as over the login's limit (process ${dependencies.processLabel}, reqId=${hit.requestId}, code=${hit.code}): ${hit.message}`);
    const at = now();
    if (recordingInProgress || at - lastRecordedAt < minimumMillisecondsBetweenRecordedLineLimitHits) {
      refusalsNotRecorded += 1;
      return;
    }
    recordingInProgress = true;
    lastRecordedAt = at;
    const refusalsNotRecordedBefore = refusalsNotRecorded;
    refusalsNotRecorded = 0;
    try {
      const [reservations, budget, liveNetLiquidation] = await Promise.all([
        dependencies.loadReservations(),
        dependencies.loadBudget(),
        withTimeout(dependencies.fetchLiveNetLiquidation(), liveNetLiquidationTimeoutMs, null),
      ]);
      await dependencies.insertHit({
        process: dependencies.processLabel,
        trading_mode: dependencies.tradingMode,
        request_id: hit.requestId,
        ibkr_code: hit.code,
        ibkr_message: hit.message,
        budget: budget.budget,
        estimated_ibkr_ceiling: budget.estimatedIbkrCeiling,
        ledger_lines_in_use: reservations.reduce((sum, reservation) => sum + reservation.lines, 0),
        ledger_reservations: JSON.stringify(reservations),
        live_net_liquidation: liveNetLiquidation,
        refusals_not_recorded_before: refusalsNotRecordedBefore,
      });
      console.warn(`Recorded the market-data line refusal: ledger ${reservations.reduce((sum, reservation) => sum + reservation.lines, 0)} lines, budget ${budget.budget}, live net liquidation ${liveNetLiquidation ?? "unknown"}.`);
    } catch (error) {
      console.error(`Could not record the market-data line refusal: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      recordingInProgress = false;
    }
  };
}

/** The account's net liquidation in US dollars on this connection; null when IBKR reports it in another currency or not at all. */
export function requestNetLiquidationInUsd(ib: IBApi, requestId: number, timeoutMs: number): Promise<number | null> {
  return new Promise<number | null>((resolve) => {
    let netLiquidationInUsd: number | null = null;
    const onAccountSummary = (id: number, _account: string, tag: string, value: string, currency: string) => {
      if (id !== requestId || tag !== "NetLiquidation" || currency !== "USD" || value.trim() === "") return;
      const parsed = Number(value);
      if (Number.isFinite(parsed)) netLiquidationInUsd = parsed;
    };
    const finish = () => {
      clearTimeout(timer);
      ib.removeListener(EventName.accountSummary, onAccountSummary);
      ib.removeListener(EventName.accountSummaryEnd, onAccountSummaryEnd);
      try {
        ib.cancelAccountSummary(requestId);
      } catch {
        // The connection may have gone; nothing to cancel then.
      }
      resolve(netLiquidationInUsd);
    };
    const onAccountSummaryEnd = (id: number) => {
      if (id === requestId) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    ib.on(EventName.accountSummary, onAccountSummary);
    ib.on(EventName.accountSummaryEnd, onAccountSummaryEnd);
    ib.reqAccountSummary(requestId, "All", "NetLiquidation");
  });
}

export async function loadLineReservationsForLineLimitHit(): Promise<LineReservationRow[]> {
  return db("ibkr_market_data_line_reservations").where("expires_at", ">", db.fn.now()).orderBy("holder").select("holder", "lines", "priority");
}

/** A recorder for one process, storing to the database and asking IBKR on the connection that was refused. */
export function createDatabaseMarketDataLineLimitHitRecorder(processLabel: string, ib: () => IBApi | null): (hit: MarketDataLineLimitHit) => Promise<void> {
  return createMarketDataLineLimitHitRecorder({
    processLabel,
    tradingMode: environment.ibkrTradingMode,
    fetchLiveNetLiquidation: async () => {
      const connection = ib();
      return connection ? requestNetLiquidationInUsd(connection, lineLimitHitAccountSummaryRequestId, liveNetLiquidationTimeoutMs) : null;
    },
    loadReservations: loadLineReservationsForLineLimitHit,
    loadBudget: () => loadMarketDataLineBudget(),
    insertHit: async (row) => {
      await db("ibkr_market_data_line_limit_hits").insert(row);
    },
  });
}
