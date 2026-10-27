import { Router, type Request, type Response } from "express";
import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { loadRealizedPnlByActionId, type PlutoActionRealizedPnl } from "../pluto/actionRealizedPnl.js";
import { loadPlutoBook } from "../pluto/book.js";
import { resolvePlutoSession } from "../pluto/sessionSchedule.js";
import { requireAdmin, requireAuth } from "../middleware/requireAuth.js";
import { isAdminRequest } from "../lib/sessionUser.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { loadPlutoSettings, loadPlutoSettingsAudit, PlutoSettingsValidationError, updatePlutoSettings, type PlutoSettingsInput } from "../pluto/settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, loadPlutoTickerSettings, loadPlutoTickerSettingsAudit, PlutoTickerNotFoundError, PlutoTickerSettingsValidationError, updatePlutoTickerSettings, type PlutoTickerSettingsField, type PlutoTickerSettingsInput } from "../pluto/tickerSettingsStore.js";
import { loadLadderScreenSettings } from "../pluto/ladderSettings.js";
import { loadCurrentPlutoSettingsVersion } from "../pluto/settingsVersions.js";
import { loadPlutoHowItWorks } from "../pluto/howItWorks.js";
import { describePlutoBlock, loadPlutoState, pausePluto, PlutoStateError, resetPlutoBreaker, resumePluto, setPlutoMode, setPlutoStressOverride, type PlutoMode } from "../pluto/stateStore.js";
import { plutoEventCategories, plutoEventCategoryByType, plutoEventTypesInCategories, recordPlutoEvent, type PlutoEventCategory } from "../pluto/ledger.js";
import { cancelPlutoOrders, countPlutoWorkingOrders, loadPlutoWorkingOrders } from "../pluto/orders.js";
import { loadPlutoOrdersTodayBreakdown, loadPlutoTodayCounters } from "../pluto/counters.js";
import { computePlutoActionExposure, loadPlutoOrderRequestsByActionId, type PlutoActionOrderRequest } from "../pluto/actionExposure.js";
import { loadOrderUnfilledCancelMinutes } from "../lib/tradingSettingsStore.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";

