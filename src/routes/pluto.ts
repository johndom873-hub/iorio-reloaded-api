import { Router, type Request, type Response } from "express";
import { db } from "../db/connection.js";
import { loadRealizedPnlByActionId, type PlutoActionRealizedPnl } from "../pluto/actionRealizedPnl.js";
import { loadPlutoBook } from "../pluto/book.js";
import { resolvePlutoSession } from "../pluto/sessionSchedule.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { loadPlutoSettings, loadPlutoSettingsAudit, PlutoSettingsValidationError, updatePlutoSettings, type PlutoSettingsInput } from "../pluto/settingsStore.js";
import { describePlutoBlock, loadPlutoState, pausePluto, PlutoStateError, resetPlutoBreaker, resumePluto, setPlutoMode, setPlutoStressOverride, type PlutoMode } from "../pluto/stateStore.js";
import { plutoEventCategories, plutoEventCategoryByType, plutoEventTypesInCategories, recordPlutoEvent, type PlutoEventCategory, type PlutoEventType } from "../pluto/ledger.js";
import { cancelPlutoOrders, countPlutoWorkingOrders, loadPlutoWorkingOrders } from "../pluto/orders.js";
import { loadPlutoOrdersTodayBreakdown, loadPlutoTodayCounters } from "../pluto/counters.js";
import { computePlutoActionExposure, loadPlutoOrderRequestsByActionId, type PlutoActionOrderRequest } from "../pluto/actionExposure.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import { normalizeSystemConcerns } from "../pluto/decisionSchema.js";
import { loadDaySignalsWatchStatuses } from "../lib/daySignalsWatchStatus.js";

// The Pluto screen's API. Any signed-in user can operate every control (Marcelo, 2026-09-28:
// both users share one access level); the UI puts confirm modals in front of the risky ones.

export const plutoRouter = Router();
plutoRouter.use(requireAuth);

function currentUserId(request: Request): string {
  return request.session.userId as string;
}

async function currentUserDisplayName(request: Request): Promise<string> {
  const row = await db("users").where({ id: currentUserId(request) }).first("display_name");
  return (row?.display_name as string | undefined) ?? "an operator";
}

