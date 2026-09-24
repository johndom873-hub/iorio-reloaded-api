import type { SignalCandidate } from "./signalCandidates.js";
import { scoreTicker } from "./signalsLiveScoring.js";
import { loadAccountContext, loadShortlistTickers, loadTickerSignalsInputs, type ShortlistTickerRow } from "./signalsStore.js";
import { loadSignalSettings, type SignalSettings } from "./signalSettingsStore.js";
import type { AccountContext, TickerSignalsInputs } from "./signalsTypes.js";
import { replaceDaySignalPool, type DaySignalExpirySeed, type DaySignalTickerSeed } from "./daySignalsStore.js";

// Seeds the day's pool from the 10:00 ET snapshot scoring (approved
// 2026-09-24 over a live first pass, which would take 17-45 min on 10 lines
// and duplicate the capture that just finished): per ticker with TODAY's
// snapshot, positive-net-Edge candidates ranked by Edge $, the distinct
// expiries of the top 10, capped at 3. Runs inside the capture orchestrator
// right after the surface fit; the loop (daySignalsLoop.ts) picks the pool
// up on its next state check.

export const daySignalsSeedTopCandidates = 10;
export const daySignalsSeedMaxExpiries = 3;

/** Pure: which expiries make the pool, in first-appearance order among the top candidates by Edge $. */
export function selectDaySignalExpiries(candidates: SignalCandidate[], options = { topCandidates: daySignalsSeedTopCandidates, maxExpiries: daySignalsSeedMaxExpiries }): DaySignalExpirySeed[] {
  const ranked = candidates.filter((candidate) => candidate.netEdge > 0).sort((a, b) => b.edgeDollars - a.edgeDollars || b.netEdge - a.netEdge);
  const seeds: DaySignalExpirySeed[] = [];
  for (const candidate of ranked.slice(0, options.topCandidates)) {
    if (seeds.some((seed) => seed.expiry === candidate.expiry)) continue;
    if (seeds.length >= options.maxExpiries) break;
    seeds.push({ expiry: candidate.expiry, rank: seeds.length + 1, seedBestEdgeDollars: candidate.edgeDollars, seedBestNetEdge: candidate.netEdge });
  }
  return seeds;
}

export interface DaySignalsSeedDependencies {
  loadShortlistTickers(): Promise<ShortlistTickerRow[]>;
  loadTickerSignalsInputs(ticker: ShortlistTickerRow): Promise<TickerSignalsInputs>;
  loadAccountContext(): Promise<AccountContext>;
  loadSignalSettings(): Promise<SignalSettings>;
  replaceDaySignalPool(tradingDateIso: string, seeds: DaySignalTickerSeed[], seededAt: Date): Promise<void>;
  now(): Date;
}

export const defaultDaySignalsSeedDependencies: DaySignalsSeedDependencies = {
  loadShortlistTickers,
  loadTickerSignalsInputs,
  loadAccountContext,
  loadSignalSettings,
  replaceDaySignalPool,
  now: () => new Date(),
};

export interface DaySignalsSeedResult {
  tradingDateIso: string;
  tickersScored: number;
  tickersPooled: number;
  expiriesPooled: number;
  /** Symbols with today's snapshot but no positive-net-Edge candidate — no pool today. */
  symbolsWithoutPool: string[];
  /** Symbols skipped because their latest snapshot is not today's. */
  symbolsWithoutTodaySnapshot: string[];
}

export async function seedDaySignals(tradingDateIso: string, deps: DaySignalsSeedDependencies = defaultDaySignalsSeedDependencies): Promise<DaySignalsSeedResult> {
  const [tickers, settings] = await Promise.all([deps.loadShortlistTickers(), deps.loadSignalSettings()]);
  // Free cash only affects the executable flag, never the ranking — a missing account summary must not block the seed.
  const account = await deps.loadAccountContext().catch((error) => {
    console.warn(`day signals seed: account context unavailable (${error instanceof Error ? error.message : error}) — seeding without it`);
    return { freeCash: 0 };
  });

  const result: DaySignalsSeedResult = { tradingDateIso, tickersScored: 0, tickersPooled: 0, expiriesPooled: 0, symbolsWithoutPool: [], symbolsWithoutTodaySnapshot: [] };
  const seeds: DaySignalTickerSeed[] = [];
  for (const ticker of tickers) {
    const inputs = await deps.loadTickerSignalsInputs(ticker);
    if (!inputs.header || inputs.header.tradingDateIso !== tradingDateIso) {
      result.symbolsWithoutTodaySnapshot.push(ticker.symbol);
      continue;
    }
    result.tickersScored += 1;
    const scored = scoreTicker(inputs, account, settings);
    const expiries = selectDaySignalExpiries(scored.candidates);
    if (expiries.length === 0) {
      result.symbolsWithoutPool.push(ticker.symbol);
      continue;
    }
    seeds.push({ tickerId: ticker.tickerId, snapshotId: inputs.header.snapshotId, expiries });
    result.tickersPooled += 1;
    result.expiriesPooled += expiries.length;
  }

  await deps.replaceDaySignalPool(tradingDateIso, seeds, deps.now());
  return result;
}