// The Pluto screen's API. A trader can only stop Pluto (turn it off, pause it, drop today's stress override); starting it,
// resuming it, resetting a breaker, allowing opens under stress and every setting are an admin's (Marcelo 2026-10-17).
// The UI puts confirm modals in front of the risky ones.

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
    counters: { ...counters, maxActionsPerSession: settings.maxActionsPerSession },
    enabledTickers: { count: enabledCount, max: settings.maxEnabledTickers },
    session: {
      ...session,
      windowStartAt: new Date(session.windowStartAtMs).toISOString(),
      windowEndAt: new Date(session.windowEndAtMs).toISOString(),
      closeAt: new Date(session.closeAtMs).toISOString(),
    },
    // The newest round's system checks: what currently holds Pluto back (worker offline, SPY stress…) between analyses.
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
  if (mode === "on" && !isAdminRequest(request)) {
    response.status(403).json({ error: "Only an admin can switch Pluto on." });
    return;
  }
  const before = await loadPlutoState();
  if (before.mode === mode) {
    response.json(before);
    return;
  }
  let state;
  try {
    state = await setPlutoMode(mode);
  } catch (error) {
    if (error instanceof PlutoStateError) {
      response.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
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

plutoRouter.post("/resume", requireAdmin, async (request: Request, response: Response) => {
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

plutoRouter.post("/breakers/:name/reset", requireAdmin, async (request: Request, response: Response) => {
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
  if (enabled && !isAdminRequest(request)) {
    response.status(403).json({ error: "Only an admin can allow opens under stress." });
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
  const actions: { id: string; outcome: string; order_request_id: string | null }[] = await db("pluto_actions").select("id", "outcome", "order_request_id");
  const realized = await loadRealizedPnlByActionId(actions.filter((action) => action.order_request_id).map((action) => action.id));
  const passes = await db("pluto_passes").select(db.raw("count(*)::int AS passes, MIN(started_at) AS since")).first();

  const outcomes: Record<string, number> = {};
  for (const action of actions) outcomes[action.outcome] = (outcomes[action.outcome] ?? 0) + 1;
  let realizedPnl = 0;
  let closedActions = 0;
  let winningActions = 0;
  let openActions = 0;
  for (const action of actions) {
    const figures = realized.get(action.id);
    if (!figures) continue;
    if (figures.realizedPnl !== null) realizedPnl += figures.realizedPnl;
    if (figures.openLegCount > 0) openActions += 1;
    else if (figures.closedLegCount > 0) {
      closedActions += 1;
      if ((figures.realizedPnl ?? 0) > 0) winningActions += 1;
    }
  }
  response.json({
    since: passes?.since ? new Date(passes.since).toISOString() : null,
    passes: Number(passes?.passes ?? 0),
    outcomes,
    realizedPnl: Math.round(realizedPnl * 100) / 100,
    closedActions,
    winningActions,
    openActions,
  });
});

plutoRouter.get("/settings", async (_request: Request, response: Response) => {
  response.json(await loadPlutoSettings());
});

plutoRouter.put("/settings", requireAdmin, async (request: Request, response: Response) => {
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

/** Every enabled ticker's settings, with the allocation each one gets after the equal split. */
plutoRouter.get("/ticker-settings", async (_request: Request, response: Response) => {
  const enabledTickers = await loadEnabledPlutoTickerSettings();
  const effective = effectiveAllocationPctBySymbol(enabledTickers);
  response.json(enabledTickers.map((ticker) => ({ ...ticker, effectiveAllocationPct: effective.get(ticker.symbol) ?? null })));
});

plutoRouter.get("/ticker-settings/audit", async (request: Request, response: Response) => {
  const symbol = typeof request.query.symbol === "string" && request.query.symbol !== "" ? request.query.symbol : undefined;
  response.json(await loadPlutoTickerSettingsAudit(limitFrom(request, 100), symbol));
});

plutoRouter.get("/ticker-settings/:symbol", async (request: Request, response: Response) => {
  const settings = await loadPlutoTickerSettings(String(request.params.symbol));
  if (!settings) {
    response.status(404).json({ error: `${String(request.params.symbol).toUpperCase()} is not a known ticker.` });
    return;
  }
  response.json(settings);
});

/** Body: any of allocationPct, ladderSharesPct, ladderShockOverridePct; null puts a field back to the default. */
plutoRouter.put("/ticker-settings/:symbol", requireAdmin, async (request: Request, response: Response) => {
  const input = request.body;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    response.status(400).json({ error: "Body must be an object of ticker settings fields." });
    return;
  }
  const symbol = String(request.params.symbol);
  const before = await loadPlutoTickerSettings(symbol);
  try {
    const settings = await updatePlutoTickerSettings(symbol, input as PlutoTickerSettingsInput, currentUserId(request));
    const changed = (Object.keys(input) as PlutoTickerSettingsField[]).filter((field) => before?.[field] !== settings[field]);
    if (changed.length > 0) {
      const who = await currentUserDisplayName(request);
      await recordPlutoEvent("settings_changed", { by: who, symbol: settings.symbol, fields: changed.map((field) => ({ field, from: before?.[field] ?? null, to: settings[field] })) });
    }
    response.json(settings);
  } catch (error) {
    if (error instanceof PlutoTickerSettingsValidationError) {
      response.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof PlutoTickerNotFoundError) {
      response.status(404).json({ error: error.message });
      return;
    }
    throw error;
  }
});

/** Every number the "How it works" tab quotes for both strategies (src/pluto/howItWorks.ts). */
plutoRouter.get("/how-it-works", async (_request: Request, response: Response) => {
  response.json(await loadPlutoHowItWorks());
});

/** Every shortlisted ticker's CC + Put Ladder settings, as the ticker window shows them (the Tickers tab's columns). */
plutoRouter.get("/ladder-settings", async (_request: Request, response: Response) => {
  const rows: { symbol: string }[] = await db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").orderBy("t.symbol").select("t.symbol");
  response.json(await loadLadderScreenSettings(rows.map((row) => row.symbol)));
});

/** The CC + Put Ladder's settings for one ticker (backtest names and units), with the fit checks' price, the budget in dollars and the recommended shock's source. */
plutoRouter.get("/ladder-settings/:symbol", async (request: Request, response: Response) => {
  const [settings] = await loadLadderScreenSettings([String(request.params.symbol).toUpperCase()]);
  response.json(settings);
});

/** The settings version a pass would record now: its number (in the order versions were first stored) and when the settings last changed. */
plutoRouter.get("/settings/version", async (_request: Request, response: Response) => {
  response.json(await loadCurrentPlutoSettingsVersion());
});

function limitFrom(request: Request, fallback: number): number {
  const requested = request.query.limit === undefined || request.query.limit === "" ? Number.NaN : Number(request.query.limit);
  return Number.isFinite(requested) ? Math.max(1, Math.min(500, Math.floor(requested))) : fallback;
}

plutoRouter.get("/passes", async (request: Request, response: Response) => {
  const passesQuery = withPassSettings(db("pluto_passes")).orderBy("started_at", "desc").limit(limitFrom(request, 50));
  response.json(await serializePassesWithDetails(await passesQuery));
});

/** Each pass row with the settings version it ran with, as version_settings (serializePass reads it). */
function withPassSettings(passesQuery: Knex.QueryBuilder): Knex.QueryBuilder {
  return passesQuery.leftJoin("pluto_settings_versions", "pluto_settings_versions.id", "pluto_passes.settings_version_id").select("pluto_passes.*", "pluto_settings_versions.settings as version_settings");
}

/** Passes with each one's actions. */
async function serializePassesWithDetails(rows: Record<string, unknown>[]) {
  const passIds = rows.map((row) => row.id as string);
  const actions = passIds.length === 0 ? [] : await db("pluto_actions").whereIn("pass_id", passIds).orderBy("created_at");
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(actions.map((action) => String(action.id))), loadPlutoOrderRequestsByActionId(actions.map((action) => String(action.id)))]);
  return rows.map((row) => ({
    ...serializePass(row),
    actions: actions.filter((action) => action.pass_id === row.id).map((action) => serializeAction(action, realized.get(String(action.id)), orderRequests.get(String(action.id)))),
  }));
}

/** ?since=<ISO time> for the History filters; null when absent, undefined when it is not a time. */
function sinceFrom(request: Request): Date | null | undefined {
  if (request.query.since === undefined || request.query.since === "") return null;
  const since = typeof request.query.since === "string" ? new Date(request.query.since) : new Date(Number.NaN);
  return Number.isNaN(since.getTime()) ? undefined : since;
}

const pageOffsetFrom = (request: Request) => Math.max(0, Math.floor(Number(request.query.offset)) || 0);
const tickerSearchFrom = (request: Request) => (typeof request.query.ticker === "string" ? request.query.ticker.trim().toUpperCase() : "");

plutoRouter.get("/passes/:id", async (request: Request, response: Response) => {
  const pass = await withPassSettings(db("pluto_passes")).where("pluto_passes.id", request.params.id).first();
  if (!pass) {
    response.status(404).json({ error: "Pass not found." });
    return;
  }
  const actions = await db("pluto_actions").where({ pass_id: pass.id }).orderBy("created_at");
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(actions.map((action) => String(action.id))), loadPlutoOrderRequestsByActionId(actions.map((action) => String(action.id)))]);
  response.json({ ...serializePass(pass), actions: actions.map((action) => serializeAction(action, realized.get(String(action.id)), orderRequests.get(String(action.id)))) });
});

plutoRouter.get("/actions", async (request: Request, response: Response) => {
  const rows = await db("pluto_actions").orderBy("created_at", "desc").limit(limitFrom(request, 100));
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(rows.map((row) => String(row.id))), loadPlutoOrderRequestsByActionId(rows.map((row) => String(row.id)))]);
  response.json(rows.map((row) => serializeAction(row, realized.get(String(row.id)), orderRequests.get(String(row.id)))));
});

