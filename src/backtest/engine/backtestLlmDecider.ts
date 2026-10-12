import type { Knex } from "knex";
import { easternMinutesOfDay } from "../../lib/easternIsoDate.js";
import type { SignalCandidate } from "../../lib/signalCandidates.js";
import type { TickerSignals } from "../../lib/signalsTypes.js";
import { openCandidateId, type PlutoOpenCandidate, type PlutoRollCandidate, type PlutoTickerFilterResult } from "../../pluto/candidateFilters.js";
import type { CloseOffer } from "../../pluto/closeActions.js";
import type { PlutoDecision } from "../../pluto/decisionSchema.js";
import type { HeldPositionEntry } from "../../pluto/heldPositionMetrics.js";
import { classifyFingerprintChange, tickerFingerprint } from "../../pluto/inputHash.js";
import type { PlutoTrigger } from "../../pluto/ledger.js";
import type { MoveContext } from "../../pluto/moveContext.js";
import { buildPlutoSystemPrompt, buildPlutoUserPayload, recentDecisionsForPrompt, type PlutoPromptAccountInput } from "../../pluto/prompt.js";
import type { PlutoSettings } from "../../pluto/settingsStore.js";
import { askPlutoThroughSubscription, type ClaudeCall, type SessionLlmCallOutcome } from "../llm/askPlutoThroughSubscription.js";
import type { PlutoPromptMasking } from "../llm/plutoPromptMasking.js";

// The backtest's LLM mode (docs/backtesting/FULL-FIDELITY-DESIGN.md §5, "Optional: the real LLM"): Pluto's decision asked
// of Claude, the rest of the pass Pluto's own code, as live. What this module replicates of the live agent and pass
// runner (src/pluto/agent.ts, passRunner.ts):
//   - rounds: the day's first look is the opening analysis; a fill queues an "order_ended" round over every ticker (one
//     pending every-ticker round covers any later one); a ticker whose cooldown after a fill ends queues a
//     "cooldown_ended" round over that ticker; forced rounds go first, then the look's own round over the tickers it
//     re-quoted (live's Day Signals update). A forced round always asks; any other only when a ticker's fingerprint
//     changed and the ticker is not inside the model cooldown (perTickerModelCooldownMinutes)
//   - the fingerprint per ticker (inputHash.ts tickerFingerprint) of its eligible opens plus the opens out only on
//     quote age (a burst would re-quote them), its eligible rolls and its close offers (with an event close's review
//     step); nothing on offer → no call, and the fingerprints are remembered; before a call every ticker's fingerprint
//     and model-evaluation time are remembered
//   - the payload (buildPlutoUserPayload) and the system prompt (buildPlutoSystemPrompt) exactly as live builds them;
//     one call per decision, no retry; the session's own last ten decisions as recent_decisions
// What the backtest cannot replicate: the quote burst before a call (the look's quotes are its freshest data, so an
// open out only on quote age stays out) and an order resting while the round goes on (fills are immediate).

/** The quote-age reasons filterTickerForPluto gives (passRunner.ts isQuoteAgeReason). */
const isQuoteAgeReason = (reason: string) => reason.startsWith("quote ") || reason === "quote age unknown";

/** Opens out only because their quote is too old: live counts them before the burst would re-quote them (passRunner.ts candidatesEligibleOnceRequoted). */
export function candidatesEligibleOnceRequoted(scored: TickerSignals, filtered: PlutoTickerFilterResult): PlutoOpenCandidate[] {
  if (filtered.tickerBlocks.length > 0) return [];
  const eligibleIds = new Set(filtered.eligible.map((entry) => entry.id));
  const outOnlyOnQuoteAge = (candidate: SignalCandidate) => {
    const rejection = filtered.rejected.find((entry) => entry.id === openCandidateId(scored.symbol, candidate));
    return rejection ? rejection.reasons.every(isQuoteAgeReason) : true;
  };
  return scored.candidates
    .filter((candidate) => !eligibleIds.has(openCandidateId(scored.symbol, candidate)) && outOnlyOnQuoteAge(candidate))
    .map((candidate) => ({ id: openCandidateId(scored.symbol, candidate), kind: candidate.strategyKey === "covered_call" ? "open_covered_call" : "open_cash_secured_put", symbol: scored.symbol, candidate }));
}

