import { db } from "../db/connection.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { computePositionExposures } from "../lib/positionExposure.js";
import { loadTradingSettings, type TradingSettings } from "../lib/tradingSettingsStore.js";
import { scoreTicker, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import { accountContextFromTotalCash, loadBarsForTilt, loadSignalsUniverseTickers, loadTickerSignalsInputs, type SignalsTickerRow } from "../lib/signalsStore.js";
import { computeIvMetrics } from "../lib/ivMetrics.js";
import { computeMoveContext, type MoveContext } from "./moveContext.js";
import type { TickerSignals, TickerSignalsInputs } from "../lib/signalsTypes.js";
import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { HeldLegScore } from "../lib/rollSignalCandidates.js";
import { anyOpenPositionOn, loadInFlightNotionals, loadOccupiedContracts, loadPlutoBook } from "./book.js";
import { deterministicTopPick, filterTickerForPluto, findSameContractConflict, openCandidateId, rejectOpenCandidate, rejectTicker, rollCandidateId, type OccupiedContract, type PlutoOpenCandidate, type PlutoRollCandidate, type PlutoTickerFilterResult } from "./candidateFilters.js";
import { flaggedSymbols, noTrade, parsePlutoDecision, type PlutoDecision } from "./decisionSchema.js";
import { updatePlutoConcernAlerts } from "./concernAlerts.js";
import { executePlutoClose, executePlutoOrder, watchPlutoOrder } from "./executor.js";
import { buildCloseOffersForTicker, type CloseOffer } from "./closeActions.js";
import { previousOpenSessionDate } from "../lib/marketSessionStatus.js";
import { easternMinutesOfDay } from "../lib/easternIsoDate.js";
import { fetchPlutoAccountSummary } from "./accountSummaryCache.js";
import { candidateSetFingerprint, classifyFingerprintChange, tickerFingerprint } from "./inputHash.js";
import { ensurePlutoPrompt } from "./prompts.js";
import { finishPlutoPass, type FinishPlutoPassInput, recordPlutoAction, updatePlutoAction, recordPlutoDecision, recordPlutoEvent, startPlutoPass, type PlutoGateResult, type PlutoSystemCheck, type PlutoTrigger, relabelPlutoPass } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { callPlutoModel } from "./modelClient.js";
import { runPostModelGates } from "./postModelGates.js";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, plutoPromptVersion, recentDecisionsForPrompt, type PlutoPromptTickerInput } from "./prompt.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadPlutoState, recordPlutoPass, tripPlutoBreaker } from "./stateStore.js";
import { runPlutoSystemChecks } from "./systemChecks.js";

// One evaluation pass (design rounds 3–4, 2026-09-28): system checks → fresh scoring of the enabled
// tickers with a focused quote burst → deterministic filters → fingerprint → (only if something
// changed, or on the opening look) two model calls that must agree → post-model gates on a fresh
// re-score → the real order routes. Everything is written to the ledger as it happens.

export interface PassRunnerContext {
  api: InternalApiClient;
  openRouterApiKey: string;
  marketWatch: PlutoMarketWatch;
  /** Per-symbol fingerprint of what the model last saw. Owned by the agent across passes. */
  lastFingerprintBySymbol: Map<string, string>;
  /** Per-symbol time of the last model evaluation, for the per-ticker cooldown. */
  lastModelEvaluationAtBySymbol: Map<string, number>;
  /** Order watches the agent keeps alive after the pass returns. */
  trackWatch: (promise: Promise<unknown>, orderId: string, symbol: string) => void;
}

export interface PassRequest {
  trigger: PlutoTrigger;
  triggerDetail: Record<string, unknown>;
  /** Symbols this pass is about (empty = every enabled ticker). */
  symbols: string[];
  /** The opening look evaluates even when nothing changed. */
  force: boolean;
  /** Before today's opening look: opens would rest on yesterday's data, so only closes and rolls of held positions are offered. */
  heldPositionsOnly?: boolean;
}

export interface PassSummary {
  passId: string;
  modelCalled: boolean;
  skippedReason: string | null;
  outcome: string | null;
  /** The round stopped at the system checks (account data, worker, reconciliation…): nothing was analysed. */
  skippedOnSystemChecks?: boolean;
}

/** A round that failed after its model call: the call was paid for and recorded, so it must not be retried as if nothing ran. */
export class PlutoRoundFailedAfterModelCallError extends Error {
  constructor(message: string, readonly passId: string) {
    super(message);
    this.name = "PlutoRoundFailedAfterModelCallError";
  }
}

interface EvaluatedTicker {
  row: SignalsTickerRow;
  inputs: TickerSignalsInputs;
  scored: TickerSignals;
  filtered: PlutoTickerFilterResult;
  occupiedContracts: OccupiedContract[];
  fingerprint: string;
  closeOffers: CloseOffer[];
}

