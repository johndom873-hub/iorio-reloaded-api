import { Router, type Request, type Response } from "express";
import { db } from "../db/connection.js";
import { loadPlutoBook } from "../pluto/book.js";
import { resolvePlutoSession } from "../pluto/sessionSchedule.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { loadPlutoSettings, loadPlutoSettingsAudit, PlutoSettingsValidationError, updatePlutoSettings, type PlutoSettingsInput } from "../pluto/settingsStore.js";
import { describePlutoBlock, loadPlutoState, pausePluto, PlutoStateError, resetPlutoBreaker, resumePluto, setPlutoMode, type PlutoMode } from "../pluto/stateStore.js";
import { recordPlutoEvent } from "../pluto/ledger.js";
import { cancelPlutoOrders, countPlutoWorkingOrders } from "../pluto/orders.js";
import { loadPlutoTodayCounters } from "../pluto/counters.js";

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
  const [state, settings, working, counters, agentHealth, enabledCount, book, lastSnapshot] = await Promise.all([
    loadPlutoState(),
    loadPlutoSettings(),
    countPlutoWorkingOrders(),
    loadPlutoTodayCounters(),
    db("worker_health").where({ process_name: "pluto_agent" }).first(),
    db("shortlist_entries").whereNull("removed_at").where({ bot_enabled: true }).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0)),
    loadPlutoBook(),
    db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first("net_liquidation_value", "snapshot_date"),
  ]);
  // The book tile uses last night's NLV (no IBKR round trip on a screen load); the agent's passes use the live figure.
  const netLiquidationValue = lastSnapshot ? Number(lastSnapshot.net_liquidation_value) : null;
  response.json({
    ...state,
    blockReason: describePlutoBlock(state),
    orders: working,
    counters: { ...counters, maxActionsPerSession: settings.maxActionsPerSession, maxModelCallsPerSession: settings.maxModelCallsPerSession, dailyCostCeilingUsd: settings.dailyCostCeilingUsd },
    enabledTickers: { count: enabledCount, max: settings.maxEnabledTickers },
    session: await resolvePlutoSession(new Date(), settings),
    book: {
      committedDollars: book.committedDollars,
      openPositionCount: book.openPositions.length,
      openSymbols: [...book.openSymbols].sort(),
      workingOrderSymbols: [...book.workingOrderSymbols].sort(),
      netLiquidationValue,
      netLiquidationValueAsOf: lastSnapshot ? String(lastSnapshot.snapshot_date).slice(0, 10) : null,
      capitalBudgetPct: settings.capitalBudgetPct,
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
  await notifyTelegram(mode === "on" ? `🪐 Pluto switched ON by ${who}${state.paused ? " (still paused — press Resume to let it act)" : ""}.` : `🪐 Pluto switched OFF by ${who}.`);
  response.json(state);
});

plutoRouter.post("/pause", async (request: Request, response: Response) => {
  const cancelWorkingOrders = request.body?.cancelWorkingOrders === true;
  const userId = currentUserId(request);
  const who = await currentUserDisplayName(request);
  const state = await pausePluto("manual", { userId });
  const cancelled = await cancelPlutoOrders(userId, { includeWorking: cancelWorkingOrders });
  await recordPlutoEvent("paused", { by: who, cancelWorkingOrders, cancelledLocally: cancelled.cancelledLocally.length, cancelRequested: cancelled.cancelRequested.length });
  await notifyTelegram(
    `⏸️ Pluto paused by ${who}.${cancelled.cancelledLocally.length > 0 ? ` Dropped ${cancelled.cancelledLocally.length} unsent order(s).` : ""}${cancelWorkingOrders ? ` Cancel requested for ${cancelled.cancelRequested.length} working order(s).` : ""}`,
  );
  response.json({ ...state, cancelled });
});

plutoRouter.post("/resume", async (request: Request, response: Response) => {
  const who = await currentUserDisplayName(request);
  try {
    const state = await resumePluto(currentUserId(request));
    await recordPlutoEvent("resumed", { by: who });
    await notifyTelegram(`▶️ Pluto resumed by ${who}${state.mode === "off" ? " (mode is off, so it will not act until switched on)" : ""}.`);
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
  await notifyTelegram(`🔧 Pluto breaker "${name}" reset by ${who}. Pluto stays paused until resumed.`);
  response.json(state);
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

plutoRouter.get("/passes", async (request: Request, response: Response) => {
  const rows = await db("pluto_passes").orderBy("started_at", "desc").limit(limitFrom(request, 50));
  const passIds = rows.map((row) => row.id);
  const [decisions, actions] = passIds.length === 0 ? [[], []] : await Promise.all([
    db("pluto_decisions").whereIn("pass_id", passIds).orderBy("call_index"),
    db("pluto_actions").whereIn("pass_id", passIds).orderBy("created_at"),
  ]);
  response.json(
    rows.map((row) => ({
      ...serializePass(row),
      // Compact per-call summary for the Decisions card (the full input payload stays on GET /passes/:id).
      decisions: decisions.filter((decision) => decision.pass_id === row.id).map((decision) => ({ callIndex: decision.call_index, servedModelId: decision.served_model_id ?? null, parsedOutput: decision.parsed_output ?? null, schemaValid: Boolean(decision.schema_valid), latencyMs: decision.latency_ms ?? null, costUsd: decision.cost_usd === null ? null : Number(decision.cost_usd), error: decision.error ?? null })),
      actions: actions.filter((action) => action.pass_id === row.id).map(serializeAction),
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
  response.json({ ...serializePass(pass), decisions: decisions.map(serializeDecision), actions: actions.map(serializeAction) });
});

plutoRouter.get("/actions", async (request: Request, response: Response) => {
  const rows = await db("pluto_actions").orderBy("created_at", "desc").limit(limitFrom(request, 100));
  response.json(rows.map(serializeAction));
});

plutoRouter.get("/events", async (request: Request, response: Response) => {
  const rows = await db("pluto_events").orderBy("occurred_at", "desc").limit(limitFrom(request, 200));
  response.json(rows.map((row) => ({ id: Number(row.id), occurredAt: new Date(row.occurred_at).toISOString(), type: row.type, payload: row.payload })));
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
  };
}

function serializeDecision(row: Record<string, unknown>) {
  return {
    id: row.id,
    passId: row.pass_id,
    callIndex: row.call_index,
    modelId: row.model_id,
    servedModelId: row.served_model_id ?? null,
    inputPayload: row.input_payload,
    rawOutput: row.raw_output ?? null,
    parsedOutput: row.parsed_output ?? null,
    schemaValid: Boolean(row.schema_valid),
    latencyMs: row.latency_ms ?? null,
    tokensIn: row.tokens_in ?? null,
    tokensOut: row.tokens_out ?? null,
    costUsd: row.cost_usd === null || row.cost_usd === undefined ? null : Number(row.cost_usd),
    error: row.error ?? null,
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

function serializeAction(row: Record<string, unknown>) {
  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
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
    pessimisticPnl: num(row.pessimistic_pnl),
    realizedPnl: num(row.realized_pnl),
    evaluatedAt: row.evaluated_at ? new Date(row.evaluated_at as string).toISOString() : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}