/** The change-check key of a close offer: an event close also moves with its review step (passRunner.ts closeOfferFingerprintKey). */
function closeOfferFingerprintKey(offer: CloseOffer): string {
  return offer.reviewKey ? `${offer.id}@${offer.reviewKey}` : offer.id;
}

/** IV rank as Price Performance and the prompt read it (ivMetrics.ts): (latest − min) ÷ (max − min) × 100 over the last 252 days with an implied volatility; null below 2 days or a flat range. */
export function ivRankFromHistory(impliedVolatilitiesOldestFirst: readonly number[]): number | null {
  const window = impliedVolatilitiesOldestFirst.slice(-252);
  if (window.length < 2) return null;
  const latest = window.at(-1)!;
  const minimum = Math.min(...window);
  const maximum = Math.max(...window);
  return maximum > minimum ? ((latest - minimum) / (maximum - minimum)) * 100 : null;
}

/** The subscription, not the model, stopped a call (the plan's limit, a CLI that cannot run, a failure past its retries). */
export class BacktestLlmUsageLimitError extends Error {
  constructor(reason: string, detail: string | null) {
    super(`${reason}: resume the session later; answered calls are cached.${detail ? ` (${detail})` : ""}`);
    this.name = "BacktestLlmUsageLimitError";
  }
}

/** A decision the session asked for, for recent_decisions, and the fate of the trade it named. */
interface SessionDecisionRecord {
  sequence: number;
  at: Date;
  parsedOutput: { decision: string; candidate_id: string | null; reasons: string[] };
  tradeOutcome: { outcome: string; blockReason: string | null } | null;
}

/** What an LLM-mode session keeps across its looks and days. */
export class BacktestLlmSession {
  readonly lastFingerprintBySymbol = new Map<string, string>();
  readonly lastModelEvaluationAtBySymbol = new Map<string, number>();
  private readonly decisions: SessionDecisionRecord[] = [];
  private callSequence = 0;

  constructor(
    readonly options: {
      sessionId: string;
      connection: Knex;
      cliPath: string;
      workingDirectory: string;
      masking: PlutoPromptMasking;
      /** The Claude call; the CLI when absent. Tests pass a fake. */
      callModel?: ClaudeCall;
    },
  ) {}

  nextCallSequence(): number {
    this.callSequence += 1;
    return this.callSequence;
  }

  rememberDecision(sequence: number, at: Date, decision: PlutoDecision): void {
    this.decisions.push({ sequence, at, parsedOutput: { decision: decision.decision, candidate_id: decision.candidateId, reasons: decision.reasons }, tradeOutcome: null });
    if (this.decisions.length > 10) this.decisions.shift();
  }

  /** The action a trade decision produced: filled, or blocked with why. A trade that produced none reads "not_executed". */
  recordTradeOutcome(sequence: number, outcome: "filled" | "blocked", blockReason: string | null): void {
    const record = this.decisions.find((entry) => entry.sequence === sequence);
    if (record) record.tradeOutcome = { outcome, blockReason };
  }

  /** The last ten decisions, newest first, as passRunner builds them (recentDecisionsForPrompt). */
  recentDecisions() {
    const newestFirst = [...this.decisions].reverse();
    return recentDecisionsForPrompt(
      newestFirst.map((entry) => ({ passId: String(entry.sequence), createdAt: entry.at, parsedOutput: entry.parsedOutput })),
      new Map(newestFirst.flatMap((entry) => (entry.tradeOutcome ? [[String(entry.sequence), entry.tradeOutcome] as const] : []))),
    );
  }
}

/** One round of the live agent: what triggered it, the tickers it looks at (null = every ticker of the look), and whether it asks whatever changed. */
export interface BacktestLlmRound {
  trigger: PlutoTrigger;
  detail: Record<string, unknown>;
  symbols: readonly string[] | null;
  force: boolean;
}

