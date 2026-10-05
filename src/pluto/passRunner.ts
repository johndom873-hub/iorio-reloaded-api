import { db } from "../db/connection.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { computePositionExposures } from "../lib/positionExposure.js";
import { loadTradingSettings, type TradingSettings } from "../lib/tradingSettingsStore.js";
import { scoreTicker, type LiveOptionQuote } from "../lib/signalsLiveScoring.js";
import { loadAccountContext, loadSignalsUniverseTickers, loadTickerSignalsInputs, type SignalsTickerRow } from "../lib/signalsStore.js";
import type { TickerSignals, TickerSignalsInputs } from "../lib/signalsTypes.js";
import { loadPlutoBook } from "./book.js";
import { deterministicTopPick, filterTickerForPluto, openCandidateId, rejectOpenCandidate, rejectTicker, rollCandidateId, type PlutoOpenCandidate, type PlutoRollCandidate, type PlutoTickerFilterResult } from "./candidateFilters.js";
import { noTrade, parsePlutoDecision, reconcileAgreement, type PlutoDecision } from "./decisionSchema.js";
import { executePlutoClose, executePlutoOrder, watchPlutoOrder } from "./executor.js";
import { buildCloseOffersForTicker, type CloseOffer } from "./closeActions.js";
import { previousOpenSessionDate } from "../lib/marketSessionStatus.js";
import { candidateSetFingerprint, classifyFingerprintChange, tickerFingerprint } from "./inputHash.js";
import { ensurePlutoPrompt } from "./prompts.js";
import { finishPlutoPass, recordPlutoAction, recordPlutoDecision, recordPlutoEvent, startPlutoPass, type PlutoGateResult, type PlutoSystemCheck, type PlutoTrigger, relabelPlutoPass } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { callPlutoModel } from "./modelClient.js";
import { runPostModelGates } from "./postModelGates.js";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, plutoPromptVersion, type PlutoPromptTickerInput } from "./prompt.js";
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
  lastModelCallAtMs: { value: number | null };
  /** Order watches the agent keeps alive after the pass returns. */
  trackWatch: (promise: Promise<unknown>, orderId: string) => void;
}

export interface PassRequest {
  trigger: PlutoTrigger;
  triggerDetail: Record<string, unknown>;
  /** Symbols this pass is about (empty = every enabled ticker). */
  symbols: string[];
  /** The opening look evaluates even when nothing changed. */
  force: boolean;
}

export interface PassSummary {
  passId: string;
  modelCalled: boolean;
  skippedReason: string | null;
  outcome: string | null;
}

interface EvaluatedTicker {
  row: SignalsTickerRow;
  inputs: TickerSignalsInputs;
  scored: TickerSignals;
  filtered: PlutoTickerFilterResult;
  fingerprint: string;
  closeOffers: CloseOffer[];
}