plutoRouter.get("/state", async (_request: Request, response: Response) => {
  const [state, settings, working, counters, ordersToday, workingOrders, agentHealth, enabledCount, book, lastSnapshot, lastModeChange, lastCheckedPass, unfilledCancelMinutes] = await Promise.all([
    loadPlutoState(),
    loadPlutoSettings(),
    countPlutoWorkingOrders(),
    loadPlutoTodayCounters(),
    loadPlutoOrdersTodayBreakdown(),
    loadPlutoWorkingOrders(),
    db("worker_health").where({ process_name: "pluto_agent" }).first(),
    db("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    loadPlutoBook(),
    db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first("net_liquidation_value", "snapshot_date"),
    db("pluto_events").where({ type: "mode_changed" }).orderBy("occurred_at", "desc").first("occurred_at", "payload"),
    db("pluto_passes").whereNotNull("system_checks").orderBy("started_at", "desc").first("id", "started_at", "system_checks"),
    loadOrderUnfilledCancelMinutes(),
  ]);
  // The book tile uses last night's NLV (no IBKR round trip on a screen load); the agent's passes use the live figure.
  const netLiquidationValue = lastSnapshot ? Number(lastSnapshot.net_liquidation_value) : null;
  const session = await resolvePlutoSession(new Date(), settings);
  const openPositionsBySymbol: Record<string, number> = {};
  for (const position of book.openPositions) openPositionsBySymbol[position.symbol] = (openPositionsBySymbol[position.symbol] ?? 0) + 1;
  const workingOrdersBySymbol: Record<string, number> = {};
  for (const order of workingOrders) workingOrdersBySymbol[order.symbol] = (workingOrdersBySymbol[order.symbol] ?? 0) + 1;
  response.json({
    ...state,
    blockReason: describePlutoBlock(state),
    modeChangedAt: lastModeChange ? new Date(lastModeChange.occurred_at).toISOString() : null,
    modeChangedBy: (lastModeChange?.payload as { by?: string } | undefined)?.by ?? null,
    orders: working,
    ordersToday,
    workingOrders,
    unfilledCancelMinutes,
    counters: { ...counters, maxActionsPerSession: settings.maxActionsPerSession, dailyCostCeilingUsd: settings.dailyCostCeilingUsd },
    enabledTickers: { count: enabledCount, max: settings.maxEnabledTickers },
    session: {
      ...session,
      windowStartAt: new Date(session.windowStartAtMs).toISOString(),
      windowEndAt: new Date(session.windowEndAtMs).toISOString(),
      closeAt: new Date(session.closeAtMs).toISOString(),
    },
    // The newest analysis's pre-model checks: what currently holds Pluto back (worker offline, SPY stress…) between analyses.
    lastChecks: lastCheckedPass ? { passId: lastCheckedPass.id, startedAt: new Date(lastCheckedPass.started_at).toISOString(), checks: lastCheckedPass.system_checks } : null,
    book: {
      committedDollars: book.committedDollars,
      openPositionCount: book.openPositions.length,
      openSymbols: [...book.openSymbols].sort(),
      workingOrderSymbols: [...book.workingOrderSymbols].sort(),
      openPositionsBySymbol,
      workingOrdersBySymbol,
      netLiquidationValue,
      netLiquidationValueAsOf: lastSnapshot ? String(lastSnapshot.snapshot_date).slice(0, 10) : null,
      capitalBudgetPct: settings.capitalBudgetPct,
      orderSizePctOfBudget: settings.orderSizePctOfBudget,
      maxOpenPositions: settings.maxOpenPositions,
    },
    agent: agentHealth
      ? {
          connected: Boolean(agentHealth.connected),
          heartbeatAgeSeconds: Math.max(0, Math.round((Date.now() - new Date(agentHealth.updated_at).getTime()) / 1000)),
          gitSha: agentHealth.git_sha ? String(agentHealth.git_sha).slice(0, 7) : null,
          appEnvironment: agentHealth.app_environment ?? null,
        }
      : null,
  });
});

plutoRouter.put("/mode", async (request: Request, response: Response) => {
  const mode = request.body?.mode as PlutoMode;
  if (mode !== "off" && mode !== "on") {
    response.status(400).json({ error: "mode must be off or on." });
    return;
  }
  const before = await loadPlutoState();
  if (before.mode === mode) {
    response.json(before);
    return;
  }
  const state = await setPlutoMode(mode);
  const who = await currentUserDisplayName(request);
  await recordPlutoEvent("mode_changed", { mode, by: who });
  await notifyPlutoTelegram(mode === "on" ? `🪐 Pluto switched ON by ${who}${state.paused ? " (still paused — press Resume to let it act)" : ""}.` : `🪐 Pluto switched OFF by ${who}.`);
  response.json(state);
});

plutoRouter.post("/pause", async (request: Request, response: Response) => {
  const cancelWorkingOrders = request.body?.cancelWorkingOrders === true;
  const userId = currentUserId(request);
  const who = await currentUserDisplayName(request);
  const state = await pausePluto("manual", { userId });
  const cancelled = await cancelPlutoOrders(userId, { includeWorking: cancelWorkingOrders });
  await recordPlutoEvent("paused", { by: who, cancelWorkingOrders, cancelledLocally: cancelled.cancelledLocally.length, cancelRequested: cancelled.cancelRequested.length });
  await notifyPlutoTelegram(
    `⏸️ Pluto paused by ${who}.${cancelled.cancelledLocally.length > 0 ? ` Dropped ${cancelled.cancelledLocally.length} unsent order(s).` : ""}${cancelWorkingOrders ? ` Cancel requested for ${cancelled.cancelRequested.length} working order(s).` : ""}`,
  );
  response.json({ ...state, cancelled });
});

plutoRouter.post("/resume", async (request: Request, response: Response) => {
  const who = await currentUserDisplayName(request);
  try {
    const state = await resumePluto(currentUserId(request));
    await recordPlutoEvent("resumed", { by: who });
    await notifyPlutoTelegram(`▶️ Pluto resumed by ${who}${state.mode === "off" ? " (mode is off, so it will not act until switched on)" : ""}.`);
    response.json(state);
  } catch (error) {
    if (error instanceof PlutoStateError) {
      response.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
});

plutoRouter.post("/breakers/:name/reset", async (request: Request, response: Response) => {
  const name = String(request.params.name);
  const before = await loadPlutoState();
  if (!before.breakers[name]) {
    response.status(404).json({ error: `No tripped breaker named ${name}.` });
    return;
  }
  const who = await currentUserDisplayName(request);
  const state = await resetPlutoBreaker(name);
  await recordPlutoEvent("breaker_reset", { name, by: who });
  await notifyPlutoTelegram(`🔧 Pluto breaker "${name}" reset by ${who}. Pluto stays paused until resumed.`);
  response.json(state);
});

// "Allow opens under stress today": clears itself with the Eastern date (Marcelo, 2026-09-28).
plutoRouter.put("/stress-override", async (request: Request, response: Response) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== "boolean") {
    response.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  const todayIso = easternIsoDate(new Date());
  const who = await currentUserDisplayName(request);
  const state = await setPlutoStressOverride(enabled ? todayIso : null, currentUserId(request));
  await recordPlutoEvent("stress_override_changed", { enabled, dateIso: todayIso, by: who });
  await notifyPlutoTelegram(enabled ? `⚠️ Pluto: ${who} allowed new opens under SPY stress for ${todayIso}.` : `Pluto: ${who} removed today's SPY stress override.`);
  response.json(state);
});

plutoRouter.get("/scoreboard", async (_request: Request, response: Response) => {
  const actions: { id: string; pass_id: string; kind: string; outcome: string; pessimistic_pnl: string | null; deterministic_top_pick: { id?: string } | null; order_request_id: string | null }[] = await db("pluto_actions").select("id", "pass_id", "kind", "outcome", "pessimistic_pnl", "deterministic_top_pick", "order_request_id");
  const realized = await loadRealizedPnlByActionId(actions.filter((action) => action.order_request_id).map((action) => action.id));
  const decisions: { pass_id: string; parsed_output: { decision?: string; candidate_id?: string | null } | null }[] = await db("pluto_decisions").where("call_index", 1).whereNotNull("parsed_output").select("pass_id", "parsed_output");
  const passes = await db("pluto_passes").select(db.raw("count(*)::int AS passes, count(*) FILTER (WHERE model_called)::int AS model_called, COALESCE(SUM(cost_usd), 0) AS cost_usd, MIN(started_at) AS since")).first();

  const outcomes: Record<string, number> = {};
  for (const action of actions) outcomes[action.outcome] = (outcomes[action.outcome] ?? 0) + 1;
  let realizedPnl = 0;
  let pessimisticPnl = 0;
  let closedActions = 0;
  let winningActions = 0;
  let openActions = 0;
  for (const action of actions) {
    pessimisticPnl += action.pessimistic_pnl === null ? 0 : Number(action.pessimistic_pnl);
    const figures = realized.get(action.id);
    if (!figures) continue;
    if (figures.realizedPnl !== null) realizedPnl += figures.realizedPnl;
    if (figures.openLegCount > 0) openActions += 1;
    else if (figures.closedLegCount > 0) {
      closedActions += 1;
      if ((figures.realizedPnl ?? 0) > 0) winningActions += 1;
    }
  }
  // Model vs the deterministic Edge $ top pick, per pass that called the model.
  const topPickByPass = new Map<string, string | null>();
  for (const action of actions) if (action.deterministic_top_pick !== null) topPickByPass.set(action.pass_id, action.deterministic_top_pick?.id ?? null);
  let agree = 0;
  let disagree = 0;
  let noTrade = 0;
  for (const decision of decisions) {
    const verdict = decision.parsed_output?.decision;
    if (verdict !== "trade") {
      noTrade += 1;
      continue;
    }
    const topPick = topPickByPass.get(decision.pass_id) ?? null;
    if (topPick !== null && decision.parsed_output?.candidate_id === topPick) agree += 1;
    else disagree += 1;
  }
  response.json({
    since: passes?.since ? new Date(passes.since).toISOString() : null,
    passes: Number(passes?.passes ?? 0),
    modelCalls: Number(passes?.model_called ?? 0),
    costUsd: Math.round(Number(passes?.cost_usd ?? 0) * 10000) / 10000,
    outcomes,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    pessimisticPnl: Math.round(pessimisticPnl * 100) / 100,
    closedActions,
    winningActions,
    openActions,
    modelVsTopPick: { agree, disagree, noTrade },
  });
});

plutoRouter.get("/settings", async (_request: Request, response: Response) => {
  response.json(await loadPlutoSettings());
});

plutoRouter.put("/settings", async (request: Request, response: Response) => {
  const input = (request.body ?? {}) as PlutoSettingsInput;
  if (typeof input !== "object" || Array.isArray(input)) {
    response.status(400).json({ error: "Body must be an object of settings fields." });
    return;
  }
  const before = (await loadPlutoSettings()) as unknown as Record<string, unknown>;
  try {
    const settings = await updatePlutoSettings(input, currentUserId(request));
    const after = settings as unknown as Record<string, unknown>;
    const changed = Object.keys(input).filter((field) => String(before[field]) !== String(after[field]));
    if (changed.length > 0) {
      const who = await currentUserDisplayName(request);
      await recordPlutoEvent("settings_changed", { by: who, fields: changed.map((field) => ({ field, from: before[field], to: after[field] })) });
    }
    response.json(settings);
  } catch (error) {
    if (error instanceof PlutoSettingsValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }
});

plutoRouter.get("/settings/audit", async (request: Request, response: Response) => {
  response.json(await loadPlutoSettingsAudit(Math.min(500, Number(request.query.limit) || 100)));
});

function limitFrom(request: Request, fallback: number): number {
  return Math.max(1, Math.min(500, Number(request.query.limit) || fallback));
}

/** ?modelCalled=true keeps only passes that asked the model, so a screen wanting the latest decision is not buried under skipped passes. */
plutoRouter.get("/passes", async (request: Request, response: Response) => {
  const passesQuery = db("pluto_passes").orderBy("started_at", "desc").limit(limitFrom(request, 50));
  if (request.query.modelCalled === "true") passesQuery.where({ model_called: true });
  const rows = await passesQuery;
  const passIds = rows.map((row) => row.id);
  const [decisions, actions] = passIds.length === 0 ? [[], []] : await Promise.all([
    db("pluto_decisions").whereIn("pass_id", passIds).orderBy("call_index"),
    db("pluto_actions").whereIn("pass_id", passIds).orderBy("created_at"),
  ]);
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(actions.map((action) => String(action.id))), loadPlutoOrderRequestsByActionId(actions.map((action) => String(action.id)))]);
  response.json(
    rows.map((row) => ({
      ...serializePass(row),
      // Compact per-call summary for the Decisions card (the full input payload stays on GET /passes/:id).
      decisions: decisions.filter((decision) => decision.pass_id === row.id).map((decision) => ({ callIndex: decision.call_index, servedModelId: decision.served_model_id ?? null, serviceTier: decision.service_tier ?? null, parsedOutput: serializeParsedOutput(decision.parsed_output), schemaValid: Boolean(decision.schema_valid), latencyMs: decision.latency_ms ?? null, tokensIn: decision.tokens_in ?? null, tokensOut: decision.tokens_out ?? null, costUsd: decision.cost_usd === null ? null : Number(decision.cost_usd), error: decision.error ?? null })),
      actions: actions.filter((action) => action.pass_id === row.id).map((action) => serializeAction(action, realized.get(String(action.id)), orderRequests.get(String(action.id)))),
    })),
  );
});

plutoRouter.get("/passes/:id", async (request: Request, response: Response) => {
  const pass = await db("pluto_passes").where({ id: request.params.id }).first();
  if (!pass) {
    response.status(404).json({ error: "Pass not found." });
    return;
  }
  const [decisions, actions] = await Promise.all([
    db("pluto_decisions").where({ pass_id: pass.id }).orderBy("call_index"),
    db("pluto_actions").where({ pass_id: pass.id }).orderBy("created_at"),
  ]);
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(actions.map((action) => String(action.id))), loadPlutoOrderRequestsByActionId(actions.map((action) => String(action.id)))]);
  response.json({ ...serializePass(pass), decisions: decisions.map(serializeDecision), actions: actions.map((action) => serializeAction(action, realized.get(String(action.id)), orderRequests.get(String(action.id)))) });
});

