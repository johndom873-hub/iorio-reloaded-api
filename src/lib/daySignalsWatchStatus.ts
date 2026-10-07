import { db } from "../db/connection.js";
import { daySignalsRerankTriggerFraction, daySignalsUnpooledRecheckIntervalMs } from "./daySignalsContractSet.js";
import { hasDaySignalsSeedFinished, loadDayRerankStates, type DayRerankState } from "./daySignalsStore.js";
import { easternIsoDate } from "./easternIsoDate.js";
import { computeMarketSessionStatus, resolveIsOpenDay } from "./marketSessionStatus.js";
import { computeAtmImpliedVolatility, rebaseSlicesToToday } from "./signalsLiveScoring.js";
import { loadLatestSnapshot, loadSlices } from "./signalsStore.js";

// Whether Day Signals is watching a ticker today, and why not (Marcelo, 2026-10-07, Pluto Tickers tab). Pluto analyses only
// the tickers Day Signals quotes, plus one opening look, so a ticker without a pool is invisible to it: the screen says so,
// with when it will be looked at again (the hourly re-check of unpooled tickers, or a price move past the trigger).

export type DaySignalsWatchKind = "watched" | "not_watched" | "no_surface" | "waiting_for_capture" | "market_closed";

export interface DaySignalsWatchStatus {
  kind: DaySignalsWatchKind;
  /** Pooled expiries (YYYY-MM-DD), quoted every cycle; empty unless watched. */
  pooledExpiries: string[];
  /** The last re-rank or re-check today, and what caused it. */
  lastLookAt: string | null;
  lastLookKind: "price" | "timed" | null;
  /** Unpooled only: when the hourly re-check is next due (null until the loop has seen the ticker today). */
  nextTimedCheckAt: string | null;
  /** The prices that trigger an immediate look: the reference spot moved by the approved fraction either way. */
  triggerLowPrice: number | null;
  triggerHighPrice: number | null;
}

export interface DaySignalsWatchInput {
  openDay: boolean;
  seedFinished: boolean;
  pooledExpiries: string[];
  /** Today's ATM IV from today's fit; null when today has no usable surface. */
  atmImpliedVolatility: number | null;
  snapshotSpotPrice: number | null;
  rerankState: DayRerankState | null;
}

// Rounded outward to the cent, so a spot at the displayed price always triggers (decideRerank's >= comparison).
const roundUpToCent = (value: number) => Math.ceil(value * 100 - 1e-9) / 100;
const roundDownToCent = (value: number) => Math.floor(value * 100 + 1e-9) / 100;

/** Pure: one ticker's status from today's facts. */
export function describeDaySignalsWatch(input: DaySignalsWatchInput): DaySignalsWatchStatus {
  const empty: DaySignalsWatchStatus = { kind: "market_closed", pooledExpiries: [], lastLookAt: null, lastLookKind: null, nextTimedCheckAt: null, triggerLowPrice: null, triggerHighPrice: null };
  if (!input.openDay) return empty;
  // A pooled ticker is being quoted whatever the seed's job row says (a run stuck at "running" until the next one starts).
  if (!input.seedFinished && input.pooledExpiries.length === 0) return { ...empty, kind: "waiting_for_capture" };
  if (input.atmImpliedVolatility === null || input.snapshotSpotPrice === null) return { ...empty, kind: "no_surface" };
  const state = input.rerankState;
  const reference = state?.referenceSpotPrice ?? input.snapshotSpotPrice;
  const fraction = daySignalsRerankTriggerFraction(input.atmImpliedVolatility);
  const look = { lastLookAt: state?.lastLookAt?.toISOString() ?? null, lastLookKind: state?.lastLookKind ?? null, triggerLowPrice: roundDownToCent(reference * (1 - fraction)), triggerHighPrice: roundUpToCent(reference * (1 + fraction)) };
  if (input.pooledExpiries.length > 0) return { ...empty, ...look, kind: "watched", pooledExpiries: input.pooledExpiries };
  const clockStart = state?.lastLookAt ?? state?.firstSeenAt ?? null;
  return { ...empty, ...look, kind: "not_watched", nextTimedCheckAt: clockStart ? new Date(clockStart.getTime() + daySignalsUnpooledRecheckIntervalMs).toISOString() : null };
}

/** Every given ticker's status for today, plus whether the session is open now (the screen only promises re-checks while it is). */
export async function loadDaySignalsWatchStatuses(tickerIds: string[], now: Date = new Date()): Promise<{ tradingDateIso: string; sessionOpen: boolean; statuses: Map<string, DaySignalsWatchStatus> }> {
  const tradingDateIso = easternIsoDate(now);
  const [openDay, session, seedFinished, poolRows, rerankStates] = await Promise.all([
    resolveIsOpenDay(tradingDateIso),
    computeMarketSessionStatus(now),
    hasDaySignalsSeedFinished(tradingDateIso),
    db("day_signal_expiries").whereIn("ticker_id", tickerIds).whereRaw("trading_date::text = ?", [tradingDateIso]).orderBy("expiry").select("ticker_id as tickerId", db.raw("expiry::text as expiry")),
    loadDayRerankStates(tradingDateIso),
  ]);
  const statuses = new Map<string, DaySignalsWatchStatus>();
  for (const tickerId of tickerIds) {
    const header = await loadLatestSnapshot(tickerId);
    const today = header && header.tradingDateIso === tradingDateIso ? header : null;
    const atmImpliedVolatility = today ? computeAtmImpliedVolatility(rebaseSlicesToToday(await loadSlices(today.snapshotId), tradingDateIso)) : null;
    statuses.set(tickerId, describeDaySignalsWatch({
      openDay,
      seedFinished,
      pooledExpiries: (poolRows as { tickerId: string; expiry: string }[]).filter((row) => row.tickerId === tickerId).map((row) => row.expiry),
      atmImpliedVolatility,
      snapshotSpotPrice: today?.underlyingPrice ?? null,
      rerankState: rerankStates.get(tickerId) ?? null,
    }));
  }
  return { tradingDateIso, sessionOpen: session.state === "open", statuses };
}