// History's outcome filter, as the stored action outcomes each choice covers.
const outcomesByHistoryFilter: Record<string, string[]> = {
  filled: ["filled", "partially_filled", "cancelled_partially_filled"],
  working: ["confirmed", "order_built", "validated"],
  blocked: ["blocked"],
  cancelled: ["cancelled"],
  rejected: ["rejected", "error"],
};

/**
 * History's Orders, one page: every action but the no-order rows, newest first, as `{ actions, total }` with total counting
 * every match. Filters: ?since=<ISO time>, ?ticker=<text> (the symbol contains it), ?outcome=filled|working|blocked|cancelled|rejected.
 * ?limit and ?offset page it.
 */
plutoRouter.get("/orders", async (request: Request, response: Response) => {
  const since = sinceFrom(request);
  const outcome = typeof request.query.outcome === "string" && request.query.outcome !== "" ? request.query.outcome : null;
  const outcomes = outcome === null ? null : Object.hasOwn(outcomesByHistoryFilter, outcome) ? outcomesByHistoryFilter[outcome] : undefined;
  if (since === undefined || outcomes === undefined) {
    response.status(400).json({ error: `since must be a time and outcome one of: ${Object.keys(outcomesByHistoryFilter).join(", ")}.` });
    return;
  }
  const ticker = tickerSearchFrom(request);
  const filtered = db("pluto_actions").whereNot({ kind: "no_trade" });
  if (since !== null) filtered.where("created_at", ">=", since);
  if (ticker !== "") filtered.whereRaw("strpos(upper(symbol), ?) > 0", [ticker]);
  if (outcomes !== null) filtered.whereIn("outcome", outcomes);
  const [rows, countRows] = await Promise.all([filtered.clone().orderBy("created_at", "desc").orderBy("id", "desc").limit(limitFrom(request, 50)).offset(pageOffsetFrom(request)), filtered.clone().count({ total: "*" })]);
  const [realized, orderRequests] = await Promise.all([loadRealizedPnlByActionId(rows.map((row) => String(row.id))), loadPlutoOrderRequestsByActionId(rows.map((row) => String(row.id)))]);
  response.json({ actions: rows.map((row) => serializeAction(row, realized.get(String(row.id)), orderRequests.get(String(row.id)))), total: Number(countRows[0]?.total ?? 0) });
});