/** A ticker of the round as the look scored it. */
export interface BacktestLlmTicker {
  symbol: string;
  scored: TickerSignals;
  filtered: PlutoTickerFilterResult;
  /** The close offers left to a choice (an automatic one is sent by code). */
  closeOffers: readonly CloseOffer[];
  heldPositions: readonly HeldPositionEntry[];
  /** True when no open may be sent on it at this look (market stress): live then counts no re-quotable opens. */
  opensBarred: boolean;
  moveContext(): MoveContext | null;
}

export interface BacktestLlmPassInput {
  session: BacktestLlmSession;
  round: BacktestLlmRound;
  settings: PlutoSettings;
  spreadCostSharePct: number;
  nowMs: number;
  todayIso: string;
  lookTimeEt: string;
  /** The day's window end ("HH:MM" ET, pulled in before an early close). */
  windowEndEt: string;
  spyDayChangePct: number | null;
  tickers: readonly BacktestLlmTicker[];
  account: PlutoPromptAccountInput;
  plutoOpenedPositionIds: ReadonlySet<string>;
  /** Open days from today reaching a week past the last expiry the tickers carry. */
  openDaysIso: string[];
}

export type BacktestLlmPassResult =
  | { asked: false; reason: string }
  | { asked: true; sequence: number; outcome: SessionLlmCallOutcome; decision: PlutoDecision | null; cacheHit: boolean; error: string | null; trigger: PlutoTrigger };

/**
 * One pass's decision in LLM mode, as runPlutoPass makes it: the change check, the payload, one call. Throws
 * BacktestLlmUsageLimitError when the plan's usage limit stops the call.
 */
