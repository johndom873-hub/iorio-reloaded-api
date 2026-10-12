import { compareCandidatesByModel, type SignalCandidate } from "./signalCandidates.js";
import { scoreTicker } from "./signalsLiveScoring.js";
import { loadAccountContext, loadSignalsUniverseTickers, loadTickerSignalsInputs, type SignalsTickerRow } from "./signalsStore.js";
import { loadTradingSettings, type TradingSettings } from "./tradingSettingsStore.js";
import type { AccountContext, TickerSignalsInputs } from "./signalsTypes.js";
import { replaceDaySignalPool, type DaySignalExpirySeed, type DaySignalTickerSeed } from "./daySignalsStore.js";
import { modelPredictionsFromCandidates, recordSignalModelPredictions, type SignalModelPrediction } from "./signalModelPredictionsStore.js";

// Seeds the day's pool from the 10:00 ET snapshot scoring (approved
// 2026-09-24 over a live first pass, which would take 17-45 min on 10 lines
// and duplicate the capture that just finished): per ticker with TODAY's
// snapshot, the candidates the valuation model expects to earn on (model
// review, 2026-10-10: Pluto acts on the model, so its live pool is picked by
// it too) ranked as Pluto ranks them, the distinct expiries of the top 10,
// capped at 3. Runs inside the capture orchestrator right after the surface
// fit; the loop (daySignalsLoop.ts) picks the pool up on its next state check.
// Every valued candidate's prediction is logged (signal_model_predictions).

export const daySignalsSeedTopCandidates = 10;
export const daySignalsSeedMaxExpiries = 3;

/**
 * Pure: which expiries make the pool, in first-appearance order among the top candidates with a positive expected P&L
 * by compareCandidatesByModel, then (Roll Signals, 2026-09-24) every open short leg's expiry that is not already in,
 * ranked after them and outside the cap -- the held contract needs fresh quotes all session, and its expiry is where
 * the same-expiry replacements live.
 */
export function selectDaySignalExpiries(candidates: SignalCandidate[], options = { topCandidates: daySignalsSeedTopCandidates, maxExpiries: daySignalsSeedMaxExpiries }, heldLegExpiries: string[] = []): DaySignalExpirySeed[] {
  const ranked = candidates.filter((candidate) => candidate.model !== null && candidate.model.expectedPnlDollars > 0).sort(compareCandidatesByModel);
  const seeds: DaySignalExpirySeed[] = [];
  for (const candidate of ranked.slice(0, options.topCandidates)) {
    if (seeds.some((seed) => seed.expiry === candidate.expiry)) continue;
    if (seeds.length >= options.maxExpiries) break;
    seeds.push({ expiry: candidate.expiry, rank: seeds.length + 1, seedBestExpectedPnlDollars: candidate.model!.expectedPnlDollars, seedBestEdgeMargin: candidate.model!.edgeMargin });
  }
  for (const expiry of [...new Set(heldLegExpiries)].sort()) {
    if (seeds.some((seed) => seed.expiry === expiry)) continue;
    const best = ranked.find((candidate) => candidate.expiry === expiry);
    seeds.push({ expiry, rank: seeds.length + 1, seedBestExpectedPnlDollars: best?.model?.expectedPnlDollars ?? 0, seedBestEdgeMargin: best?.model?.edgeMargin ?? 0 });
  }
  return seeds;
}

export interface DaySignalsSeedDependencies {
  loadSignalsUniverseTickers(): Promise<SignalsTickerRow[]>;
  loadTickerSignalsInputs(ticker: SignalsTickerRow): Promise<TickerSignalsInputs>;
  loadAccountContext(): Promise<AccountContext>;
  loadTradingSettings(): Promise<TradingSettings>;
  replaceDaySignalPool(tradingDateIso: string, seeds: DaySignalTickerSeed[], seededAt: Date): Promise<void>;
  recordSignalModelPredictions(predictions: SignalModelPrediction[]): Promise<void>;
  now(): Date;
}

export const defaultDaySignalsSeedDependencies: DaySignalsSeedDependencies = {
  loadSignalsUniverseTickers,
  loadTickerSignalsInputs,
  loadAccountContext,
  loadTradingSettings,
  replaceDaySignalPool,
  recordSignalModelPredictions,
  now: () => new Date(),
};

