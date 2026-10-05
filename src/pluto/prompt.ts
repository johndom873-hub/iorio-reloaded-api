import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import type { PlutoOpenCandidate, PlutoRollCandidate } from "./candidateFilters.js";
import type { PlutoSettings } from "./settingsStore.js";

// The prompt contract (design round 3, item 23, approved 2026-09-28). A stable system prompt
// (role, objective, hard rules, output schema) and one compact JSON user message per call.
// The payload is deliberately small and rounded: only candidates that already passed every
// deterministic filter, the top few per ticker per strategy, short field names, no nulls.
// Shortlist notes never enter the prompt (Marcelo, 2026-09-28).

export const plutoPromptVersion = "v2";

/** How many open candidates per ticker per strategy the model sees (best Edge $ first). */
export const candidatesPerTickerPerStrategy = 3;

export function buildPlutoSystemPrompt(settings: PlutoSettings): string {
  return [
    "You are Pluto, the autonomous trading agent of Iorio, an options-selling platform running the wheel strategy (cash-secured puts and covered calls) on US single-name equities.",
    "",
    "Your job: given the candidates Iorio has already scored and pre-filtered, decide whether ONE of them is worth executing right now, or whether to do nothing. Iorio produced every number you see; you are the last-mile judgement a careful human trader would apply.",
    "",
    "Objective: maximise long-run risk-adjusted return. Doing nothing is the default and costs nothing; a trade must justify itself. Prefer no_trade whenever the evidence is mixed, the market looks stressed, or the model inputs look inconsistent with each other.",
    "",
    "What the numbers mean:",
    "- edge_vp: fitted implied volatility minus the realized-volatility forecast, in volatility points. net_edge_vp subtracts friction: the share of the half-spread given in parameters.spread_cost_share_pct, plus the estimated commission. edge_dollars is net edge in dollars per contract. These are the headline mispricing signals; they are expected values with no variance term.",
    "- grade: strong (net edge >= 10 vp), good (5-10), weak (0-5). Only good or better reaches you.",
    "- ann_yield_pct: annualised premium yield on capital at risk; it scales with 1/sqrt(time) so very short-dated contracts look richest. Short-dated premium is real on average but tail-heavy.",
    "- surface_iv vs mid_iv: how far the contract's own market price sits from the fitted surface. A big gap means the surface may be wrong for that contract.",
    "- flags: macro_event_before_expiry means a major US macro release (CPI, FOMC, jobs, PCE, GDP, PPI) falls before expiry; the IV may be pricing that event rather than mispricing.",
    "- elevated_vol: the ticker's short-term realized volatility is unusually high versus its own history.",
    "- day_change_pct and spy_day_change_pct: today's moves. A sharp drop usually has a cause; selling puts into a falling market is exactly the tail risk this strategy carries.",
    "- rolls: replacing a held short leg with a lower-delta credit roll; net_roll_edge_vp is the new contract's net edge minus what holding the current leg still offers minus the cost of closing it.",
    "- close actions: selling unstructured shares at a positive cycle P&L, or buying back a short leg whose remaining edge is negative while locking a profit.",
    "",
    "Hard rules you must obey:",
    "1. You may only name a candidate_id that appears in this message. Never invent contracts, strikes, expiries, quantities or prices. You never size the trade: choose size_tier full or half and code computes the quantity.",
    "2. Trade at most one action per decision.",
    "3. If anything about the data looks internally inconsistent (surface far from market, stale quotes, contradictory flags, account context that makes no sense), answer abstain_system_concern and say why in system_concerns.",
    `4. Confidence below ${settings.confidenceFloor} is treated as no_trade by code, so do not pad it.`,
    "5. Reasons are for the human operators: short, specific, in plain language, at most five.",
    "",
    "Judgement guidance, not a formula: prefer larger net edge in dollars when the liquidity is real (open interest, volume, tight spread), the surface agrees with the market for that contract, the ticker is not moving violently today, no macro release sits before expiry, and the position adds diversification to the book rather than concentration. Weigh the tail: two-day contracts with the highest annualised yield are the ones that hurt most when the underlying gaps. A roll with a good grade on a leg near expiry or drifting toward assignment is usually worth more than a new position. Never chase yield.",
    "",
    "Answer with a single JSON object matching the provided schema and nothing else.",
  ].join("\n");
}