export async function decideWithLlm(input: BacktestLlmPassInput): Promise<BacktestLlmPassResult> {
  const { session, round, settings } = input;
  const tickers = round.symbols === null ? input.tickers : input.tickers.filter((ticker) => round.symbols!.includes(ticker.symbol));
  if (tickers.length === 0) return { asked: false, reason: "no ticker of the round is scored at this look" };
  const cooldownMs = settings.perTickerModelCooldownMinutes * 60_000;
  const coolingDown = (symbol: string) => input.nowMs - (session.lastModelEvaluationAtBySymbol.get(symbol) ?? Number.NEGATIVE_INFINITY) < cooldownMs;
  if (!round.force && tickers.every((ticker) => coolingDown(ticker.symbol)) && tickers.every((ticker) => ticker.heldPositions.length === 0)) return { asked: false, reason: "every ticker in this round is cooling down" };

  // What the round looked at, before any live quote: what the next round compares against.
  const lookedAtFingerprintBySymbol = new Map<string, string>();
  let offeredBeforeBurst = 0;
  for (const ticker of tickers) {
    const requotable = ticker.opensBarred ? [] : candidatesEligibleOnceRequoted(ticker.scored, ticker.filtered);
    lookedAtFingerprintBySymbol.set(ticker.symbol, tickerFingerprint([...ticker.filtered.eligible, ...requotable], ticker.filtered.eligibleRolls, ticker.closeOffers.map(closeOfferFingerprintKey)));
    offeredBeforeBurst += ticker.filtered.eligible.length + requotable.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length;
  }
  const rememberWhatWasLookedAt = () => {
    for (const [symbol, fingerprint] of lookedAtFingerprintBySymbol) session.lastFingerprintBySymbol.set(symbol, fingerprint);
  };
  const changed = tickers.filter((ticker) => session.lastFingerprintBySymbol.get(ticker.symbol) !== lookedAtFingerprintBySymbol.get(ticker.symbol) && !coolingDown(ticker.symbol));
  if (offeredBeforeBurst === 0) {
    rememberWhatWasLookedAt();
    return { asked: false, reason: "nothing eligible after the deterministic filters" };
  }
  if (!round.force && changed.length === 0) return { asked: false, reason: "no material change since the model last looked" };
  // Live re-quotes the promising contracts here; the look's quotes are already its freshest, so only the eligible count.
  const offered = tickers.reduce((sum, ticker) => sum + ticker.filtered.eligible.length + ticker.filtered.eligibleRolls.length + ticker.closeOffers.length, 0);
  if (offered === 0) {
    rememberWhatWasLookedAt();
    return { asked: false, reason: "nothing eligible once re-quoted live" };
  }
  // A Day Signals update is only the messenger: the round is named after what actually changed.
  let trigger = round.trigger;
  let triggerDetail = round.detail;
  if (round.trigger === "day_signals_update" && changed.length > 0) {
    const kinds = changed.map((ticker) => ({ symbol: ticker.symbol, kind: classifyFingerprintChange(session.lastFingerprintBySymbol.get(ticker.symbol), lookedAtFingerprintBySymbol.get(ticker.symbol)!) }));
    const gradeCrossing = kinds.filter((entry) => entry.kind === "grade_crossing").map((entry) => entry.symbol);
    trigger = gradeCrossing.length > 0 ? "grade_crossing" : "held_leg";
    triggerDetail = { ...round.detail, symbols: kinds.map((entry) => entry.symbol), gradeCrossing, heldLeg: kinds.filter((entry) => entry.kind === "held_leg").map((entry) => entry.symbol) };
  }

  const now = new Date(input.nowMs);
  const [windowEndHour, windowEndMinute] = input.windowEndEt.split(":").map(Number) as [number, number];
  const { payload, offeredIds } = buildPlutoUserPayload({
    now,
    spreadCostSharePct: input.spreadCostSharePct,
    todayEasternIso: input.todayIso,
    minutesToWindowEnd: windowEndHour * 60 + windowEndMinute - easternMinutesOfDay(now),
    spyDayChangePct: input.spyDayChangePct,
    account: input.account,
    settings,
    tickers: tickers.map((ticker) => ({ scored: ticker.scored, eligible: ticker.filtered.eligible, eligibleRolls: ticker.filtered.eligibleRolls, closeActions: [...ticker.closeOffers], heldPositions: [...ticker.heldPositions], moveContext: ticker.moveContext() })),
    recentDecisions: session.recentDecisions(),
    trigger: { kind: trigger, detail: triggerDetail },
    plutoOpenedPositionIds: input.plutoOpenedPositionIds,
    openDaysIso: input.openDaysIso,
  });
  for (const ticker of tickers) session.lastModelEvaluationAtBySymbol.set(ticker.symbol, input.nowMs);
  rememberWhatWasLookedAt();

  const sequence = session.nextCallSequence();
  const answer = await askPlutoThroughSubscription(
    {
      connection: session.options.connection,
      cliPath: session.options.cliPath,
      workingDirectory: session.options.workingDirectory,
      timeoutSeconds: settings.callTimeoutSeconds,
      systemPrompt: buildPlutoSystemPrompt(settings),
      payload,
      masking: session.options.masking,
      offeredIds,
      sessionId: session.options.sessionId,
      sequence,
      tradingDate: input.todayIso,
      lookTime: input.lookTimeEt,
    },
    session.options.callModel,
  );
  if (answer.stopSessionBecause) throw new BacktestLlmUsageLimitError(answer.stopSessionBecause, answer.error);
  if (answer.decision) session.rememberDecision(sequence, now, answer.decision);
  return { asked: true, sequence, outcome: answer.outcome, decision: answer.decision, cacheHit: answer.cacheHit, error: answer.error, trigger };
}

/** The roll or open a decision names among the round's offers; null when none does. */
export function findOfferedChoice(candidateId: string, tickers: readonly BacktestLlmTicker[]): { kind: "close"; offer: CloseOffer } | { kind: "roll"; roll: PlutoRollCandidate } | { kind: "open"; open: PlutoOpenCandidate } | null {
  for (const ticker of tickers) {
    const offer = ticker.closeOffers.find((entry) => entry.id === candidateId);
    if (offer) return { kind: "close", offer };
    const roll = ticker.filtered.eligibleRolls.find((entry) => entry.id === candidateId);
    if (roll) return { kind: "roll", roll };
    const open = ticker.filtered.eligible.find((entry) => entry.id === candidateId);
    if (open) return { kind: "open", open };
  }
  return null;
}
