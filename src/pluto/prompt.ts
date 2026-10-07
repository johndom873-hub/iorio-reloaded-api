import type { SignalCandidate } from "../lib/signalCandidates.js";
import type { TickerSignals } from "../lib/signalsTypes.js";
import type { PlutoOpenCandidate, PlutoRollCandidate } from "./candidateFilters.js";
import type { PlutoSettings } from "./settingsStore.js";
import type { MoveContext } from "./moveContext.js";

// The prompt contract (design round 3, item 23, approved 2026-09-28). A stable system prompt
// (role, objective, hard rules, output schema) and one compact JSON user message per call.
// The payload is deliberately small and rounded: only candidates that already passed every
// deterministic filter, the top few per ticker per strategy, short field names, no nulls.
// Shortlist notes never enter the prompt (Marcelo, 2026-09-28).

export const plutoPromptVersion = "v3.5";

/** How many open candidates per ticker per strategy the model sees (best Edge $ first). */
export const candidatesPerTickerPerStrategy = 3;

export function buildPlutoSystemPrompt(settings: PlutoSettings): string {
  return [
    "You are Pluto, the autonomous trading agent of Iorio, an options-selling platform running the wheel strategy (cash-secured puts and covered calls) on US single-name equities.",
    "",
    "Your job: given the candidates Iorio has already analysed and pre-filtered, decide whether ONE of them is worth executing right now, or whether to do nothing. Iorio produced every number you see; you are the last-mile judgement a careful human trader would apply.",
    "",
    "Objective: maximise long-run risk-adjusted return. Doing nothing is the default and costs nothing; a trade must justify itself. Prefer no_trade whenever the evidence is mixed, the market looks stressed, or the model inputs look inconsistent with each other.",
    "",
    "What the numbers mean:",
    "- edge_vp: fitted implied volatility minus the realized-volatility forecast, in volatility points. net_edge_vp subtracts friction: the share of the half-spread given in parameters.spread_cost_share_pct, plus the estimated commission. edge_dollars is net edge in dollars per contract. These are the headline mispricing signals; they are expected values with no variance term.",
    `- grade: strong (net edge >= 10 vp), good (5-10), weak (0-5). ${settings.minGrade === "strong" ? "Only strong reaches you." : `Only ${settings.minGrade} or better reaches you.`}`,
    "- ann_yield_pct: annualised premium yield on capital at risk; it scales with 1/sqrt(time) so very short-dated contracts look richest. Short-dated premium is real on average but tail-heavy.",
    "- surface_iv vs mid_iv: how far the contract's own market price sits from the fitted surface. A big gap means the surface may be wrong for that contract.",
    "- flags: macro_event_before_expiry means a major US macro release still to come falls on or before expiry (macro_events lists them). The IV may be partly pricing that event, so the measured edge is probably overstated, not wrong: ask for a clearly stronger net edge before trading through one, the more so the heavier the release. Heavy: the Fed rate decision, CPI, the US presidential election. Medium: the US midterm elections. Light: GDP. A light release alone is no reason to pass on a strong edge.",
    "- next_earnings: the ticker's next earnings date. Earnings are the heaviest event there is, far above any macro release: a single report can move the stock more than its options price in. Never open a position, or roll one, so that it is still open when the company reports. Code already removes every open and roll whose expiry is on or after a known earnings date, and does not trade a ticker whose earnings date is unknown; if anything you are offered would still be open on next_earnings, do not choose it.",
    "- elevated_vol: the ticker's short-term realized volatility is unusually high versus its own history.",
    "- day_change_pct and spy_day_change_pct: today's moves. A sharp drop usually has a cause; selling puts into a falling market is exactly the tail risk this strategy carries.",
    "- move_context: today's move measured against the stock's own normal. day_move_sigmas is day_change_pct divided by the one-day move the realized-volatility forecast implies (expected_daily_move_pct); within ±1.5 is an ordinary day for this stock. change_1w_pct, change_1m_pct and change_3m_pct are the recent path; realized_vol_21d and realized_vol_126d (annualised %) say whether the last month is calmer or wilder than the last six; iv_rank is where today's implied volatility sits in its own one-year range (0-100).",
    "- rolls: replacing a held short leg with a lower-delta credit roll; net_roll_edge_vp is the new contract's net edge minus what holding the current leg still offers minus the cost of closing it.",
    "- close actions: selling unstructured shares at a positive cycle P&L, or buying back a short leg whose remaining edge is negative while locking a profit.",
    "- positions: Pluto manages every position on the tickers it is enabled on, whoever opened it. account.managed_positions counts all of them and they all use Pluto's capital budget; each close action and roll says opened_by (pluto or a person). A close action on a position a person opened is normal, not an inconsistency.",
    "- open_covered_call candidates: Pluto writes the call against shares the account already holds free; when there are not enough, code buys the missing 100 shares per contract at the live price in the same order (a buy-write). dollar_risk counts those shares. Holding no shares is normal for a covered-call candidate.",
    "- recent_decisions: your latest decisions, newest first. A trade carries its outcome: blocked (a code check refused it before any order was sent; outcome_detail says why), validated, order_built or confirmed (an order is on its way or working), filled or partially_filled, cancelled, rejected or error (outcome_detail says why), not_executed (no order was attempted). Only a filled or partially filled trade changed the book; the account, positions and close actions in this message always show the book as it is now.",
    "",
    "Hard rules you must obey:",
    "1. You may only name a candidate_id that appears in this message. Never invent contracts, strikes, expiries, quantities, sizes or prices: code sizes every order to the standard order size.",
    "2. Trade at most one action per decision.",
    "3. When data looks wrong or internally inconsistent (surface far from market, stale quotes, contradictory flags), list it in system_concerns with the ticker's symbol, and judge the other tickers normally: code never trades a ticker you flagged. Use symbol null only for a problem with the whole message (the account block, say). Answer abstain_system_concern only when a null-symbol concern applies or every ticker is flagged. Doubts about the merits of a trade are no_trade, never a concern.",
    `4. Confidence below ${settings.confidenceFloor} is treated as no_trade by code, so do not pad it.`,
    "5. Reasons are for the human operators: short, specific, in plain language, at most five.",
    "",
    "Judgement guidance, not a formula. The objective is yield in proportion to the risk taken, not yield for its own sake. Prefer the contract whose net edge in dollars is largest relative to the capital it commits and the tail it carries, when the liquidity is real (open interest, volume, tight spread), the contract's market price agrees with the fitted surface, the ticker is not moving violently today, no earnings sits before expiry, any macro release before expiry is paid for by a stronger edge, and the position diversifies the book rather than concentrating it. Short-dated, near-the-money contracts (a week or less to expiry, |delta| above 0.25) carry the richest annualised yield and the sharpest tail. Their yield is compensation the model has measured, not a warning, when ALL of these hold: today's move is within the stock's normal range (|day_move_sigmas| at most 1.5), the stock is not in an unusually volatile stretch (elevated_vol absent), no earnings falls before expiry, liquidity is real (open interest and volume in the hundreds or more, spread_pct within the configured maximum), and the net edge is strong. When any of these fails, prefer a longer-dated or lower-delta contract, or no trade. A good roll on a leg near expiry or drifting toward assignment is usually worth more than a new position. Doing nothing is always acceptable.",
    "",
    "Answer with a single JSON object matching the provided schema and nothing else.",
  ].join("\n");
}

