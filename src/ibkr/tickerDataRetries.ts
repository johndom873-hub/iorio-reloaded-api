import { db } from "../db/connection.js";
import { easternIsoDate, easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { isMarketClosedToday } from "../lib/isWeekend.js";
import { loadDailyBarsStatus } from "../lib/dailyBarsStatus.js";
import { loadOptionDataUniverse } from "../lib/optionDataUniverse.js";
import { loadFallbackStockPrices } from "../lib/priceService.js";
import { invalidatePricePerformanceSnapshot } from "../lib/pricePerformanceSnapshot.js";
import { excludeTickersBeingPrepared } from "../lib/tickersBeingPrepared.js";
import { notifyTelegramTracked } from "../lib/undeliveredAlerts.js";
import { loadEnabledPlutoTickerSettings } from "../pluto/tickerSettingsStore.js";
import { connectToIbkrGateway, type IbkrConnection } from "./connectIbkr.js";
import { IbkrLookupTimeoutError, refreshStoredOptionChain } from "./fetchOptionChain.js";
import { orderPlutoTickersFirst, refreshTickerStructure } from "./runOptionChainStructureRefresh.js";
import { nextReqIdFor } from "./sharedReadConnection.js";
import { enqueueTickerIbkrWork, fetchAndStoreFullDailyHistory } from "./tickerBackfillPipeline.js";

// Automatic retries (Marcelo 2026-11-09): a ticker left without today's option chain (the 09:00 UTC structure job stopped
// at a timeout, or a new ticker's setup failed its chain step) or without its daily history back to 2006 (a setup's history step
// failed) is tried again every 10 minutes, 3 tries a day, through the same queue as new-ticker setups, so two never ask the
// Gateway at once. A ticker still missing it after its last try raises one alert with the Shortlist action that fixes it.

export const tickerDataRetryIntervalMinutes = 10;
export const tickerDataRetryMaxAttemptsPerDay = 3;
/** 09:10 UTC: after the 09:00 UTC structure job has started; the window ends at the 16:00 ET close. */
const retryWindowStartUtcMinutes = 9 * 60 + 10;
const retryWindowEndEasternMinutes = 16 * 60;
/** The structure job's own retry-free run must finish first; a "running" row older than this is a dead run. */
const structureJobRunningMaxMinutes = 45;

export type TickerDataKind = "option_chain" | "daily_bars_history";

export interface TickerDataNeed {
  tickerId: string;
  symbol: string;
  contractId: number | null;
  kind: TickerDataKind;
}

export interface TickerDataRetryRow {
  tickerId: string;
  kind: TickerDataKind;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: Date | null;
  succeededAt: Date | null;
  gaveUpAt: Date | null;
}

const kindLabels: Record<TickerDataKind, { what: string; shortlistAction: string }> = {
  option_chain: { what: "option chain", shortlistAction: "Populate Option Chain" },
  daily_bars_history: { what: "daily history back to 2006", shortlistAction: "Populate Daily Bars" },
};

/** From 09:10 UTC to the 16:00 ET close: e.g. 09:05 UTC no, 14:00 UTC yes, 21:30 UTC (16:30 ET in winter) no. */
export function isWithinTickerDataRetryWindow(now: Date): boolean {
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMinutes >= retryWindowStartUtcMinutes && easternMinutesOfDay(now) < retryWindowEndEasternMinutes;
}

/** An IBKR request that got no answer in time (a strike lookup, the expiry list, historical data, the connection itself). */
export function isIbkrTimeoutError(error: unknown): boolean {
  if (error instanceof IbkrLookupTimeoutError) return true;
  return error instanceof Error && /timed out|timeout/i.test(error.message);
}

export function describeTickerDataGaveUp(symbol: string, kind: TickerDataKind, lastError: string): string {
  const { what, shortlistAction } = kindLabels[kind];
  return `⚠️ ${symbol}: the ${what} is still missing after ${tickerDataRetryMaxAttemptsPerDay} tries today (${lastError}). Shortlist → ${symbol} → Actions → ${shortlistAction}.`;
}

// ---- Store ----------------------------------------------------------------------------------------------------------

export async function loadTickerDataRetryRows(tradingDateIso: string, tickerIds?: string[]): Promise<TickerDataRetryRow[]> {
  const query = db("ticker_data_retries").where({ trading_date: tradingDateIso });
  if (tickerIds) query.whereIn("ticker_id", tickerIds);
  const rows: { ticker_id: string; data_kind: TickerDataKind; attempts: number; last_error: string | null; last_attempt_at: Date | null; succeeded_at: Date | null; gave_up_at: Date | null }[] = await query.select(
    "ticker_id",
    "data_kind",
    "attempts",
    "last_error",
    "last_attempt_at",
    "succeeded_at",
    "gave_up_at",
  );
  return rows.map((row) => ({ tickerId: row.ticker_id, kind: row.data_kind, attempts: row.attempts, lastError: row.last_error, lastAttemptAt: row.last_attempt_at, succeededAt: row.succeeded_at, gaveUpAt: row.gave_up_at }));
}

async function ensureTickerDataRetryRows(needs: TickerDataNeed[], tradingDateIso: string): Promise<void> {
  if (needs.length === 0) return;
  await db("ticker_data_retries")
    .insert(needs.map((need) => ({ ticker_id: need.tickerId, data_kind: need.kind, trading_date: tradingDateIso })))
    .onConflict(["ticker_id", "data_kind", "trading_date"])
    .ignore();
}

/** A success, by the retry pass or by a Shortlist action; a history success also completes the ticker's history (dailyBarsStatus.ts). */
export async function recordTickerDataSuccess(tickerId: string, kind: TickerDataKind, tradingDateIso: string, countsAsAttempt: boolean): Promise<void> {
  await db("ticker_data_retries")
    .insert({ ticker_id: tickerId, data_kind: kind, trading_date: tradingDateIso, attempts: countsAsAttempt ? 1 : 0, last_attempt_at: db.fn.now(), succeeded_at: db.fn.now() })
    .onConflict(["ticker_id", "data_kind", "trading_date"])
    .merge({ attempts: countsAsAttempt ? db.raw("ticker_data_retries.attempts + 1") : db.raw("ticker_data_retries.attempts"), last_attempt_at: db.fn.now(), succeeded_at: db.fn.now() });
}

/** Counts a failed try; the last allowed one gives up (once), and the caller alerts. */
async function recordTickerDataFailure(tickerId: string, kind: TickerDataKind, tradingDateIso: string, message: string): Promise<{ attempts: number; gaveUpNow: boolean }> {
  const [row]: { attempts: number; gave_up_at: Date | null }[] = await db("ticker_data_retries")
    .where({ ticker_id: tickerId, data_kind: kind, trading_date: tradingDateIso })
    .update({
      attempts: db.raw("attempts + 1"),
      last_error: message,
      last_attempt_at: db.fn.now(),
      gave_up_at: db.raw("CASE WHEN gave_up_at IS NULL AND attempts + 1 >= ? THEN now() ELSE gave_up_at END", [tickerDataRetryMaxAttemptsPerDay]),
    })
    .returning(["attempts", "gave_up_at"]);
  if (!row) throw new Error(`no ticker_data_retries row for ${tickerId} ${kind} on ${tradingDateIso}`);
  // Given up on exactly the last allowed try: the pass never tries a ticker past it, so this is true once a day.
  return { attempts: row.attempts, gaveUpNow: row.gave_up_at !== null && row.attempts === tickerDataRetryMaxAttemptsPerDay };
}

// ---- What is missing ------------------------------------------------------------------------------------------------

/** Tickers the morning job refreshes (Shortlist and open positions, none being set up) without a structure fetched today. */
async function loadOptionChainNeeds(tradingDateIso: string): Promise<Omit<TickerDataNeed, "kind">[]> {
  const universe = await loadOptionDataUniverse({ excludeBeingPrepared: true });
  if (universe.length === 0) return [];
  const fetched: { ticker_id: string; fetched_at: Date }[] = await db("option_chain_params")
    .whereIn(
      "ticker_id",
      universe.map((ticker) => ticker.tickerId),
    )
    .select("ticker_id", "fetched_at");
  const fetchedDateByTicker = new Map(fetched.map((row) => [row.ticker_id, easternIsoDate(new Date(row.fetched_at))]));
  return universe.filter((ticker) => fetchedDateByTicker.get(ticker.tickerId) !== tradingDateIso);
}

/** Shortlisted tickers, none being set up, whose daily history is missing or short of ~5 years (the "full" plan). */
async function loadDailyBarsHistoryNeeds(now: Date): Promise<Omit<TickerDataNeed, "kind">[]> {
  const shortlisted: { tickerId: string; symbol: string; contractId: string | number | null }[] = await excludeTickersBeingPrepared(
    db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").select("t.id as tickerId", "t.symbol", "t.ibkr_contract_id as contractId").orderBy("t.symbol"),
    "t.id",
  );
  const needs: Omit<TickerDataNeed, "kind">[] = [];
  for (const ticker of shortlisted) {
    if ((await loadDailyBarsStatus(ticker.tickerId, now)).dailyBarsPlan === "full") needs.push({ tickerId: ticker.tickerId, symbol: ticker.symbol, contractId: ticker.contractId === null ? null : Number(ticker.contractId) });
  }
  return needs;
}

// ---- The pass -------------------------------------------------------------------------------------------------------

export interface TickerDataRetryDependencies {
  now: () => Date;
  isMarketClosedToday: (now: Date) => Promise<boolean>;
  isStructureJobRunning: () => Promise<boolean>;
  loadPlutoTickerIds: () => Promise<Set<string>>;
  loadOptionChainNeeds: (tradingDateIso: string) => Promise<Omit<TickerDataNeed, "kind">[]>;
  loadDailyBarsHistoryNeeds: (now: Date) => Promise<Omit<TickerDataNeed, "kind">[]>;
  ensureRows: (needs: TickerDataNeed[], tradingDateIso: string) => Promise<void>;
  loadRows: (tradingDateIso: string) => Promise<TickerDataRetryRow[]>;
  recordSuccess: (tickerId: string, kind: TickerDataKind, tradingDateIso: string) => Promise<void>;
  recordFailure: (tickerId: string, kind: TickerDataKind, tradingDateIso: string, message: string) => Promise<{ attempts: number; gaveUpNow: boolean }>;
  loadSpotPrices: (symbols: string[]) => Promise<Map<string, number>>;
  connect: () => Promise<IbkrConnection>;
  refreshOptionChain: (connection: IbkrConnection, need: TickerDataNeed, tradingDateIso: string, spotPrice: number | null) => Promise<void>;
  fetchDailyBarsHistory: (connection: IbkrConnection, need: TickerDataNeed) => Promise<void>;
  alert: (message: string) => Promise<void>;
}

export const defaultTickerDataRetryDependencies: TickerDataRetryDependencies = {
  now: () => new Date(),
  isMarketClosedToday,
  isStructureJobRunning: async () =>
    Boolean(
      await db("job_runs")
        .where({ job_name: "option_chain_structure_refresh", status: "running" })
        .whereRaw("started_at > now() - make_interval(mins => ?)", [structureJobRunningMaxMinutes])
        .first("id"),
    ),
  loadPlutoTickerIds: async () => new Set((await loadEnabledPlutoTickerSettings()).map((ticker) => ticker.tickerId)),
  loadOptionChainNeeds,
  loadDailyBarsHistoryNeeds,
  ensureRows: ensureTickerDataRetryRows,
  loadRows: (tradingDateIso) => loadTickerDataRetryRows(tradingDateIso),
  recordSuccess: (tickerId, kind, tradingDateIso) => recordTickerDataSuccess(tickerId, kind, tradingDateIso, true),
  recordFailure: recordTickerDataFailure,
  loadSpotPrices: async (symbols) => new Map([...(await loadFallbackStockPrices(symbols))].map(([symbol, known]) => [symbol, known.price])),
  connect: () => connectToIbkrGateway(),
  refreshOptionChain: async (connection, need, tradingDateIso, spotPrice) => {
    await refreshTickerStructure(refreshStoredOptionChain, connection.ib, need, tradingDateIso, spotPrice);
  },
  fetchDailyBarsHistory: async (connection, need) => {
    await fetchAndStoreFullDailyHistory(connection, need.tickerId, need.symbol, { reqId: nextReqIdFor(connection.ib, () => 1) });
    invalidatePricePerformanceSnapshot();
  },
  alert: notifyTelegramTracked,
};

export type TickerDataRetryOutcome = { need: TickerDataNeed; attempt: number } & ({ result: "done" } | { result: "failed"; message: string; gaveUp: boolean });

export type TickerDataRetryPassResult =
  | { ran: false; reason: "outside_window" | "market_closed" | "structure_job_running" | "nothing_due" | "connect_failed"; message?: string }
  | { ran: true; outcomes: TickerDataRetryOutcome[]; stoppedAfterTimeout: string | null; notTried: string[] };

/**
 * One pass: every ticker missing today's option chain, then every one missing its history back to 2006, Pluto's first, each tried
 * once if it has tries left today. An IBKR timeout ends the pass (the next one, 10 minutes later, goes on), as the morning job
 * does: the request that timed out cannot be cancelled. A connection that fails costs no ticker a try.
 */
export async function runTickerDataRetryPass(dependencies: TickerDataRetryDependencies = defaultTickerDataRetryDependencies): Promise<TickerDataRetryPassResult> {
  const now = dependencies.now();
  if (!isWithinTickerDataRetryWindow(now)) return { ran: false, reason: "outside_window" };
  if (await dependencies.isMarketClosedToday(now)) return { ran: false, reason: "market_closed" };
  if (await dependencies.isStructureJobRunning()) return { ran: false, reason: "structure_job_running" };
  const tradingDateIso = easternIsoDate(now);

  const [plutoTickerIds, chainNeeds, historyNeeds] = await Promise.all([dependencies.loadPlutoTickerIds(), dependencies.loadOptionChainNeeds(tradingDateIso), dependencies.loadDailyBarsHistoryNeeds(now)]);
  const needs: TickerDataNeed[] = [
    ...orderPlutoTickersFirst(chainNeeds, plutoTickerIds).map((need) => ({ ...need, kind: "option_chain" as const })),
    ...orderPlutoTickersFirst(historyNeeds, plutoTickerIds).map((need) => ({ ...need, kind: "daily_bars_history" as const })),
  ];
  if (needs.length === 0) return { ran: false, reason: "nothing_due" };
  await dependencies.ensureRows(needs, tradingDateIso);
  const rowByKey = new Map((await dependencies.loadRows(tradingDateIso)).map((row) => [`${row.tickerId}:${row.kind}`, row]));
  const due = needs.filter((need) => {
    const row = rowByKey.get(`${need.tickerId}:${need.kind}`);
    return row !== undefined && row.gaveUpAt === null && row.attempts < tickerDataRetryMaxAttemptsPerDay;
  });
  if (due.length === 0) return { ran: false, reason: "nothing_due" };

  const spotBySymbol = await dependencies.loadSpotPrices(due.filter((need) => need.kind === "option_chain").map((need) => need.symbol));
  let connection: IbkrConnection;
  try {
    connection = await dependencies.connect();
  } catch (error) {
    return { ran: false, reason: "connect_failed", message: error instanceof Error ? error.message : String(error) };
  }
  const outcomes: TickerDataRetryOutcome[] = [];
  let stoppedAfterTimeout: string | null = null;
  let notTried: string[] = [];
  try {
    for (const [index, need] of due.entries()) {
      const attempt = rowByKey.get(`${need.tickerId}:${need.kind}`)!.attempts + 1;
      try {
        if (need.kind === "option_chain") await dependencies.refreshOptionChain(connection, need, tradingDateIso, spotBySymbol.get(need.symbol) ?? null);
        else await dependencies.fetchDailyBarsHistory(connection, need);
        await dependencies.recordSuccess(need.tickerId, need.kind, tradingDateIso);
        outcomes.push({ need, attempt, result: "done" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const { gaveUpNow } = await dependencies.recordFailure(need.tickerId, need.kind, tradingDateIso, message);
        outcomes.push({ need, attempt, result: "failed", message, gaveUp: gaveUpNow });
        if (gaveUpNow) await dependencies.alert(describeTickerDataGaveUp(need.symbol, need.kind, message)).catch((alertError: unknown) => console.error(`Ticker data retry: could not send the alert for ${need.symbol} — ${alertError instanceof Error ? alertError.message : alertError}`));
        if (isIbkrTimeoutError(error)) {
          stoppedAfterTimeout = need.symbol;
          notTried = due.slice(index + 1).map((remaining) => `${remaining.symbol} ${kindLabels[remaining.kind].what}`);
          break;
        }
      }
    }
  } finally {
    connection.disconnect();
  }
  return { ran: true, outcomes, stoppedAfterTimeout, notTried };
}

export function describeTickerDataRetryPass(result: TickerDataRetryPassResult): string | null {
  if (!result.ran) return result.reason === "connect_failed" ? `Ticker data retry: could not connect to IBKR (${result.message}); no ticker lost a try.` : null;
  const lines = result.outcomes.map((outcome) => {
    const what = `${outcome.need.symbol} ${kindLabels[outcome.need.kind].what} (try ${outcome.attempt} of ${tickerDataRetryMaxAttemptsPerDay})`;
    return outcome.result === "done" ? `${what}: done` : `${what}: failed — ${outcome.message}${outcome.gaveUp ? "; no tries left today, alerted" : ""}`;
  });
  if (result.stoppedAfterTimeout) lines.push(`stopped after ${result.stoppedAfterTimeout}'s IBKR timeout; next pass in ${tickerDataRetryIntervalMinutes} minutes${result.notTried.length > 0 ? ` (not tried: ${result.notTried.join(", ")})` : ""}`);
  return `Ticker data retry: ${lines.join("; ")}.`;
}

// ---- Schedule -------------------------------------------------------------------------------------------------------

let passWaitingOrRunning = false;

/** Queues a pass behind any new-ticker setup, unless one is already waiting or running. */
export function queueTickerDataRetryPass(): void {
  if (passWaitingOrRunning) return;
  passWaitingOrRunning = true;
  void enqueueTickerIbkrWork(async () => {
    try {
      const summary = describeTickerDataRetryPass(await runTickerDataRetryPass());
      if (summary) console.log(summary);
    } catch (error) {
      console.error(`Ticker data retry pass failed: ${error instanceof Error ? error.message : error}`);
    } finally {
      passWaitingOrRunning = false;
    }
  });
}

/** Web dyno only (server.ts): a pass a minute after start, then every 10 minutes. */
export function startTickerDataRetries(): void {
  const firstPass = setTimeout(queueTickerDataRetryPass, 60_000);
  firstPass.unref?.();
  const timer = setInterval(queueTickerDataRetryPass, tickerDataRetryIntervalMinutes * 60_000);
  timer.unref?.();
}