async function loadEnabledTickerRows(): Promise<SignalsTickerRow[]> {
  const enabled: { ticker_id: string }[] = await db("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).select("ticker_id");
  const enabledIds = new Set(enabled.map((row) => row.ticker_id));
  return (await loadSignalsUniverseTickers()).filter((row) => enabledIds.has(row.tickerId));
}

/** Contracts worth a quote burst: the best candidates by Edge $ that pass every filter except quote age. */
function burstContractsFor(scored: TickerSignals, filtered: PlutoTickerFilterResult, settings: PlutoSettings): { expiry: string; strike: number; right: "C" | "P" }[] {
  const ranked = [...scored.candidates]
    .filter((candidate) => {
      const id = openCandidateId(scored.symbol, candidate);
      const rejection = filtered.rejected.find((entry) => entry.id === id);
      const nonAgeReasons = rejection ? rejection.reasons.filter((reason) => !reason.startsWith("quote ") && reason !== "quote age unknown") : [];
      return nonAgeReasons.length === 0;
    })
    .sort((a, b) => b.edgeDollars - a.edgeDollars);
  return ranked.slice(0, settings.burstLines).map((candidate) => ({ expiry: candidate.expiry, strike: candidate.strike, right: candidate.strategyKey === "covered_call" ? "C" : "P" }));
}

async function evaluateTicker(row: SignalsTickerRow, settings: PlutoSettings, context: PassRunnerContext, account: { freeCash: number }, tradingSettings: TradingSettings, botEnabled: boolean, nowMs: number, extraLiveQuotes: LiveOptionQuote[] = []): Promise<EvaluatedTicker> {
  const inputs = await loadTickerSignalsInputs(row);
  const watched = context.marketWatch.snapshot(row.symbol);
  const spot = watched?.last ?? null;
  const live = spot !== null ? { spotPrice: spot, priceSource: "live" as const, liveQuotes: extraLiveQuotes } : undefined;
  const scored = scoreTicker(inputs, account, tradingSettings, live);
  const filtered = filterTickerForPluto({ scored, slices: inputs.slices, settings, todayEasternIso: inputs.todayEasternIso, nowMs, botEnabled });
  return { row, inputs, scored, filtered, fingerprint: tickerFingerprint(filtered.eligible, filtered.eligibleRolls), closeOffers: [] };
}

/** Formulas P1/P2 offers for one ticker; automatic (odd-lot) closes are executed here, the rest go to the model. */
async function attachCloseOffers(ticker: EvaluatedTicker, settings: PlutoSettings, context: PassRunnerContext, previousSessionDateIso: string, passId: string, cancelByMs: number): Promise<void> {
  const watched = context.marketWatch.snapshot(ticker.row.symbol);
  const { offers } = await buildCloseOffersForTicker({ symbol: ticker.row.symbol, heldLegs: ticker.scored.heldLegs, rolls: ticker.scored.rolls, settings, stockBid: watched?.bid ?? null, stockAsk: watched?.ask ?? null, previousSessionDateIso });
  for (const offer of offers) {
    if (!offer.automatic) continue;
    const actionId = await recordPlutoAction({ passId, kind: offer.kind, symbol: offer.symbol, tickerId: ticker.row.tickerId, contract: { positionId: offer.positionId, legIds: offer.legIds }, candidateScores: offer.detail, deterministicTopPick: null, gateResults: [{ gate: "automatic_close", ok: true, detail: "odd lot below 100 shares at a positive cycle P&L (Formula P1)" }], sizeTier: null, quantity: offer.quantity, limitPrice: offer.limitPrice, outcome: "validated", blockReason: null, referenceBid: offer.limitPrice, referenceMid: offer.limitPrice });
    const result = await executePlutoClose(context.api, settings, { actionId, symbol: offer.symbol, positionId: offer.positionId, legs: offer.legIds.map((legId) => ({ legId, limitPrice: offer.limitPrice })), description: offer.description, reasons: ["automatic odd-lot close (Formula P1)"] });
    if (result.outcome === "confirmed" && result.orderId) context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: offer.symbol, reference: { price: offer.limitPrice, side: offer.side, multiplier: offer.multiplier }, description: offer.description, cancelByMs }), result.orderId);
  }
  ticker.closeOffers = offers.filter((offer) => !offer.automatic);
}