/** A stored decision for the screen: system concerns always as { symbol, concern } (stored before prompt v3.3 as plain strings). */
function serializeParsedOutput(parsed: unknown): Record<string, unknown> | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const output = parsed as Record<string, unknown>;
  return { ...output, system_concerns: normalizeSystemConcerns(output.system_concerns) };
}

plutoRouter.get("/actions", async (request: Request, response: Response) => {
  const rows = await db("pluto_actions").orderBy("created_at", "desc").limit(limitFrom(request, 100));
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(rows.map((row) => String(row.id))), loadPlutoOrderRequestsByActionId(rows.map((row) => String(row.id)))]);
  response.json(rows.map((row) => serializeAction(row, realized.get(String(row.id)), orderRequests.get(String(row.id)))));
});

/** The payload keys that tie an event to tickers or to a pass; an event with none of them applies to every ticker. */
const tickerAndPassKeys = ["symbol", "symbols", "tickers", "passId"];

/**
 * The Event log's query. Filters (all optional, all applied in the query so the page and the total agree):
 * ?categories=a,b keeps those groups, ?types=a,b keeps only those types, ?excludeTypes=a,b leaves those out,
 * ?ticker=XYZ keeps that ticker's trace (see below), ?session=YYYY-MM-DD keeps one Eastern calendar day.
 * ?limit and ?offset page it; the body is `{ events, total }` with total counting every match, not just this page.
 */