async function loadEnabledTickerRows(): Promise<SignalsTickerRow[]> {
  const enabled: { ticker_id: string }[] = await db("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).select("ticker_id");
  const enabledIds = new Set(enabled.map((row) => row.ticker_id));
  return (await loadSignalsUniverseTickers()).filter((row) => enabledIds.has(row.tickerId));
}

const isQuoteAgeReason = (reason: string) => reason.startsWith("quote ") || reason === "quote age unknown";

/** True when the candidate is eligible, or out only because its quote is too old (a burst would re-quote it). */
function passesAllButQuoteAge(scored: TickerSignals, filtered: PlutoTickerFilterResult, candidate: SignalCandidate): boolean {
  const id = openCandidateId(scored.symbol, candidate);
  const rejection = filtered.rejected.find((entry) => entry.id === id);
  return rejection ? rejection.reasons.every(isQuoteAgeReason) : true;
}

/** Open candidates out only on quote age: eligible once a burst re-quotes them, so they count before the burst too. */
function candidatesEligibleOnceRequoted(scored: TickerSignals, filtered: PlutoTickerFilterResult): PlutoOpenCandidate[] {
  if (filtered.tickerBlocks.length > 0) return [];
  const eligibleIds = new Set(filtered.eligible.map((entry) => entry.id));
  return scored.candidates
    .filter((candidate) => !eligibleIds.has(openCandidateId(scored.symbol, candidate)) && passesAllButQuoteAge(scored, filtered, candidate))
    .map((candidate) => ({ id: openCandidateId(scored.symbol, candidate), kind: candidate.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", symbol: scored.symbol, candidate }));
}

/** Contracts worth a quote burst: the best candidates by Edge $ that pass every filter except quote age. */
function burstContractsFor(scored: TickerSignals, filtered: PlutoTickerFilterResult, settings: PlutoSettings): { expiry: string; strike: number; right: "C" | "P" }[] {
  const ranked = [...scored.candidates].filter((candidate) => passesAllButQuoteAge(scored, filtered, candidate)).sort((a, b) => b.edgeDollars - a.edgeDollars);
  return ranked.slice(0, settings.burstLines).map((candidate) => ({ expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P" }));
}

async function evaluateTicker(row: SignalsTickerRow, settings: PlutoSettings, context: PassRunnerContext, account: { freeCash: number }, tradingSettings: TradingSettings, botEnabled: boolean, nowMs: number, extraLiveQuotes: LiveOptionQuote[] = []): Promise<EvaluatedTicker> {
  const inputs = await loadTickerSignalsInputs(row);
  const watched = context.marketWatch.snapshot(row.symbol);
  const spot = watched?.last ?? null;
  const live = spot !== null ? { spotPrice: spot, priceSource: "live" as const, liveQuotes: extraLiveQuotes } : undefined;
  const scored = scoreTicker(inputs, account, tradingSettings, live);
  const occupiedContracts = await loadOccupiedContracts(row.symbol);
  const filtered = filterTickerForPluto({ scored, slices: inputs.slices, settings, todayEasternIso: inputs.todayEasternIso, nowMs, botEnabled, occupiedContracts });
  return { row, inputs, scored, filtered, occupiedContracts, fingerprint: tickerFingerprint(filtered.eligible, filtered.eligibleRolls), closeOffers: [] };
}

/** The move-context block for the prompt: bars up to the last completed session, the forecast, today's move and IV rank. A failure costs the block, not the round. */
async function loadMoveContext(ticker: EvaluatedTicker): Promise<MoveContext | null> {
  try {
    const [bars, ivMetrics] = await Promise.all([loadBarsForTilt(ticker.row.tickerId, ticker.inputs.todayEasternIso), computeIvMetrics(ticker.row.tickerId)]);
    const completedBars = bars.filter((bar) => bar.tradingDate < ticker.inputs.todayEasternIso);
    return computeMoveContext({ bars: completedBars, forecastVolatility: ticker.scored.forecast?.volatility ?? null, dayChangePct: ticker.scored.dayChangePercent, ivRank: ivMetrics.ivRank });
  } catch (error) {
    console.warn(`Pluto: move context for ${ticker.row.symbol} unavailable — ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Formulas P1/P2 offers for one ticker; automatic (odd-lot) closes are executed here (only when `executeAutomatic`: the re-score
 * after a burst rebuilds the offers but must never send an automatic close twice), the rest go to the model.
 */
async function attachCloseOffers(ticker: EvaluatedTicker, settings: PlutoSettings, context: PassRunnerContext, previousSessionDateIso: string, passId: string, cancelByMs: number, executeAutomatic: boolean, automaticBudget: { remaining: number } = { remaining: 0 }): Promise<boolean> {
  const watched = context.marketWatch.snapshot(ticker.row.symbol);
  const { offers } = await buildCloseOffersForTicker({ symbol: ticker.row.symbol, heldLegs: ticker.scored.heldLegs, rolls: ticker.scored.rolls, settings, stockBid: watched?.bid ?? null, stockAsk: watched?.ask ?? null, previousSessionDateIso, todayIso: ticker.inputs.todayEasternIso });
  let automaticCloseWorking = false;
  for (const offer of offers) {
    if (!offer.automatic || !executeAutomatic) continue;
    // Automatic closes count against the session's order cap like any other order (counters.ts).
    if (automaticBudget.remaining <= 0) {
      await recordPlutoEvent("warning", { message: `automatic close not sent, the session's order cap is reached: ${offer.description}`, symbol: offer.symbol });
      continue;
    }
    automaticBudget.remaining -= 1;
    const actionId = await recordPlutoAction({ passId, kind: offer.kind, symbol: offer.symbol, tickerId: ticker.row.tickerId, contract: { positionId: offer.positionId, legIds: offer.legIds, ...(offer.contract ?? {}) }, candidateScores: offer.detail, deterministicTopPick: null, gateResults: [{ gate: "automatic_close", ok: true, detail: offer.automaticReason ?? "automatic close" }], sizeTier: null, quantity: offer.quantity, limitPrice: offer.limitPrice, outcome: "validated", blockReason: null, referenceBid: offer.limitPrice, referenceMid: offer.limitPrice });
    if (offer.otherReferenceLegs) await updatePlutoAction(actionId, { referenceOtherLegs: offer.otherReferenceLegs });
    const result = await executePlutoClose(context.api, settings, { actionId, symbol: offer.symbol, positionId: offer.positionId, legs: offer.legIds.map((legId) => ({ legId, limitPrice: offer.legLimitPrices?.[legId] ?? offer.limitPrice })), description: offer.description, reasons: [`automatic close: ${offer.automaticReason ?? "no reason recorded"}`] });
    if (result.outcome === "confirmed" && result.orderId) {
      automaticCloseWorking = true;
      context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: offer.symbol, reference: { price: offer.limitPrice, side: offer.side, multiplier: offer.multiplier, ...(offer.otherReferenceLegs ? { otherLegs: offer.otherReferenceLegs } : {}) }, description: offer.description, cancelByMs }), result.orderId, offer.symbol);
    }
  }
  // With an automatic close now working on the ticker, anything the model chose for it would be blocked by the
  // working-order gate: it is offered nothing for that ticker this round (the order's end queues a fresh round).
  if (automaticCloseWorking) {
    ticker.filtered = { ...ticker.filtered, eligible: [], eligibleRolls: [] };
    ticker.closeOffers = [];
    return true;
  }
  ticker.closeOffers = offers.filter((offer) => !offer.automatic);
  return false;
}

/**
 * The Signals snapshot fields the order routes check (signalSnapshotLiveQuotes.ts): an open records its contract
 * as `candidate`, a roll as kind "roll" with `closeLeg` and `replacement`, each with the quote it is priced from,
 * so a Pluto order is refused unless every quote is live and fresh, like any other Signals order.
 */
export function signalsSnapshotForOpen(candidate: SignalCandidate | null): { candidate: SignalCandidate | null } {
  return { candidate };
}

export function signalsSnapshotForRoll(closeLeg: HeldLegScore | null, replacement: SignalCandidate | null): { kind: "roll"; closeLeg: HeldLegScore | null; replacement: SignalCandidate | null } {
  return { kind: "roll", closeLeg, replacement };
}

export async function runPlutoPass(request: PassRequest, context: PassRunnerContext): Promise<PassSummary> {
  const settings = await loadPlutoSettings();
  const passId = await startPlutoPass(request.trigger, request.triggerDetail, settings);
  let passFinished = false;
  let modelCallRecorded = false;
  const finishPass = async (input: FinishPlutoPassInput) => {
    await finishPlutoPass(passId, input);
    passFinished = true;
    modelCallRecorded = input.modelCalled === true;
  };
  try {
    return await runStartedPass(request, context, settings, passId, finishPass);
  } catch (error) {
    // A pass already finished keeps what it recorded; one that recorded its model call must not be retried as if nothing ran.
    if (modelCallRecorded) throw new PlutoRoundFailedAfterModelCallError(error instanceof Error ? error.message : String(error), passId);
    if (passFinished) throw error;
    try {
      await finishPlutoPass(passId, { skippedReason: `round failed: ${error instanceof Error ? error.message : String(error)}` });
    } catch {
      // The round's own error is the one worth reporting; the abandoned-pass sweep closes the row later.
    }
    throw error;
  }
}

async function runStartedPass(request: PassRequest, context: PassRunnerContext, settings: PlutoSettings, passId: string, finishPass: (input: FinishPlutoPassInput) => Promise<void>): Promise<PassSummary> {
  // A round with no symbols of its own (opening look, settings change) looks at every enabled ticker: name them,
  // so the Event log's ticker filter finds the round.
  const enabledRows = await loadEnabledTickerRows();
  const rows = request.symbols.length > 0 ? enabledRows.filter((row) => request.symbols.includes(row.symbol)) : enabledRows;
  await recordPlutoEvent("pass_started", { passId, trigger: request.trigger, symbols: request.symbols.length > 0 ? request.symbols : rows.map((row) => row.symbol) });
  const now = new Date();
  const nowMs = now.getTime();

  const skip = async (reason: string, systemChecks?: Record<string, PlutoSystemCheck>): Promise<PassSummary> => {
    await finishPass({ skippedReason: reason, modelCalled: false, ...(systemChecks ? { systemChecks } : {}) });
    await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason });
    await recordPlutoPass();
    return { passId, modelCalled: false, skippedReason: reason, outcome: null };
  };

  // 1. System gates.
  const checks = await runPlutoSystemChecks(settings, now);
  // The daily-loss check is also a breaker (design item 51): tripping it needs a human reset.
  if (checks.checks.daily_loss && !checks.checks.daily_loss.ok && !checks.checks.daily_loss.detail.startsWith("cannot compute") && !checks.checks.daily_loss.detail.startsWith("could not read")) {
    const before = await loadPlutoState();
    if (!before.breakers.daily_loss) {
      await tripPlutoBreaker("daily_loss", checks.checks.daily_loss.detail);
      await recordPlutoEvent("breaker_tripped", { name: "daily_loss", detail: checks.checks.daily_loss.detail });
      await notifyPlutoTelegram(`🛑 Pluto breaker tripped (daily_loss): ${checks.checks.daily_loss.detail}. Pluto is paused until a human resets it.`);
    }
  }
  // A reconciliation discrepancy is a breaker too (design breaker list): IBKR and the book disagree.
  if (checks.checks.reconciliation && !checks.checks.reconciliation.ok && checks.checks.reconciliation.detail.startsWith("discrepancy")) {
    const before = await loadPlutoState();
    if (!before.breakers.reconciliation) {
      await tripPlutoBreaker("reconciliation", checks.checks.reconciliation.detail);
      await recordPlutoEvent("breaker_tripped", { name: "reconciliation", detail: checks.checks.reconciliation.detail });
      await notifyPlutoTelegram(`🛑 Pluto breaker tripped (reconciliation): ${checks.checks.reconciliation.detail}. Pluto is paused until a human resets it.`);
    }
  }
  if (!checks.ok) return { ...(await skip(checks.failures.join(" | "), checks.checks)), skippedOnSystemChecks: true };

  // Market stress (design round 4, item 72): a broad intraday drop blocks new opens for as long as it
  // lasts; rolls and profit-taking closes stay allowed. Recorded as a check, not a breaker, so it lifts
  // on its own when SPY recovers.
  const spyDayChangePct = context.marketWatch.spyDayChangePct();
  const stressOverridden = checks.context.state.stressOverrideDate === checks.context.todayEasternIso;
  const marketStress = spyDayChangePct !== null && spyDayChangePct <= -settings.spyStressBreakerPct && !stressOverridden;
  checks.checks.market_stress = {
    ok: !marketStress,
    detail: `${spyDayChangePct === null ? "SPY day change unknown" : `SPY ${spyDayChangePct.toFixed(2)}% (opens blocked at -${settings.spyStressBreakerPct}%)`}${stressOverridden ? ` — override on for today${checks.context.state.stressOverrideByDisplayName ? ` by ${checks.context.state.stressOverrideByDisplayName}` : ""}` : ""}`,
  };

  // 2. Universe (loaded above).
  if (rows.length === 0) return skip("no enabled tickers to evaluate", checks.checks);
  // Free cash from the summary the system checks just read: a second fetch could time out on its own.
  const [account, tradingSettings] = await Promise.all([accountContextFromTotalCash(checks.context.totalCashValue), loadTradingSettings()]);

  // 3. Score from the Day Signals data and filter; no quote burst yet (2026-10-07: bursting first cost 10 lines for 4 s on every
  // round, ~2,200 a session, only to find that nothing had changed or that the ticker was still cooling down).
  const cooldownMs = settings.perTickerModelCooldownMinutes * 60_000;
  const coolingDown = (symbol: string) => nowMs - (context.lastModelEvaluationAtBySymbol.get(symbol) ?? 0) < cooldownMs;
  // A held position can have an automatic close due (odd lots, a buyback before earnings), so its ticker is never skipped here.
  if (!request.force && rows.every((row) => coolingDown(row.symbol)) && !(await anyOpenPositionOn(rows.map((row) => row.symbol)))) return skip("every ticker in this round is cooling down", checks.checks);
  const opensBlockedBecause = marketStress ? "market stress: new opens blocked while SPY is down" : request.heldPositionsOnly ? "opens wait for today's opening look" : null;
  const blockOpensWhenBarred = (ticker: EvaluatedTicker) => {
    if (!opensBlockedBecause) return;
    ticker.filtered.rejected.push(...ticker.filtered.eligible.map((entry) => ({ id: entry.id, reasons: [opensBlockedBecause] })));
    ticker.filtered.eligible = [];
  };
  let evaluated: EvaluatedTicker[] = [];
  for (const row of rows) {
    const ticker = await evaluateTicker(row, settings, context, account, tradingSettings, true, nowMs);
    blockOpensWhenBarred(ticker);
    evaluated.push(ticker);
  }
  const previousSessionDateIso = await previousOpenSessionDate(checks.context.todayEasternIso);
  const automaticBudget = { remaining: settings.maxActionsPerSession - checks.context.counters.actionsToday };
  // What the round looked at, before any live quote: what the next round compares against.
  const lookedAtFingerprintBySymbol = new Map<string, string>();
  let offeredCount = 0;
  const automaticCloseWorkingSymbols = new Set<string>();
  for (const ticker of evaluated) {
    if (await attachCloseOffers(ticker, settings, context, previousSessionDateIso, passId, checks.context.session.cancelByMs, true, automaticBudget)) automaticCloseWorkingSymbols.add(ticker.row.symbol);
    const requotable = opensBlockedBecause ? [] : candidatesEligibleOnceRequoted(ticker.scored, ticker.filtered);
    lookedAtFingerprintBySymbol.set(ticker.row.symbol, tickerFingerprint([...ticker.filtered.eligible, ...requotable], ticker.filtered.eligibleRolls, ticker.closeOffers.map((offer) => offer.id)));
    offeredCount += ticker.filtered.eligible.length + requotable.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length;
  }

  // 4. Only call the model when something material changed (or on the opening look).
  const changed = evaluated.filter((ticker) => context.lastFingerprintBySymbol.get(ticker.row.symbol) !== lookedAtFingerprintBySymbol.get(ticker.row.symbol) && !coolingDown(ticker.row.symbol));
  const skipNothingEligible = async (reason: string) => {
    for (const ticker of evaluated) context.lastFingerprintBySymbol.set(ticker.row.symbol, lookedAtFingerprintBySymbol.get(ticker.row.symbol) ?? ticker.fingerprint);
    await finishPass({ candidateCount: 0, systemChecks: checks.checks, modelCalled: false, skippedReason: reason });
    await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason: "nothing eligible", tickers: evaluated.map((ticker) => ({ symbol: ticker.row.symbol, blocks: ticker.filtered.tickerBlocks, rejected: ticker.filtered.rejected.length })) });
    await recordPlutoPass();
    return { passId, modelCalled: false, skippedReason: "nothing eligible", outcome: null };
  };
  // Nothing held to manage yet: not a "nothing eligible" round, so the next round (the opening look) compares against nothing.
  if (offeredCount === 0 && request.heldPositionsOnly) return skip("waiting for today's opening look: no held position to manage", checks.checks);
  if (offeredCount === 0) return skipNothingEligible("nothing eligible after the deterministic filters");
  if (!request.force && changed.length === 0) return skip("no material change since the model last looked", checks.checks);
  const changeKinds = changed.map((ticker) => ({ symbol: ticker.row.symbol, kind: classifyFingerprintChange(context.lastFingerprintBySymbol.get(ticker.row.symbol), lookedAtFingerprintBySymbol.get(ticker.row.symbol)!) }));

  // 4b. The model will be called: only now burst the promising contracts and re-score with the live quotes.
  const refreshed: EvaluatedTicker[] = [];
  for (const ticker of evaluated) {
    // A ticker with an automatic close just sent stays empty for the model (see attachCloseOffers): no burst, no re-score.
    if (automaticCloseWorkingSymbols.has(ticker.row.symbol)) {
      refreshed.push(ticker);
      continue;
    }
    // Opens blocked for the round (market stress, before the opening look): nothing worth a burst but the held legs' own quotes.
    const contracts = ticker.filtered.tickerBlocks.length === 0 && !opensBlockedBecause ? burstContractsFor(ticker.scored, ticker.filtered, settings) : [];
    const liveQuotes = contracts.length > 0 ? await context.marketWatch.burst(ticker.row.symbol, contracts) : [];
    if (liveQuotes.length === 0) {
      refreshed.push(ticker);
      continue;
    }
    const requoted = await evaluateTicker(ticker.row, settings, context, account, tradingSettings, true, Date.now(), liveQuotes);
    blockOpensWhenBarred(requoted);
    await attachCloseOffers(requoted, settings, context, previousSessionDateIso, passId, checks.context.session.cancelByMs, false);
    refreshed.push(requoted);
  }
  evaluated = refreshed;
  offeredCount = evaluated.reduce((sum, ticker) => sum + ticker.filtered.eligible.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length, 0);
  if (offeredCount === 0) return skipNothingEligible("nothing eligible once re-quoted live");
  // A Day Signals update is only the messenger: name the round after what actually changed.
  let trigger: PlutoTrigger = request.trigger;
  let triggerDetail = request.triggerDetail;
  if (request.trigger === "day_signals_update" && changed.length > 0) {
    const kinds = changeKinds;
    const heldLeg = kinds.filter((entry) => entry.kind === "held_leg").map((entry) => entry.symbol);
    const gradeCrossing = kinds.filter((entry) => entry.kind === "grade_crossing").map((entry) => entry.symbol);
    trigger = gradeCrossing.length > 0 ? "grade_crossing" : "held_leg";
    triggerDetail = { ...request.triggerDetail, symbols: kinds.map((entry) => entry.symbol), gradeCrossing, heldLeg };
    await relabelPlutoPass(passId, trigger, triggerDetail);
  }

  // 5. Prompt.
  const book = await loadPlutoBook();
  const recentDecisions: { pass_id: string; parsed_output: { decision?: string; candidate_id?: string | null; reasons?: string[] } | null; created_at: Date }[] = await db("pluto_decisions").whereNotNull("parsed_output").orderBy("created_at", "desc").limit(10).select("pass_id", "parsed_output", "created_at");
  const tradePassIds = recentDecisions.filter((row) => row.parsed_output?.decision === "trade").map((row) => row.pass_id);
  // The model's own action per pass: not an automatic close recorded in the same round (those carry the automatic_close
  // gate), and the "chosen candidate not found" row (kind no_trade, outcome blocked) included. Oldest first, so the last wins.
  const tradeActions: { pass_id: string; outcome: string; block_reason: string | null }[] =
    tradePassIds.length === 0
      ? []
      : await db("pluto_actions")
          .whereIn("pass_id", tradePassIds)
          .whereNot((builder) => builder.where({ kind: "no_trade", outcome: "no_trade" }))
          .whereRaw("not coalesce(gate_results, '[]'::jsonb) @> ?::jsonb", [JSON.stringify([{ gate: "automatic_close" }])])
          .orderBy("created_at")
          .orderBy("id")
          .select("pass_id", "outcome", "block_reason");
  const openPositionsBySymbol: Record<string, string[]> = {};
  for (const position of book.openPositions) (openPositionsBySymbol[position.symbol] ??= []).push(position.strategyKey);
  const tickersForPrompt: PlutoPromptTickerInput[] = await Promise.all(
    evaluated.map(async (ticker) => ({ scored: ticker.scored, eligible: ticker.filtered.eligible, eligibleRolls: ticker.filtered.eligibleRolls, closeActions: ticker.closeOffers, moveContext: await loadMoveContext(ticker) })),
  );
  const windowEnd = checks.context.session.windowEndEt.split(":").map(Number);
  const minutesToWindowEnd = (windowEnd[0]! * 60 + windowEnd[1]!) - easternMinutesOfDay(now);
  const { payload, offeredIds } = buildPlutoUserPayload({
    now,
    spreadCostSharePct: tradingSettings.spreadCostChargedPct,
    todayEasternIso: checks.context.todayEasternIso,
    minutesToWindowEnd,
    spyDayChangePct,
    account: {
      netLiquidationValue: checks.context.netLiquidationValue ?? 0,
      freeCash: account.freeCash,
      plutoBudgetPct: settings.capitalBudgetPct,
      plutoBudgetUsedPct: checks.context.netLiquidationValue ? (book.committedDollars / checks.context.netLiquidationValue) * 100 : 0,
      managedPositions: book.openPositions.length,
      maxOpenPositions: settings.maxOpenPositions,
      actionsToday: checks.context.counters.actionsToday,
      maxActionsPerSession: settings.maxActionsPerSession,
      openPositionsBySymbol,
    },
    settings,
    tickers: tickersForPrompt,
    recentDecisions: recentDecisionsForPrompt(
      recentDecisions.map((row) => ({ passId: row.pass_id, createdAt: new Date(row.created_at), parsedOutput: row.parsed_output })),
      new Map(tradeActions.map((action) => [action.pass_id, { outcome: action.outcome, blockReason: action.block_reason }])),
    ),
    trigger: { kind: trigger, detail: triggerDetail },
    plutoOpenedPositionIds: book.plutoOpenedPositionIds,
  });
  const systemPrompt = buildPlutoSystemPrompt(settings);
  const promptId = await ensurePlutoPrompt(settings.promptVersion, systemPrompt);
  const userPayload = JSON.stringify(payload);

  // 6. One call per decision (Marcelo, 2026-10-06: the deterministic gates are the second opinion; a second call doubled the cost).
  for (const ticker of evaluated) {
    context.lastFingerprintBySymbol.set(ticker.row.symbol, lookedAtFingerprintBySymbol.get(ticker.row.symbol) ?? ticker.fingerprint);
    context.lastModelEvaluationAtBySymbol.set(ticker.row.symbol, nowMs);
  }
  const call = await modelCall(1);
  const servedModelIds = call.servedModelId ? [call.servedModelId] : [];
  const tokensIn = call.tokensIn ?? 0;
  const tokensOut = call.tokensOut ?? 0;
  const costUsd = call.costUsd ?? 0;
  let decision: PlutoDecision;
  let agreementDetail: string;
  if (call.decision === null) {
    decision = noTrade(`model call failed: ${call.error}`);
    agreementDetail = "the call failed";
    await recordPlutoEvent("model_failed", { passId, error: call.error });
  } else {
    decision = call.decision;
    agreementDetail = "single call";
  }
  await recordPlutoEvent("model_called", { passId, trigger, triggerDetail, servedModelIds, costUsd, verdict: decision.decision, candidateId: decision.candidateId, confidence: decision.confidence, actionKind: decision.actionKind, agreement: agreementDetail, reasons: decision.reasons });
  await finishPass({ inputHash: candidateSetFingerprint(evaluated.flatMap((ticker) => ticker.filtered.eligible), evaluated.flatMap((ticker) => ticker.filtered.eligibleRolls)), candidateCount: offeredCount, systemChecks: checks.checks, modelCalled: true, skippedReason: null, tokensIn, tokensOut, costUsd, servedModelIds });
  await recordPlutoPass();
  // The model's data concerns, per ticker (start / at most hourly / cleared), under the same switch as every Pluto message.
  // A failed call says nothing about the data, so it neither raises nor clears a concern.
  if (call.decision !== null && settings.telegramVerbosity !== "off") {
    const roundSymbols = evaluated.filter((ticker) => ticker.filtered.eligible.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length > 0).map((ticker) => ticker.row.symbol);
    await updatePlutoConcernAlerts({ roundSymbols, concerns: decision.systemConcerns }).catch((error) => console.warn(`Pluto: concern alert failed — ${error instanceof Error ? error.message : error}`));
  }

  // 7. Outcome.
  const topPick = deterministicTopPick(evaluated.flatMap((ticker) => ticker.filtered.eligible));
  const topPickSummary = topPick ? { id: topPick.id, edgeDollars: topPick.candidate.edgeDollars, netEdge: topPick.candidate.netEdge, grade: topPick.candidate.grade } : null;
  if (decision.decision !== "trade") {
    await recordPlutoAction({ passId, kind: "no_trade", symbol: "—", tickerId: null, contract: null, candidateScores: null, deterministicTopPick: topPickSummary, gateResults: [], sizeTier: null, quantity: null, limitPrice: null, outcome: "no_trade", blockReason: decision.reasons.join(" "), referenceBid: null, referenceMid: null });
    await recordPlutoEvent("no_trade", { passId, verdict: decision.decision, reasons: decision.reasons, systemConcerns: decision.systemConcerns, deterministicTopPick: topPickSummary });
    return { passId, modelCalled: true, skippedReason: null, outcome: decision.decision };
  }

  const chosenId = decision.candidateId!;
  const owner = evaluated.find((ticker) => ticker.filtered.eligible.some((entry) => entry.id === chosenId) || ticker.filtered.eligibleRolls.some((entry) => entry.id === chosenId) || ticker.closeOffers.some((offer) => offer.id === chosenId));
  if (!owner) {
    await recordPlutoAction({ passId, kind: "no_trade", symbol: "—", tickerId: null, contract: null, candidateScores: null, deterministicTopPick: topPickSummary, gateResults: [{ gate: "candidate_present", ok: false, detail: `${chosenId} not found among the offers` }], sizeTier: null, quantity: null, limitPrice: null, outcome: "blocked", blockReason: "chosen candidate not found", referenceBid: null, referenceMid: null });
    return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
  }
  // Never trade a ticker the model itself flagged in the same answer (prompt v3.3), nor anything when it flagged the whole message.
  const flaggedWholeMessage = decision.systemConcerns.some((concern) => concern.symbol === null);
  if (flaggedWholeMessage || flaggedSymbols(decision).has(owner.row.symbol)) {
    const failed = [flaggedWholeMessage ? { gate: "flagged_message", ok: false, detail: "the model flagged the whole message's data in the same answer" } : { gate: "flagged_ticker", ok: false, detail: `the model flagged ${owner.row.symbol}'s data in the same answer` }];
    const actionId = await recordPlutoAction({ passId, kind: decision.actionKind!, symbol: owner.row.symbol, tickerId: owner.row.tickerId, contract: null, candidateScores: null, deterministicTopPick: topPickSummary, gateResults: failed, sizeTier: null, quantity: null, limitPrice: null, outcome: "blocked", blockReason: `${failed[0]!.gate}: ${failed[0]!.detail}`, referenceBid: null, referenceMid: null });
    await recordPlutoEvent("action_blocked", { passId, actionId, symbol: owner.row.symbol, candidateId: chosenId, stage: "post_model", failed });
    return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
  }
  const chosenClose = owner.closeOffers.find((offer) => offer.id === chosenId);
  if (chosenClose) return runChosenClose(owner, chosenClose);
  const chosenOpen: PlutoOpenCandidate | undefined = owner.filtered.eligible.find((entry) => entry.id === chosenId);
  const chosenRoll: PlutoRollCandidate | undefined = owner.filtered.eligibleRolls.find((entry) => entry.id === chosenId);
  const netEdgeAtDecision = chosenOpen ? chosenOpen.candidate.netEdge : chosenRoll!.roll.netRollEdge;

  // 8. Fresh re-score of the chosen contract only, then the post-model gates.
  // A roll bursts the held leg too: its buyback is priced from it, and the order routes accept only live quotes for both legs.
  const heldLegToRoll = chosenRoll ? owner.scored.heldLegs.find((leg) => leg.legId === chosenRoll.roll.legId) ?? null : null;
  const burstContracts = chosenOpen
    ? [{ expiry: chosenOpen.candidate.expiry, strike: chosenOpen.candidate.strike, right: chosenOpen.candidate.strategyKey === "covered_call" ? ("C" as const) : ("P" as const) }]
    : [
        { expiry: chosenRoll!.roll.replacement.expiry, strike: chosenRoll!.roll.replacement.strike, right: chosenRoll!.roll.replacement.strategyKey === "covered_call" ? ("C" as const) : ("P" as const) },
        ...(heldLegToRoll ? [{ expiry: heldLegToRoll.expiry, strike: heldLegToRoll.strike, right: heldLegToRoll.right }] : []),
      ];
  const freshQuotes = await context.marketWatch.burst(owner.row.symbol, burstContracts);
  const fresh = await evaluateTicker(owner.row, settings, context, account, tradingSettings, true, Date.now(), freshQuotes);
  const freshCandidate = chosenOpen ? fresh.scored.candidates.find((candidate) => openCandidateId(owner.row.symbol, candidate) === chosenId) ?? null : null;
  const freshRoll = chosenRoll ? fresh.scored.rolls.find((roll) => rollCandidateId(owner.row.symbol, roll) === chosenId) ?? null : null;
  const slicesByExpiry = new Map(fresh.inputs.slices.map((slice) => [slice.expiry, slice]));
  const freshRejectionReasons = [
    ...rejectTicker({ scored: fresh.scored, slices: fresh.inputs.slices, settings, todayEasternIso: fresh.inputs.todayEasternIso, nowMs: Date.now(), botEnabled: true }),
    ...(freshCandidate ? rejectOpenCandidate(freshCandidate, { scored: fresh.scored, slicesByExpiry, settings, nowMs: Date.now() }) : chosenOpen ? ["the chosen contract is no longer a candidate"] : []),
    ...(chosenRoll && !freshRoll ? ["the chosen roll is no longer a candidate"] : []),
  ];
  const [exposures, inFlight] = await Promise.all([computePositionExposures(), loadInFlightNotionals(owner.row.symbol)]);
  const freshContractForGate = freshCandidate ?? freshRoll?.replacement ?? null;
  const sector = owner.row.sector ?? null;
  const gates = runPostModelGates({
    decision,
    candidate: freshCandidate,
    roll: freshRoll,
    freshRejectionReasons,
    netEdgeAtDecision,
    settings,
    sector,
    book: {
      netLiquidationValue: checks.context.netLiquidationValue ?? 0,
      freeCash: account.freeCash,
      committedDollars: book.committedDollars,
      inFlight,
      openPositionCount: book.openPositions.length,
      existingTickerExposure: exposures.filter((row) => row.symbol === owner.row.symbol).reduce((sum, row) => sum + row.exposure, 0),
      existingSectorExposure: sector === null ? 0 : exposures.filter((row) => row.sector === sector).reduce((sum, row) => sum + row.exposure, 0),
      freeShares: fresh.scored.freeShares,
      spotPrice: fresh.scored.spotPrice,
      workingOrderOnSymbol: book.workingOrderSymbols.has(owner.row.symbol),
      lastFilledActionAt: book.lastFilledActionAtBySymbol.get(owner.row.symbol) ?? null,
      nowMs: Date.now(),
      sameContractConflict: freshContractForGate ? findSameContractConflict(fresh.occupiedContracts, freshContractForGate.expiry, freshContractForGate.strike) : null,
    },
  });
  const contract = freshCandidate ?? freshRoll?.replacement ?? null;
  const gateResults: PlutoGateResult[] = gates.gates;
  const actionId = await recordPlutoAction({
    passId,
    kind: chosenOpen ? chosenOpen.kind : "roll",
    symbol: owner.row.symbol,
    tickerId: owner.row.tickerId,
    contract: contract
      ? { strategyKey: contract.strategyKey, expiry: contract.expiry, strike: contract.strike, right: contract.strategyKey === "covered_call" ? "C" : "P", legId: chosenRoll?.roll.legId, ...(heldLegToRoll ? { fromStrike: heldLegToRoll.strike, fromExpiry: heldLegToRoll.expiry } : {}) }
      : null,
    candidateScores: freshCandidate ?? freshRoll ?? null,
    deterministicTopPick: topPickSummary,
    gateResults,
    sizeTier: null,
    quantity: gates.plan?.quantity ?? null,
    limitPrice: gates.plan?.limitPrice ?? null,
    outcome: gates.ok ? "validated" : "blocked",
    blockReason: gates.ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "),
    referenceBid: contract?.bid ?? null,
    referenceMid: contract ? (contract.bid + contract.ask) / 2 : null,
  });
  if (!gates.ok) {
    await recordPlutoEvent("action_blocked", { passId, actionId, symbol: owner.row.symbol, candidateId: chosenId, stage: "post_model", failed: gateResults.filter((gate) => !gate.ok) });
    return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
  }
  await recordPlutoEvent("action_validated", { passId, actionId, symbol: owner.row.symbol, candidateId: chosenId, quantity: gates.plan!.quantity, limitPrice: gates.plan!.limitPrice, reasons: decision.reasons });

  // 9. Execute through the real routes, then watch the order without holding the pass.
  const freshHeldLeg = chosenRoll ? fresh.scored.heldLegs.find((leg) => leg.legId === chosenRoll.roll.legId) ?? null : null;
  const signalsSnapshotShape = chosenOpen ? signalsSnapshotForOpen(freshCandidate) : signalsSnapshotForRoll(freshHeldLeg, freshRoll?.replacement ?? null);
  const scoresSnapshot = { ...signalsSnapshotShape, version: `pluto-${plutoPromptVersion}`, candidateId: chosenId, contract: freshCandidate ?? freshRoll, ticker: { spreadShareCharged: fresh.scored.spreadShareCharged, spotPrice: fresh.scored.spotPrice, snapshotDateIso: fresh.scored.snapshotDateIso, atmImpliedVolatility: fresh.scored.atmImpliedVolatility, forecast: fresh.scored.forecast, dayChangePercent: fresh.scored.dayChangePercent }, decision, plan: gates.plan, deterministicTopPick: topPickSummary };
  const result = await executePlutoOrder(
    context.api,
    settings,
    chosenOpen
      ? { kind: "open", actionId, symbol: owner.row.symbol, candidate: freshCandidate!, plan: gates.plan!, decision, scoresSnapshot }
      : { kind: "roll", actionId, symbol: owner.row.symbol, roll: freshRoll!, heldLeg: fresh.scored.heldLegs.find((leg) => leg.legId === chosenRoll!.roll.legId)!, plan: gates.plan!, decision, scoresSnapshot },
  );
  if (result.outcome === "confirmed" && result.orderId) {
    context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: owner.row.symbol, reference: { price: contract!.bid, side: "sell", multiplier: 100, otherLegs: result.otherReferenceLegs }, description: result.detail, cancelByMs: checks.context.session.cancelByMs }), result.orderId, owner.row.symbol);
  }
  return { passId, modelCalled: true, skippedReason: null, outcome: result.outcome };

  async function runChosenClose(ticker: EvaluatedTicker, offer: CloseOffer): Promise<PassSummary> {
    // Re-derive the offer fresh: the cycle P&L, the quote and the leg's edge can all have moved.
    const watched = context.marketWatch.snapshot(ticker.row.symbol);
    const freshScored = (await evaluateTicker(ticker.row, settings, context, account, tradingSettings, true, Date.now())).scored;
    const rebuilt = await buildCloseOffersForTicker({ symbol: ticker.row.symbol, heldLegs: freshScored.heldLegs, rolls: freshScored.rolls, settings, stockBid: watched?.bid ?? null, stockAsk: watched?.ask ?? null, previousSessionDateIso, todayIso: checks.context.todayEasternIso });
    const freshOffer = rebuilt.offers.find((entry) => entry.id === offer.id) ?? null;
    const gateResults: PlutoGateResult[] = [
      { gate: "verdict", ok: true, detail: "trade" },
      { gate: "confidence_floor", ok: decision.confidence >= settings.confidenceFloor, detail: `${decision.confidence.toFixed(2)} vs floor ${settings.confidenceFloor}` },
      { gate: "offer_fresh", ok: freshOffer !== null, detail: freshOffer ? "still offered on fresh data" : rebuilt.skipped.find((entry) => entry.id === offer.id)?.reason ?? "no longer offered" },
      { gate: "working_order", ok: !book.workingOrderSymbols.has(ticker.row.symbol), detail: book.workingOrderSymbols.has(ticker.row.symbol) ? "a Pluto order on this symbol is already working" : "no working Pluto order on the symbol" },
    ];
    const ok = gateResults.every((gate) => gate.ok);
    const actionId = await recordPlutoAction({ passId, kind: offer.kind, symbol: offer.symbol, tickerId: ticker.row.tickerId, contract: { positionId: offer.positionId, legIds: offer.legIds, ...(offer.contract ?? {}) }, candidateScores: (freshOffer ?? offer).detail, deterministicTopPick: topPickSummary, gateResults, sizeTier: null, quantity: (freshOffer ?? offer).quantity, limitPrice: (freshOffer ?? offer).limitPrice, outcome: ok ? "validated" : "blocked", blockReason: ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "), referenceBid: (freshOffer ?? offer).limitPrice, referenceMid: (freshOffer ?? offer).limitPrice });
    if (!ok) {
      await recordPlutoEvent("action_blocked", { passId, actionId, symbol: offer.symbol, candidateId: offer.id, stage: "post_model", failed: gateResults.filter((gate) => !gate.ok) });
      return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
    }
    await recordPlutoEvent("action_validated", { passId, actionId, symbol: offer.symbol, candidateId: offer.id, quantity: freshOffer!.quantity, limitPrice: freshOffer!.limitPrice, reasons: decision.reasons });
    const result = await executePlutoClose(context.api, settings, { actionId, symbol: offer.symbol, positionId: freshOffer!.positionId, legs: freshOffer!.legIds.map((legId) => ({ legId, limitPrice: freshOffer!.limitPrice })), description: freshOffer!.description, reasons: decision.reasons });
    if (result.outcome === "confirmed" && result.orderId) context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: offer.symbol, reference: { price: freshOffer!.limitPrice, side: freshOffer!.side, multiplier: freshOffer!.multiplier }, description: freshOffer!.description, cancelByMs: checks.context.session.cancelByMs }), result.orderId, offer.symbol);
    return { passId, modelCalled: true, skippedReason: null, outcome: result.outcome };
  }

  async function modelCall(callIndex: number) {
    const call = await callPlutoModel({ apiKey: context.openRouterApiKey, modelId: settings.modelId, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.callTimeoutSeconds, systemPrompt, userPayload, seed: callIndex });
    const parsed = call.ok && call.rawText ? parsePlutoDecision(call.rawText, offeredIds) : null;
    const decisionOrNull = parsed && parsed.ok ? parsed.decision : null;
    const error = call.error ?? (parsed && !parsed.ok ? `invalid decision: ${parsed.error}` : null);
    await recordPlutoDecision({ passId, callIndex, modelId: settings.modelId, servedModelId: call.servedModelId, serviceTier: call.serviceTier, promptId, inputPayload: callIndex === 1 ? payload : { sameAsCall: 1 }, rawOutput: call.rawText, parsedOutput: decisionOrNull ? { decision: decisionOrNull.decision, action_kind: decisionOrNull.actionKind, candidate_id: decisionOrNull.candidateId, confidence: decisionOrNull.confidence, reasons: decisionOrNull.reasons, risks_acknowledged: decisionOrNull.risksAcknowledged, system_concerns: decisionOrNull.systemConcerns } : null, schemaValid: decisionOrNull !== null, latencyMs: call.latencyMs, tokensIn: call.tokensIn, tokensOut: call.tokensOut, costUsd: call.costUsd, error });
    return { callIndex, decision: decisionOrNull, error, servedModelId: call.servedModelId, tokensIn: call.tokensIn, tokensOut: call.tokensOut, costUsd: call.costUsd };
  }
}