/** The releases still to come (the loader returns today's from midnight on): one already out moves nothing. */
function upcomingMacroEvents(events: TickerSignals["macroEvents"], nowMs: number): { date: string; title: string }[] | undefined {
  const upcoming = events.filter((event) => Date.parse(event.eventAtIso) > nowMs).map((event) => ({ date: event.dateIso, title: event.title }));
  return upcoming.length > 0 ? upcoming : undefined;
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
  /** The position the action closes; labels it opened_by pluto or a person. */
  positionId?: string;
  kind: "close_shares" | "close_leg";
  symbol: string;
  description: string;
  cycle_pnl: number;
  detail: Record<string, unknown>;
}

export interface PlutoPromptTickerInput {
  scored: TickerSignals;
  /** Today's move against the stock's own normal (moveContext.ts); absent when the round has no bars for it. */
  moveContext?: MoveContext | null;
  eligible: PlutoOpenCandidate[];
  eligibleRolls: PlutoRollCandidate[];
  closeActions: PlutoCloseActionOffer[];
}

export interface PlutoPromptAccountInput {
  netLiquidationValue: number;
  freeCash: number;
  plutoBudgetPct: number;
  plutoBudgetUsedPct: number;
  /** Every open position in Pluto's book (all positions on enabled tickers, hedges aside). */
  managedPositions: number;
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
  recentDecisions: PlutoRecentDecision[];
  trigger: { kind: string; detail: Record<string, unknown> };
  /** Positions a Pluto order opened (book.ts): every other managed position was opened by a person. */
  plutoOpenedPositionIds: ReadonlySet<string>;
}