plutoRouter.get("/events", async (request: Request, response: Response) => {
  const listFrom = (value: unknown): string[] => (typeof value === "string" ? value.split(",").filter(Boolean) : []);
  const requestedCategories = listFrom(request.query.categories);
  if (requestedCategories.some((category) => !plutoEventCategories.includes(category as PlutoEventCategory))) {
    response.status(400).json({ error: `categories must be among: ${plutoEventCategories.join(", ")}.` });
    return;
  }
  const session = typeof request.query.session === "string" && request.query.session !== "" ? request.query.session : null;
  if (session !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(session) || Number.isNaN(Date.parse(session)) || new Date(`${session}T00:00:00Z`).toISOString().slice(0, 10) !== session)) {
    response.status(400).json({ error: "session must be a date like 2026-10-07." });
    return;
  }
  const onlyTypes = listFrom(request.query.types);
  const excludedTypes = listFrom(request.query.excludeTypes);
  const ticker = typeof request.query.ticker === "string" ? request.query.ticker.trim().toUpperCase() : "";
  const offset = Math.max(0, Math.floor(Number(request.query.offset)) || 0);

  const filtered = db("pluto_events");
  if (request.query.categories !== undefined) filtered.whereIn("type", plutoEventTypesInCategories(requestedCategories as PlutoEventCategory[]));
  if (onlyTypes.length > 0) filtered.whereIn("type", onlyTypes);
  if (excludedTypes.length > 0) filtered.whereNotIn("type", excludedTypes);
  if (ticker !== "") {
    // A ticker's whole trace: events naming it, every event of a pass that looked at it (the model's call and its
    // no-order result name no ticker themselves), and events that name no ticker and belong to no pass, since those
    // (settings, pauses, breakers) apply to every ticker. An event names its tickers as `symbol`, or as a list under
    // `symbols` / `tickers`; a list's ->> text is its JSON, so one LIKE covers all three.
    const likeTicker = `%${ticker.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const namesTicker = "(upper(payload->>'symbol') like ? or upper(payload->>'symbols') like ? or upper(payload->>'tickers') like ?)";
    filtered.where((builder) => {
      builder
        .whereRaw(namesTicker, [likeTicker, likeTicker, likeTicker])
        .orWhereRaw(`payload->>'passId' in (select payload->>'passId' from pluto_events where type = 'pass_started' and ${namesTicker})`, [likeTicker, likeTicker, likeTicker])
        .orWhereRaw(`not jsonb_exists_any(payload, array[${tickerAndPassKeys.map(() => "?").join(", ")}])`, tickerAndPassKeys);
    });
  }
  if (session !== null) filtered.whereRaw("occurred_at >= (?::date)::timestamp at time zone 'America/New_York' and occurred_at < ((?::date) + 1)::timestamp at time zone 'America/New_York'", [session, session]);

  const [rows, countRows] = await Promise.all([filtered.clone().orderBy("occurred_at", "desc").orderBy("id", "desc").limit(limitFrom(request, 200)).offset(offset), filtered.clone().count({ total: "*" })]);
  response.json({
    events: rows.map((row) => ({ id: Number(row.id), occurredAt: new Date(row.occurred_at).toISOString(), type: row.type, category: plutoEventCategoryByType[row.type as PlutoEventType] ?? "system", appliesToAllTickers: !tickerAndPassKeys.some((key) => key in (row.payload ?? {})), payload: row.payload })),
    total: Number(countRows[0]?.total ?? 0),
  });
});

/**
 * Whether Day Signals is watching each Pluto-enabled ticker today, and when it looks again (daySignalsWatchStatus.ts):
 * `{ tradingDateIso, sessionOpen, tickers: { [tickerId]: status } }`.
 */
plutoRouter.get("/day-signals-watch", async (_request: Request, response: Response) => {
  const enabled: { tickerId: string }[] = await db("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).select("ticker_id as tickerId");
  const { tradingDateIso, sessionOpen, statuses } = await loadDaySignalsWatchStatuses(enabled.map((row) => row.tickerId));
  response.json({ tradingDateIso, sessionOpen, tickers: Object.fromEntries(statuses) });
});

plutoRouter.get("/tickers", async (_request: Request, response: Response) => {
  const [rows, settings] = await Promise.all([
    db("shortlist_entries as se")
      .join("tickers as t", "t.id", "se.ticker_id")
      .leftJoin("users as u", "u.id", "se.bot_enabled_changed_by_user_id")
      .whereNull("se.removed_at")
      // Pluto only trades Signals tickers; a Signals-off ticker is not listed here at all.
      .where("se.signals_enabled", true)
      .select("se.id as entryId", "t.id as tickerId", "t.symbol", "t.company_name as companyName", "t.sector", "se.bot_enabled as botEnabled", "se.bot_enabled_changed_at as botEnabledChangedAt", "u.display_name as botEnabledChangedBy")
      .orderBy("t.symbol"),
    loadPlutoSettings(),
  ]);
  response.json({
    max: settings.maxEnabledTickers,
    tickers: rows.map((row) => ({
      entryId: row.entryId,
      tickerId: row.tickerId,
      symbol: row.symbol,
      companyName: row.companyName ?? null,
      sector: row.sector ?? null,
      botEnabled: Boolean(row.botEnabled),
      botEnabledChangedAt: row.botEnabledChangedAt ? new Date(row.botEnabledChangedAt).toISOString() : null,
      botEnabledChangedBy: row.botEnabledChangedBy ?? null,
    })),
  });
});

function serializePass(row: Record<string, unknown>) {
  return {
    id: row.id,
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
    trigger: row.trigger,
    triggerDetail: row.trigger_detail,
    inputHash: row.input_hash ?? null,
    candidateCount: row.candidate_count,
    systemChecks: row.system_checks,
    modelCalled: Boolean(row.model_called),
    skippedReason: row.skipped_reason ?? null,
    tokensIn: row.tokens_in ?? null,
    tokensOut: row.tokens_out ?? null,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    servedModelIds: row.served_model_ids ?? [],
    settingsSnapshot: row.settings_snapshot ?? null,
    promptVersion: (row.settings_snapshot as { promptVersion?: string } | null)?.promptVersion ?? null,
  };
}

function serializeDecision(row: Record<string, unknown>) {
  return {
    id: row.id,
    passId: row.pass_id,
    callIndex: row.call_index,
    modelId: row.model_id,
    servedModelId: row.served_model_id ?? null,
    serviceTier: row.service_tier ?? null,
    promptId: row.prompt_id ?? null,
    inputPayload: row.input_payload,
    rawOutput: row.raw_output ?? null,
    parsedOutput: serializeParsedOutput(row.parsed_output),
    schemaValid: Boolean(row.schema_valid),
    latencyMs: row.latency_ms ?? null,
    tokensIn: row.tokens_in ?? null,
    tokensOut: row.tokens_out ?? null,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    error: row.error ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function serializeAction(row: Record<string, unknown>, realized?: PlutoActionRealizedPnl, orderRequest?: PlutoActionOrderRequest) {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  const exposureInput = { kind: String(row.kind), outcome: String(row.outcome), contract: (row.contract as Record<string, unknown> | null) ?? null, quantity: num(row.quantity), limitPrice: num(row.limit_price), fillPrice: num(row.fill_price) };
  return {
    id: row.id,
    passId: row.pass_id,
    kind: row.kind,
    symbol: row.symbol,
    tickerId: row.ticker_id ?? null,
    contract: row.contract ?? null,
    candidateScores: row.candidate_scores ?? null,
    deterministicTopPick: row.deterministic_top_pick ?? null,
    gateResults: row.gate_results ?? [],
    sizeTier: row.size_tier ?? null,
    quantity: row.quantity ?? null,
    limitPrice: num(row.limit_price),
    outcome: row.outcome,
    blockReason: row.block_reason ?? null,
    orderRequestId: row.order_request_id ?? null,
    referenceBid: num(row.reference_bid),
    referenceMid: num(row.reference_mid),
    fillPrice: num(row.fill_price),
    impliedFillPrice: num(row.implied_fill_price),
    pessimisticPnl: num(row.pessimistic_pnl),
    // EXP $ the order adds (or, negative, releases), the way Positions counts exposure; null without an order.
    exposureDollars: computePlutoActionExposure(exposureInput, orderRequest ?? null),
    // Contracts (shares for a share sale) the order's trades filled so far; null before any fill or without an order.
    filledQuantity: orderRequest?.filledQuantity ?? null,
    // Derived at read time from the legs this action opened (see pluto/actionRealizedPnl.ts); the column is not read.
    realizedPnl: realized?.realizedPnl ?? null,
    closedLegCount: realized?.closedLegCount ?? 0,
    openLegCount: realized?.openLegCount ?? 0,
    evaluatedAt: row.evaluated_at ? new Date(row.evaluated_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}