export async function runPlutoPass(request: PassRequest, context: PassRunnerContext): Promise<PassSummary> {
  const settings = await loadPlutoSettings();
  const passId = await startPlutoPass(request.trigger, request.triggerDetail, settings);
  await recordPlutoEvent("pass_started", { passId, trigger: request.trigger, symbols: request.symbols });
  const now = new Date();
  const nowMs = now.getTime();

  const skip = async (reason: string, systemChecks?: Record<string, PlutoSystemCheck>): Promise<PassSummary> => {
    await finishPlutoPass(passId, { skippedReason: reason, modelCalled: false, ...(systemChecks ? { systemChecks } : {}) });
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
      await notifyTelegram(`🛑 Pluto breaker tripped (daily_loss): ${checks.checks.daily_loss.detail}. Pluto is paused until a human resets it.`);
    }
  }
  // A reconciliation discrepancy is a breaker too (design breaker list): IBKR and the book disagree.
  if (checks.checks.reconciliation && !checks.checks.reconciliation.ok && checks.checks.reconciliation.detail.startsWith("discrepancy")) {
    const before = await loadPlutoState();
    if (!before.breakers.reconciliation) {
      await tripPlutoBreaker("reconciliation", checks.checks.reconciliation.detail);
      await recordPlutoEvent("breaker_tripped", { name: "reconciliation", detail: checks.checks.reconciliation.detail });
      await notifyTelegram(`🛑 Pluto breaker tripped (reconciliation): ${checks.checks.reconciliation.detail}. Pluto is paused until a human resets it.`);
    }
  }
  if (!checks.ok) return skip(checks.failures.join(" | "), checks.checks);

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

  // 2. Universe.
  const enabledRows = await loadEnabledTickerRows();
  const rows = request.symbols.length > 0 ? enabledRows.filter((row) => request.symbols.includes(row.symbol)) : enabledRows;
  if (rows.length === 0) return skip("no enabled tickers to evaluate", checks.checks);
  const [account, tradingSettings] = await Promise.all([loadAccountContext(), loadTradingSettings()]);

  // 3. Score, burst the promising ones, re-score with live quotes, filter.
  const evaluated: EvaluatedTicker[] = [];
  for (const row of rows) {
    let ticker = await evaluateTicker(row, settings, context, account, tradingSettings, true, nowMs);
    if (ticker.filtered.tickerBlocks.length === 0) {
      const contracts = burstContractsFor(ticker.scored, ticker.filtered, settings);
      if (contracts.length > 0) {
        const liveQuotes = await context.marketWatch.burst(row.symbol, contracts);
        if (liveQuotes.length > 0) ticker = await evaluateTicker(row, settings, context, account, tradingSettings, true, Date.now(), liveQuotes);
      }
    }
    if (marketStress) {
      ticker.filtered.rejected.push(...ticker.filtered.eligible.map((entry) => ({ id: entry.id, reasons: ["market stress: new opens blocked while SPY is down"] })));
      ticker.filtered.eligible = [];
    }
    evaluated.push(ticker);
    context.marketWatch.markEvaluated(row.symbol);
  }
  const previousSessionDateIso = await previousOpenSessionDate(checks.context.todayEasternIso);
  for (const ticker of evaluated) {
    await attachCloseOffers(ticker, settings, context, previousSessionDateIso, passId, checks.context.session.cancelByMs);
    if (ticker.closeOffers.length > 0) ticker.fingerprint = tickerFingerprint(ticker.filtered.eligible, ticker.filtered.eligibleRolls, ticker.closeOffers.map((offer) => offer.id));
  }
  const offeredCount = evaluated.reduce((sum, ticker) => sum + ticker.filtered.eligible.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length, 0);

  // 4. Only call the model when something material changed (or on the opening look).
  const cooldownMs = settings.perTickerModelCooldownMinutes * 60_000;
  const changed = evaluated.filter((ticker) => {
    const previous = context.lastFingerprintBySymbol.get(ticker.row.symbol);
    const lastEvaluated = context.lastModelEvaluationAtBySymbol.get(ticker.row.symbol) ?? 0;
    return previous !== ticker.fingerprint && nowMs - lastEvaluated >= cooldownMs;
  });
  if (offeredCount === 0) {
    for (const ticker of evaluated) context.lastFingerprintBySymbol.set(ticker.row.symbol, ticker.fingerprint);
    await finishPlutoPass(passId, { candidateCount: 0, systemChecks: checks.checks, modelCalled: false, skippedReason: "nothing eligible after the deterministic filters" });
    await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason: "nothing eligible", tickers: evaluated.map((ticker) => ({ symbol: ticker.row.symbol, blocks: ticker.filtered.tickerBlocks, rejected: ticker.filtered.rejected.length })) });
    await recordPlutoPass();
    return { passId, modelCalled: false, skippedReason: "nothing eligible", outcome: null };
  }
  if (!request.force && changed.length === 0) return skip("no material change since the model last looked", checks.checks);
  if (context.lastModelCallAtMs.value !== null && nowMs - context.lastModelCallAtMs.value < settings.globalMinCallIntervalSeconds * 1000) {
    return skip(`global model-call interval (${settings.globalMinCallIntervalSeconds}s) not elapsed`, checks.checks);
  }
  // The 30 s poll is only the messenger: name the pass after what actually moved (design round 4 triggers).
  let trigger: PlutoTrigger = request.trigger;
  let triggerDetail = request.triggerDetail;
  if (request.trigger === "day_quotes" && changed.length > 0) {
    const kinds = changed.map((ticker) => ({ symbol: ticker.row.symbol, kind: classifyFingerprintChange(context.lastFingerprintBySymbol.get(ticker.row.symbol), ticker.fingerprint) }));
    const heldLeg = kinds.filter((entry) => entry.kind === "held_leg").map((entry) => entry.symbol);
    const gradeCrossing = kinds.filter((entry) => entry.kind === "grade_crossing").map((entry) => entry.symbol);
    trigger = gradeCrossing.length > 0 ? "grade_crossing" : "held_leg";
    triggerDetail = { ...request.triggerDetail, symbols: kinds.map((entry) => entry.symbol), gradeCrossing, heldLeg };
    await relabelPlutoPass(passId, trigger, triggerDetail);
  }

  // 5. Prompt.
  const book = await loadPlutoBook();
  const recentDecisions: { parsed_output: { decision?: string; candidate_id?: string | null; reasons?: string[] } | null; created_at: Date }[] = await db("pluto_decisions").whereNotNull("parsed_output").orderBy("created_at", "desc").limit(10).select("parsed_output", "created_at");
  const openPositionsBySymbol: Record<string, string[]> = {};
  for (const position of book.openPositions) (openPositionsBySymbol[position.symbol] ??= []).push(position.strategyKey);
  const tickersForPrompt: PlutoPromptTickerInput[] = evaluated.map((ticker) => ({ scored: ticker.scored, eligible: ticker.filtered.eligible, eligibleRolls: ticker.filtered.eligibleRolls, closeActions: ticker.closeOffers }));
  const windowEnd = checks.context.session.windowEndEt.split(":").map(Number);
  const minutesToWindowEnd = (windowEnd[0]! * 60 + windowEnd[1]!) - easternMinutesOfDay(now);
  const { payload, offeredIds } = buildPlutoUserPayload({
    now,
    todayEasternIso: checks.context.todayEasternIso,
    minutesToWindowEnd,
    spyDayChangePct,
    account: {
      netLiquidationValue: checks.context.netLiquidationValue ?? 0,
      freeCash: account.freeCash,
      plutoBudgetPct: settings.capitalBudgetPct,
      plutoBudgetUsedPct: checks.context.netLiquidationValue ? (book.committedDollars / checks.context.netLiquidationValue) * 100 : 0,
      openPlutoPositions: book.openPositions.length,
      maxOpenPositions: settings.maxOpenPositions,
      actionsToday: checks.context.counters.actionsToday,
      maxActionsPerSession: settings.maxActionsPerSession,
      openPositionsBySymbol,
    },
    settings,
    tickers: tickersForPrompt,
    recentDecisions: recentDecisions.map((row) => ({ at: new Date(row.created_at).toISOString(), verdict: row.parsed_output?.decision ?? "invalid", candidateId: row.parsed_output?.candidate_id ?? null, reason: row.parsed_output?.reasons?.[0] ?? null })),
    trigger: { kind: trigger, detail: triggerDetail },
  });
  const systemPrompt = buildPlutoSystemPrompt(settings);
  const promptId = await ensurePlutoPrompt(settings.promptVersion, systemPrompt);
  const userPayload = JSON.stringify(payload);

  // 6. Two calls that must agree (design item 7 / 25).
  context.lastModelCallAtMs.value = nowMs;
  for (const ticker of evaluated) {
    context.lastFingerprintBySymbol.set(ticker.row.symbol, ticker.fingerprint);
    context.lastModelEvaluationAtBySymbol.set(ticker.row.symbol, nowMs);
  }
  const calls = await Promise.all([1, 2].map((callIndex) => modelCall(callIndex)));
  const servedModelIds = calls.map((call) => call.servedModelId).filter((id): id is string => id !== null);
  const tokensIn = calls.reduce((sum, call) => sum + (call.tokensIn ?? 0), 0);
  const tokensOut = calls.reduce((sum, call) => sum + (call.tokensOut ?? 0), 0);
  const costUsd = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
  const failed = calls.find((call) => call.decision === null);
  let decision: PlutoDecision;
  let agreementDetail: string;
  if (failed) {
    decision = noTrade(`model call ${failed.callIndex} failed: ${failed.error}`);
    agreementDetail = "a call failed";
    await recordPlutoEvent("model_failed", { passId, error: failed.error });
  } else {
    const reconciled = reconcileAgreement(calls[0]!.decision!, calls[1]!.decision!);
    decision = reconciled.decision;
    agreementDetail = reconciled.detail;
  }
  await recordPlutoEvent("model_called", { passId, trigger, triggerDetail, servedModelIds, costUsd, verdict: decision.decision, candidateId: decision.candidateId, agreement: agreementDetail, reasons: decision.reasons });
  await finishPlutoPass(passId, { inputHash: candidateSetFingerprint(evaluated.flatMap((ticker) => ticker.filtered.eligible), evaluated.flatMap((ticker) => ticker.filtered.eligibleRolls)), candidateCount: offeredCount, systemChecks: checks.checks, modelCalled: true, tokensIn, tokensOut, costUsd, servedModelIds });
  await recordPlutoPass();

  // 7. Outcome.
  const topPick = deterministicTopPick(evaluated.flatMap((ticker) => ticker.filtered.eligible));
  const topPickSummary = topPick ? { id: topPick.id, edgeDollars: topPick.candidate.edgeDollars, netEdge: topPick.candidate.netEdge, grade: topPick.candidate.grade } : null;
  if (decision.decision !== "trade") {
    await recordPlutoAction({ passId, kind: "no_trade", symbol: "—", tickerId: null, contract: null, candidateScores: null, deterministicTopPick: topPickSummary, gateResults: [], sizeTier: null, quantity: null, limitPrice: null, outcome: "no_trade", blockReason: decision.reasons.join(" "), referenceBid: null, referenceMid: null });
    await recordPlutoEvent("no_trade", { passId, verdict: decision.decision, reasons: decision.reasons, systemConcerns: decision.systemConcerns, deterministicTopPick: topPickSummary });
    if (decision.decision === "abstain_system_concern" && settings.telegramVerbosity !== "off") await notifyTelegram(`🪐 Pluto abstained on a system concern: ${decision.systemConcerns.join("; ") || decision.reasons.join("; ")}`);
    return { passId, modelCalled: true, skippedReason: null, outcome: decision.decision };
  }

  const chosenId = decision.candidateId!;
  const owner = evaluated.find((ticker) => ticker.filtered.eligible.some((entry) => entry.id === chosenId) || ticker.filtered.eligibleRolls.some((entry) => entry.id === chosenId) || ticker.closeOffers.some((offer) => offer.id === chosenId));
  if (!owner) {
    await recordPlutoAction({ passId, kind: "no_trade", symbol: "—", tickerId: null, contract: null, candidateScores: null, deterministicTopPick: topPickSummary, gateResults: [{ gate: "candidate_present", ok: false, detail: `${chosenId} not found among the offers` }], sizeTier: null, quantity: null, limitPrice: null, outcome: "blocked", blockReason: "chosen candidate not found", referenceBid: null, referenceMid: null });
    return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
  }
  const chosenClose = owner.closeOffers.find((offer) => offer.id === chosenId);
  if (chosenClose) return runChosenClose(owner, chosenClose);
  const chosenOpen: PlutoOpenCandidate | undefined = owner.filtered.eligible.find((entry) => entry.id === chosenId);
  const chosenRoll: PlutoRollCandidate | undefined = owner.filtered.eligibleRolls.find((entry) => entry.id === chosenId);
  const netEdgeAtDecision = chosenOpen ? chosenOpen.candidate.netEdge : chosenRoll!.roll.netRollEdge;

  // 8. Fresh re-score of the chosen contract only, then the post-model gates.
  const burstContracts = chosenOpen
    ? [{ expiry: chosenOpen.candidate.expiry, strike: chosenOpen.candidate.strike, right: chosenOpen.candidate.strategyKey === "covered_call" ? ("C" as const) : ("P" as const) }]
    : [{ expiry: chosenRoll!.roll.replacement.expiry, strike: chosenRoll!.roll.replacement.strike, right: chosenRoll!.roll.replacement.strategyKey === "covered_call" ? ("C" as const) : ("P" as const) }];
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
  const exposures = await computePositionExposures();
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
      openPositionCount: book.openPositions.length,
      existingTickerExposure: exposures.filter((row) => row.symbol === owner.row.symbol).reduce((sum, row) => sum + row.exposure, 0),
      existingSectorExposure: sector === null ? 0 : exposures.filter((row) => row.sector === sector).reduce((sum, row) => sum + row.exposure, 0),
      freeShares: fresh.scored.freeShares,
      spotPrice: fresh.scored.spotPrice,
      workingOrderOnSymbol: book.workingOrderSymbols.has(owner.row.symbol),
      lastFilledActionAt: book.lastFilledActionAtBySymbol.get(owner.row.symbol) ?? null,
      nowMs: Date.now(),
    },
  });
  const contract = freshCandidate ?? freshRoll?.replacement ?? null;
  const gateResults: PlutoGateResult[] = gates.gates;
  const actionId = await recordPlutoAction({
    passId,
    kind: chosenOpen ? chosenOpen.kind : "roll",
    symbol: owner.row.symbol,
    tickerId: owner.row.tickerId,
    contract: contract ? { strategyKey: contract.strategyKey, expiry: contract.expiry, strike: contract.strike, legId: chosenRoll?.roll.legId } : null,
    candidateScores: freshCandidate ?? freshRoll ?? null,
    deterministicTopPick: topPickSummary,
    gateResults,
    sizeTier: decision.sizeTier,
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
  const scoresSnapshot = { version: `pluto-${plutoPromptVersion}`, candidateId: chosenId, contract: freshCandidate ?? freshRoll, ticker: { spotPrice: fresh.scored.spotPrice, snapshotDateIso: fresh.scored.snapshotDateIso, atmImpliedVolatility: fresh.scored.atmImpliedVolatility, forecast: fresh.scored.forecast, dayChangePercent: fresh.scored.dayChangePercent }, decision, plan: gates.plan, deterministicTopPick: topPickSummary };
  const result = await executePlutoOrder(
    context.api,
    settings,
    chosenOpen
      ? { kind: "open", actionId, symbol: owner.row.symbol, candidate: freshCandidate!, plan: gates.plan!, decision, scoresSnapshot }
      : { kind: "roll", actionId, symbol: owner.row.symbol, roll: freshRoll!, heldLeg: fresh.scored.heldLegs.find((leg) => leg.legId === chosenRoll!.roll.legId)!, plan: gates.plan!, decision, scoresSnapshot },
  );
  if (result.outcome === "confirmed" && result.orderId) {
    context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: owner.row.symbol, reference: { price: contract!.bid, side: "sell", multiplier: 100, otherLegs: result.otherReferenceLegs }, description: result.detail, cancelByMs: checks.context.session.cancelByMs }), result.orderId);
  }
  return { passId, modelCalled: true, skippedReason: null, outcome: result.outcome };

  async function runChosenClose(ticker: EvaluatedTicker, offer: CloseOffer): Promise<PassSummary> {
    // Re-derive the offer fresh: the cycle P&L, the quote and the leg's edge can all have moved.
    const watched = context.marketWatch.snapshot(ticker.row.symbol);
    const freshScored = (await evaluateTicker(ticker.row, settings, context, account, tradingSettings, true, Date.now())).scored;
    const rebuilt = await buildCloseOffersForTicker({ symbol: ticker.row.symbol, heldLegs: freshScored.heldLegs, rolls: freshScored.rolls, settings, stockBid: watched?.bid ?? null, stockAsk: watched?.ask ?? null, previousSessionDateIso });
    const freshOffer = rebuilt.offers.find((entry) => entry.id === offer.id) ?? null;
    const gateResults: PlutoGateResult[] = [
      { gate: "verdict", ok: true, detail: "trade" },
      { gate: "confidence_floor", ok: decision.confidence >= settings.confidenceFloor, detail: `${decision.confidence.toFixed(2)} vs floor ${settings.confidenceFloor}` },
      { gate: "offer_fresh", ok: freshOffer !== null, detail: freshOffer ? "still offered on fresh data" : rebuilt.skipped.find((entry) => entry.id === offer.id)?.reason ?? "no longer offered" },
      { gate: "working_order", ok: !book.workingOrderSymbols.has(ticker.row.symbol), detail: book.workingOrderSymbols.has(ticker.row.symbol) ? "a Pluto order on this symbol is already working" : "no working Pluto order on the symbol" },
    ];
    const ok = gateResults.every((gate) => gate.ok);
    const actionId = await recordPlutoAction({ passId, kind: offer.kind, symbol: offer.symbol, tickerId: ticker.row.tickerId, contract: { positionId: offer.positionId, legIds: offer.legIds }, candidateScores: (freshOffer ?? offer).detail, deterministicTopPick: topPickSummary, gateResults, sizeTier: null, quantity: (freshOffer ?? offer).quantity, limitPrice: (freshOffer ?? offer).limitPrice, outcome: ok ? "validated" : "blocked", blockReason: ok ? null : gateResults.filter((gate) => !gate.ok).map((gate) => `${gate.gate}: ${gate.detail}`).join(" | "), referenceBid: (freshOffer ?? offer).limitPrice, referenceMid: (freshOffer ?? offer).limitPrice });
    if (!ok) {
      await recordPlutoEvent("action_blocked", { passId, actionId, symbol: offer.symbol, candidateId: offer.id, stage: "post_model", failed: gateResults.filter((gate) => !gate.ok) });
      return { passId, modelCalled: true, skippedReason: null, outcome: "blocked" };
    }
    await recordPlutoEvent("action_validated", { passId, actionId, symbol: offer.symbol, candidateId: offer.id, quantity: freshOffer!.quantity, limitPrice: freshOffer!.limitPrice, reasons: decision.reasons });
    const result = await executePlutoClose(context.api, settings, { actionId, symbol: offer.symbol, positionId: freshOffer!.positionId, legs: freshOffer!.legIds.map((legId) => ({ legId, limitPrice: freshOffer!.limitPrice })), description: freshOffer!.description, reasons: decision.reasons });
    if (result.outcome === "confirmed" && result.orderId) context.trackWatch(watchPlutoOrder(context.api, settings, { actionId, orderId: result.orderId, symbol: offer.symbol, reference: { price: freshOffer!.limitPrice, side: freshOffer!.side, multiplier: freshOffer!.multiplier }, description: freshOffer!.description, cancelByMs: checks.context.session.cancelByMs }), result.orderId);
    return { passId, modelCalled: true, skippedReason: null, outcome: result.outcome };
  }

  async function modelCall(callIndex: number) {
    const call = await callPlutoModel({ apiKey: context.openRouterApiKey, modelId: settings.modelId, reasoningEffort: settings.reasoningEffort, timeoutSeconds: settings.callTimeoutSeconds, systemPrompt, userPayload, seed: callIndex });
    const parsed = call.ok && call.rawText ? parsePlutoDecision(call.rawText, offeredIds) : null;
    const decisionOrNull = parsed && parsed.ok ? parsed.decision : null;
    const error = call.error ?? (parsed && !parsed.ok ? `invalid decision: ${parsed.error}` : null);
    await recordPlutoDecision({ passId, callIndex, modelId: settings.modelId, servedModelId: call.servedModelId, promptId, inputPayload: callIndex === 1 ? payload : { sameAsCall: 1 }, rawOutput: call.rawText, parsedOutput: decisionOrNull ? { decision: decisionOrNull.decision, action_kind: decisionOrNull.actionKind, candidate_id: decisionOrNull.candidateId, size_tier: decisionOrNull.sizeTier, confidence: decisionOrNull.confidence, reasons: decisionOrNull.reasons, risks_acknowledged: decisionOrNull.risksAcknowledged, system_concerns: decisionOrNull.systemConcerns } : null, schemaValid: decisionOrNull !== null, latencyMs: call.latencyMs, tokensIn: call.tokensIn, tokensOut: call.tokensOut, costUsd: call.costUsd, error });
    return { callIndex, decision: decisionOrNull, error, servedModelId: call.servedModelId, tokensIn: call.tokensIn, tokensOut: call.tokensOut, costUsd: call.costUsd };
  }
}

function easternMinutesOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}