export interface DaySignalsSeedResult {
  tradingDateIso: string;
  tickersScored: number;
  tickersPooled: number;
  expiriesPooled: number;
  /** Symbols with today's snapshot but no candidate with a positive expected P&L — no pool today. */
  symbolsWithoutPool: string[];
  /** Symbols skipped because their latest snapshot is not today's. */
  symbolsWithoutTodaySnapshot: string[];
  /** True when the account summary could not be read: free cash was taken as 0, so every candidate is marked non-executable. */
  accountContextUnavailable: boolean;
  /** Candidates whose model prediction was logged; null when the log write failed (the pool is written regardless). */
  modelPredictionsRecorded: number | null;
}

/** One line for the job alert when the seed ran but its pool is missing tickers or is scored without the account, or undefined when clean. */
export function buildSeedFailureMessage(result: DaySignalsSeedResult): string | undefined {
  const problems: string[] = [];
  if (result.symbolsWithoutTodaySnapshot.length > 0) problems.push(`no snapshot for today, so no Day Signals pool: ${result.symbolsWithoutTodaySnapshot.join(", ")}`);
  if (result.accountContextUnavailable) problems.push("account summary unavailable, so free cash was taken as 0 and every candidate is marked non-executable");
  return problems.length > 0 ? problems.join("; ") : undefined;
}

export async function seedDaySignals(tradingDateIso: string, deps: DaySignalsSeedDependencies = defaultDaySignalsSeedDependencies): Promise<DaySignalsSeedResult> {
  const [tickers, settings] = await Promise.all([deps.loadSignalsUniverseTickers(), deps.loadTradingSettings()]);
  // Free cash only affects the executable flag, never the ranking — a missing account summary must not block the seed.
  let accountContextUnavailable = false;
  const account = await deps.loadAccountContext().catch((error) => {
    console.warn(`day signals seed: account context unavailable (${error instanceof Error ? error.message : error}) — seeding without it`);
    accountContextUnavailable = true;
    return { freeCash: 0 };
  });

  const result: DaySignalsSeedResult = { tradingDateIso, tickersScored: 0, tickersPooled: 0, expiriesPooled: 0, symbolsWithoutPool: [], symbolsWithoutTodaySnapshot: [], accountContextUnavailable, modelPredictionsRecorded: null };
  const seeds: DaySignalTickerSeed[] = [];
  const predictions: SignalModelPrediction[] = [];
  for (const ticker of tickers) {
    const inputs = await deps.loadTickerSignalsInputs(ticker);
    if (!inputs.header || inputs.header.tradingDateIso !== tradingDateIso) {
      result.symbolsWithoutTodaySnapshot.push(ticker.symbol);
      continue;
    }
    result.tickersScored += 1;
    const scored = scoreTicker(inputs, account, settings);
    predictions.push(...modelPredictionsFromCandidates(ticker.tickerId, tradingDateIso, scored.candidates));
    // Only an expiry the snapshot actually holds can be refreshed; an expired leg's expiry never is.
    const snapshotExpiries = new Set(inputs.slices.map((slice) => slice.expiry));
    const heldLegExpiries = inputs.openShortLegs.map((leg) => leg.expiry).filter((expiry) => snapshotExpiries.has(expiry));
    const expiries = selectDaySignalExpiries(scored.candidates, undefined, heldLegExpiries);
    if (expiries.length === 0) {
      result.symbolsWithoutPool.push(ticker.symbol);
      continue;
    }
    seeds.push({ tickerId: ticker.tickerId, snapshotId: inputs.header.snapshotId, expiries });
    result.tickersPooled += 1;
    result.expiriesPooled += expiries.length;
  }

  await deps.replaceDaySignalPool(tradingDateIso, seeds, deps.now());
  // The prediction log is evidence for the monthly model check, never a reason to lose the day's pool.
  try {
    await deps.recordSignalModelPredictions(predictions);
    result.modelPredictionsRecorded = predictions.length;
  } catch (error) {
    console.warn(`day signals seed: logging ${predictions.length} model predictions failed (${error instanceof Error ? error.message : error})`);
  }
  return result;
}