/** The payload keys that tie an event to tickers or to a pass; an event with none of them applies to every ticker. */
const tickerKeys = ["symbol", "symbols", "tickers"];
const tickerAndPassKeys = [...tickerKeys, "passId"];

/**
 * The Event log's query. Filters (all optional, all applied in the query so the page and the total agree):
 * ?categories=a,b keeps those groups, ?types=a,b keeps only those types, ?excludeTypes=a,b leaves those out,
 * ?ticker=XYZ keeps that ticker's trace (see below), ?session=YYYY-MM-DD keeps one Eastern calendar day.
 * ?limit and ?offset page it; the body is `{ events, total }` with total counting every match, not just this page.
 */
plutoRouter.get("/events", async (request: Request, response: Response) => {
  // One comma-separated value, or the parameter repeated (?categories=a&categories=b arrives as an array).
  const listFrom = (value: unknown): string[] => (Array.isArray(value) ? value : [value]).filter((part): part is string => typeof part === "string").flatMap((part) => part.split(",")).filter(Boolean);
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
  if (request.query.categories !== undefined) {
    const typesInCategories = plutoEventTypesInCategories(requestedCategories as PlutoEventCategory[]);
    // A type missing from the map (older or renamed) is labelled "system" below, so System must list it too.
    if (requestedCategories.includes("system")) filtered.where((builder) => builder.whereIn("type", typesInCategories).orWhereNotIn("type", Object.keys(plutoEventCategoryByType)));
    else filtered.whereIn("type", typesInCategories);
  }
  if (onlyTypes.length > 0) filtered.whereIn("type", onlyTypes);
  if (excludedTypes.length > 0) filtered.whereNotIn("type", excludedTypes);
  if (ticker !== "") {
    // A ticker's whole trace: events naming it, every event of a pass that looked at it (the model's call and its
    // no-order result name no ticker themselves), and events that name no ticker and belong to no pass, since those
    // (settings, pauses, breakers) apply to every ticker. An event names its tickers as `symbol`, or as a list under
    // `symbols` / `tickers`; a list's ->> text is its JSON, so one LIKE covers all three.
    // Exact matches only: a list's elements are symbols or { symbol, … } objects (pass_skipped), never free text.
    const namesTicker = `(upper(payload->>'symbol') = ?
      or (jsonb_typeof(payload->'symbols') = 'array' and exists (select 1 from jsonb_array_elements_text(payload->'symbols') listed where upper(listed) = ?))
      or (jsonb_typeof(payload->'tickers') = 'array' and exists (select 1 from jsonb_array_elements(payload->'tickers') listed where upper(case when jsonb_typeof(listed) = 'object' then listed->>'symbol' else listed #>> '{}' end) = ?)))`;
    const namesNoTicker = `not jsonb_exists_any(payload, array[${tickerKeys.map(() => "?").join(", ")}])`;
    filtered.where((builder) => {
      builder
        .whereRaw(namesTicker, [ticker, ticker, ticker])
        // A pass's own events that name no ticker (the model call, its no-order result); its other tickers' actions are theirs.
        .orWhereRaw(`(${namesNoTicker} and payload->>'passId' in (select payload->>'passId' from pluto_events where type = 'pass_started' and ${namesTicker}))`, [...tickerKeys, ticker, ticker, ticker])
        .orWhereRaw(`not jsonb_exists_any(payload, array[${tickerAndPassKeys.map(() => "?").join(", ")}])`, tickerAndPassKeys);
    });
  }
  if (session !== null) filtered.whereRaw("occurred_at >= (?::date)::timestamp at time zone 'America/New_York' and occurred_at < ((?::date) + 1)::timestamp at time zone 'America/New_York'", [session, session]);

  const [rows, countRows] = await Promise.all([filtered.clone().orderBy("occurred_at", "desc").orderBy("id", "desc").limit(limitFrom(request, 200)).offset(offset), filtered.clone().count({ total: "*" })]);
  response.json({
    events: rows.map((row) => ({ id: Number(row.id), occurredAt: new Date(row.occurred_at).toISOString(), type: row.type, category: plutoEventCategoryByType[row.type as keyof typeof plutoEventCategoryByType] ?? "system", appliesToAllTickers: !tickerAndPassKeys.some((key) => key in (row.payload ?? {})), payload: row.payload })),
    total: Number(countRows[0]?.total ?? 0),
  });
});

plutoRouter.get("/tickers", async (_request: Request, response: Response) => {
  const [rows, settings] = await Promise.all([
    db("shortlist_entries as se")
      .join("tickers as t", "t.id", "se.ticker_id")
      .leftJoin("users as u", "u.id", "se.bot_enabled_changed_by_user_id")
      .whereNull("se.removed_at")
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
  const settings = row.version_settings ?? null;
  return {
    id: row.id,
    startedAt: new Date(row.started_at as string).toISOString(),
    finishedAt: row.finished_at ? new Date(row.finished_at as string).toISOString() : null,
    trigger: row.trigger,
    triggerDetail: row.trigger_detail,
    candidateCount: row.candidate_count,
    systemChecks: row.system_checks,
    skippedReason: row.skipped_reason ?? null,
    settingsSnapshot: settings,
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