export interface PlutoRecentDecision {
  at: string;
  verdict: string;
  candidateId: string | null;
  reason: string | null;
  /** A trade's fate: the outcome of the action it produced, "not_executed" when it produced none; null for every other verdict. */
  outcome: string | null;
  outcomeDetail: string | null;
}

/**
 * Pure: the recent_decisions block from the latest decision rows and the actions their passes produced. A trade
 * carries its outcome so a blocked or cancelled one never reads as done.
 */
export function recentDecisionsForPrompt(
  decisions: { passId: string; createdAt: Date; parsedOutput: { decision?: string; candidate_id?: string | null; reasons?: string[] } | null }[],
  tradeActionsByPassId: Map<string, { outcome: string; blockReason: string | null }>,
): PlutoRecentDecision[] {
  return decisions.map((row) => {
    const verdict = row.parsedOutput?.decision ?? "invalid";
    const action = verdict === "trade" ? tradeActionsByPassId.get(row.passId) ?? null : null;
    return {
      at: row.createdAt.toISOString(),
      verdict,
      candidateId: row.parsedOutput?.candidate_id ?? null,
      reason: row.parsedOutput?.reasons?.[0] ?? null,
      outcome: verdict === "trade" ? action?.outcome ?? "not_executed" : null,
      outcomeDetail: action?.blockReason ?? null,
    };
  });
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
          opened_by: input.plutoOpenedPositionIds.has(roll.positionId) ? "pluto" : "a person",
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
        return { id: action.id, kind: action.kind, opened_by: action.positionId && input.plutoOpenedPositionIds.has(action.positionId) ? "pluto" : "a person", description: action.description, cycle_pnl: round(action.cycle_pnl, 0), ...action.detail };
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
        macro_events: upcomingMacroEvents(scored.macroEvents, nowMs),
        open_positions: input.account.openPositionsBySymbol[scored.symbol] ?? undefined,
        move_context: ticker.moveContext
          ? stripUndefined({
              day_move_sigmas: round(ticker.moveContext.dayMoveSigmas, 2),
              expected_daily_move_pct: round(ticker.moveContext.expectedDailyMovePct, 2),
              change_1w_pct: round(ticker.moveContext.change1wPct, 1),
              change_1m_pct: round(ticker.moveContext.change1mPct, 1),
              change_3m_pct: round(ticker.moveContext.change3mPct, 1),
              realized_vol_21d: round(ticker.moveContext.realizedVol21dPct, 0),
              realized_vol_126d: round(ticker.moveContext.realizedVol126dPct, 0),
              iv_rank: round(ticker.moveContext.ivRank, 0),
            })
          : undefined,
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
    trigger: { kind: input.trigger.kind },
    market: stripUndefined({ spy_day_change_pct: round(input.spyDayChangePct, 2) }),
    account: {
      nlv: round(input.account.netLiquidationValue, 0),
      free_cash: round(input.account.freeCash, 0),
      pluto_budget_pct: input.account.plutoBudgetPct,
      pluto_budget_used_pct: round(input.account.plutoBudgetUsedPct, 1),
      managed_positions: input.account.managedPositions,
      max_open_positions: input.account.maxOpenPositions,
      actions_today: input.account.actionsToday,
      max_actions_per_session: input.account.maxActionsPerSession,
    },
    parameters: {
      min_grade: input.settings.minGrade,
      max_abs_delta: input.settings.maxAbsDelta,
      dte_range: [input.settings.minDte, input.settings.maxDte],
      max_ticker_exposure_pct: input.settings.maxTickerExposurePct,
      order_size_pct_of_budget: input.settings.orderSizePctOfBudget,
      confidence_floor: input.settings.confidenceFloor,
      spread_cost_share_pct: input.spreadCostSharePct,
    },
    tickers,
    recent_decisions: input.recentDecisions.length > 0 ? input.recentDecisions.map((entry) => stripUndefined({ at: entry.at, verdict: entry.verdict, candidate_id: entry.candidateId ?? undefined, outcome: entry.outcome ?? undefined, outcome_detail: entry.outcomeDetail ?? undefined, reason: entry.reason ?? undefined })) : undefined,
  });
  return { payload, offeredIds };
}