function round(value: number | null | undefined, digits: number): number | undefined {
  if (value === null || value === undefined || Number.isNaN(value)) return undefined;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compactCandidate(id: string, kind: string, candidate: SignalCandidate, snapshotCapturedAt: string | null, nowMs: number) {
  const quotedAt = candidate.quotedAt ?? (candidate.quoteSource === "snapshot" ? snapshotCapturedAt : null);
  return stripUndefined({
    id,
    kind,
    expiry: candidate.expiry,
    dte: candidate.dte,
    strike: candidate.strike,
    delta: round(candidate.delta, 3),
    bid: candidate.bid,
    ask: candidate.ask,
    spread_pct: round(candidate.spreadPercent, 1),
    surface_iv: round(candidate.surfaceImpliedVolatility * 100, 1),
    mid_iv: round((candidate.midImpliedVolatility ?? NaN) * 100, 1),
    edge_vp: round(candidate.edge * 100, 1),
    net_edge_vp: round(candidate.netEdge * 100, 1),
    edge_dollars: round(candidate.edgeDollars, 0),
    ann_yield_pct: round(candidate.annualizedYield * 100, 0),
    dollar_risk: round(candidate.dollarRisk, 0),
    risk_adj_ratio: round(candidate.riskAdjustedRatio, 4),
    oi: candidate.openInterest ?? undefined,
    vol: candidate.volume ?? undefined,
    grade: candidate.grade,
    quote_source: candidate.quoteSource,
    quote_age_min: quotedAt ? round((nowMs - new Date(quotedAt).getTime()) / 60_000, 0) : undefined,
    flags: candidate.flags.length > 0 ? candidate.flags : undefined,
  });
}

function stripUndefined<T extends Record<string, unknown>>(object: T): T {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
  return object;
}

export interface PlutoCloseActionOffer {
  id: string;
  kind: "close_shares" | "close_leg";
  symbol: string;
  description: string;
  cycle_pnl: number;
  detail: Record<string, unknown>;
}

export interface PlutoPromptTickerInput {
  scored: TickerSignals;
  eligible: PlutoOpenCandidate[];
  eligibleRolls: PlutoRollCandidate[];
  closeActions: PlutoCloseActionOffer[];
}

export interface PlutoPromptAccountInput {
  netLiquidationValue: number;
  freeCash: number;
  plutoBudgetPct: number;
  plutoBudgetUsedPct: number;
  openPlutoPositions: number;
  maxOpenPositions: number;
  actionsToday: number;
  maxActionsPerSession: number;
  openPositionsBySymbol: Record<string, string[]>;
}

export interface PlutoPromptInput {
  now: Date;
  todayEasternIso: string;
  minutesToWindowEnd: number;
  spyDayChangePct: number | null;
  account: PlutoPromptAccountInput;
  settings: PlutoSettings;
  tickers: PlutoPromptTickerInput[];
  /** Share of the half-spread that scoring charges as friction (trading_settings.spread_cost_charged_pct). */
  spreadCostSharePct: number;
  recentDecisions: { at: string; verdict: string; candidateId: string | null; reason: string | null }[];
  trigger: { kind: string; detail: Record<string, unknown> };
}

export interface PlutoPromptPayload {
  payload: Record<string, unknown>;
  offeredIds: Set<string>;
}

/** The per-call user message. Returns the ids it offered so the parser can refuse anything else. */
export function buildPlutoUserPayload(input: PlutoPromptInput): PlutoPromptPayload {
  const offeredIds = new Set<string>();
  const nowMs = input.now.getTime();
  const tickers = input.tickers
    .map((ticker) => {
      const byStrategy = new Map<string, PlutoOpenCandidate[]>();
      for (const entry of [...ticker.eligible].sort((a, b) => b.candidate.edgeDollars - a.candidate.edgeDollars)) {
        const list = byStrategy.get(entry.kind) ?? [];
        if (list.length < candidatesPerTickerPerStrategy) list.push(entry);
        byStrategy.set(entry.kind, list);
      }
      const candidates = [...byStrategy.values()].flat().map((entry) => {
        offeredIds.add(entry.id);
        return compactCandidate(entry.id, entry.kind, entry.candidate, ticker.scored.snapshotCapturedAt, nowMs);
      });
      const rolls = ticker.eligibleRolls.map((entry) => {
        offeredIds.add(entry.id);
        const roll = entry.roll;
        return stripUndefined({
          id: entry.id,
          kind: "roll",
          held_leg_id: roll.legId,
          quantity: roll.quantity,
          net_roll_edge_vp: round(roll.netRollEdge * 100, 1),
          net_roll_edge_dollars: round(roll.netRollEdgeDollars, 0),
          net_credit_per_share: round(roll.netCreditPerShare, 2),
          delta_change: round(roll.deltaChange, 3),
          grade: roll.grade,
          flags: roll.flags.length > 0 ? roll.flags : undefined,
          replacement: compactCandidate(`${entry.id}#replacement`, roll.replacement.strategyKey, roll.replacement, ticker.scored.snapshotCapturedAt, nowMs),
        });
      });
      const closes = ticker.closeActions.map((action) => {
        offeredIds.add(action.id);
        return { id: action.id, kind: action.kind, description: action.description, cycle_pnl: round(action.cycle_pnl, 0), ...action.detail };
      });
      if (candidates.length === 0 && rolls.length === 0 && closes.length === 0) return null;
      const scored = ticker.scored;
      const tickerEntry: Record<string, unknown> = stripUndefined({
        symbol: scored.symbol,
        sector: scored.sector ?? undefined,
        spot: round(scored.spotPrice, 2),
        day_change_pct: round(scored.dayChangePercent, 2),
        atm_iv: round((scored.atmImpliedVolatility ?? NaN) * 100, 1),
        forecast_rv: round((scored.forecast?.volatility ?? NaN) * 100, 1),
        momentum_12_1: round(scored.momentum, 3),
        skew_vp: round(scored.skew ? scored.skew.skew * 100 : NaN, 1),
        elevated_vol: scored.elevatedVolatility?.elevated ? true : undefined,
        next_earnings: scored.nextEarningsDateIso ?? undefined,
        macro_events: scored.macroEvents.length > 0 ? scored.macroEvents.map((event) => ({ date: event.dateIso, title: event.title })) : undefined,
        open_positions: input.account.openPositionsBySymbol[scored.symbol] ?? undefined,
        candidates: candidates.length > 0 ? candidates : undefined,
        rolls: rolls.length > 0 ? rolls : undefined,
        close_actions: closes.length > 0 ? closes : undefined,
      });
      return tickerEntry;
    })
    .filter((ticker): ticker is Record<string, unknown> => ticker !== null);

  const payload = stripUndefined({
    as_of: input.now.toISOString(),
    session: { date: input.todayEasternIso, minutes_to_window_end: Math.max(0, Math.round(input.minutesToWindowEnd)) },
    trigger: input.trigger,
    market: stripUndefined({ spy_day_change_pct: round(input.spyDayChangePct, 2) }),
    account: {
      nlv: round(input.account.netLiquidationValue, 0),
      free_cash: round(input.account.freeCash, 0),
      pluto_budget_pct: input.account.plutoBudgetPct,
      pluto_budget_used_pct: round(input.account.plutoBudgetUsedPct, 1),
      open_pluto_positions: input.account.openPlutoPositions,
      max_open_positions: input.account.maxOpenPositions,
      actions_today: input.account.actionsToday,
      max_actions_per_session: input.account.maxActionsPerSession,
    },
    parameters: {
      min_grade: input.settings.minGrade,
      max_abs_delta: input.settings.maxAbsDelta,
      dte_range: [input.settings.minDte, input.settings.maxDte],
      max_ticker_exposure_pct: input.settings.maxTickerExposurePct,
      max_order_notional_pct: input.settings.maxOrderNotionalPct,
      confidence_floor: input.settings.confidenceFloor,
      spread_cost_share_pct: input.spreadCostSharePct,
    },
    tickers,
    recent_decisions: input.recentDecisions.length > 0 ? input.recentDecisions.map((entry) => stripUndefined({ at: entry.at, verdict: entry.verdict, candidate_id: entry.candidateId ?? undefined, reason: entry.reason ?? undefined })) : undefined,
  });
  return { payload, offeredIds };
}
