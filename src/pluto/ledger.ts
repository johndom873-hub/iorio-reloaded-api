import { db } from "../db/connection.js";
import { publishNotification } from "../lib/notificationChannel.js";

// Pluto's decision ledger: the audit trail, the screen's feed and the Phase 2 dataset in one
// place. One pass row per evaluation, one decision row per model call, one action row per
// concrete outcome (including "no_trade"), and a timeline of events. Writers only; the
// routes read.

export type PlutoTrigger = "opening_look" | "spot_move" | "grade_crossing" | "day_quotes" | "held_leg" | "manual" | "housekeeping" | "settings_changed";

export interface PlutoSystemCheck {
  ok: boolean;
  detail: string;
}

export interface PlutoPassRow {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  trigger: PlutoTrigger;
  triggerDetail: Record<string, unknown>;
  inputHash: string | null;
  candidateCount: number;
  systemChecks: Record<string, PlutoSystemCheck>;
  modelCalled: boolean;
  skippedReason: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  servedModelIds: string[];
}

export async function startPlutoPass(trigger: PlutoTrigger, triggerDetail: Record<string, unknown> = {}, settingsSnapshot: unknown = null): Promise<string> {
  const [row] = await db("pluto_passes").insert({ trigger, trigger_detail: JSON.stringify(triggerDetail), settings_snapshot: settingsSnapshot === null ? null : JSON.stringify(settingsSnapshot) }).returning("id");
  return row.id as string;
}

/** The poll pass found out what it really was (a grade crossing or a held-leg change): rename it before the model is called. */
export async function relabelPlutoPass(passId: string, trigger: PlutoTrigger, triggerDetail: Record<string, unknown>): Promise<void> {
  await db("pluto_passes").where({ id: passId }).update({ trigger, trigger_detail: JSON.stringify(triggerDetail) });
}

/** Timeline retention (built 2026-09-28, Marcelo to veto the number): events older than this are pruned once a day; passes, decisions and actions are the ledger and are kept. */
export const plutoEventsRetentionDays = 90;

export async function pruneOldPlutoEvents(now: Date = new Date()): Promise<number> {
  return db("pluto_events").where("occurred_at", "<", new Date(now.getTime() - plutoEventsRetentionDays * 24 * 60 * 60 * 1000)).del();
}

export interface FinishPlutoPassInput {
  inputHash?: string | null;
  candidateCount?: number;
  systemChecks?: Record<string, PlutoSystemCheck>;
  modelCalled?: boolean;
  skippedReason?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  servedModelIds?: string[];
}

export async function finishPlutoPass(passId: string, input: FinishPlutoPassInput): Promise<void> {
  await db("pluto_passes")
    .where({ id: passId })
    .update({
      finished_at: db.fn.now(),
      ...(input.inputHash !== undefined ? { input_hash: input.inputHash } : {}),
      ...(input.candidateCount !== undefined ? { candidate_count: input.candidateCount } : {}),
      ...(input.systemChecks !== undefined ? { system_checks: JSON.stringify(input.systemChecks) } : {}),
      ...(input.modelCalled !== undefined ? { model_called: input.modelCalled } : {}),
      ...(input.skippedReason !== undefined ? { skipped_reason: input.skippedReason } : {}),
      ...(input.tokensIn !== undefined ? { tokens_in: input.tokensIn } : {}),
      ...(input.tokensOut !== undefined ? { tokens_out: input.tokensOut } : {}),
      ...(input.costUsd !== undefined ? { cost_usd: input.costUsd } : {}),
      ...(input.servedModelIds !== undefined ? { served_model_ids: input.servedModelIds } : {}),
    });
}

export interface RecordPlutoDecisionInput {
  passId: string;
  callIndex: number;
  modelId: string;
  servedModelId: string | null;
  inputPayload: unknown;
  rawOutput: string | null;
  parsedOutput: unknown | null;
  schemaValid: boolean;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
  /** pluto_prompts row of the exact system prompt used (null for a call that never built one). */
  promptId?: string | null;
}

export async function recordPlutoDecision(input: RecordPlutoDecisionInput): Promise<string> {
  const [row] = await db("pluto_decisions")
    .insert({
      pass_id: input.passId,
      call_index: input.callIndex,
      model_id: input.modelId,
      served_model_id: input.servedModelId,
      prompt_id: input.promptId ?? null,
      input_payload: JSON.stringify(input.inputPayload),
      raw_output: input.rawOutput,
      parsed_output: input.parsedOutput === null ? null : JSON.stringify(input.parsedOutput),
      schema_valid: input.schemaValid,
      latency_ms: input.latencyMs,
      tokens_in: input.tokensIn,
      tokens_out: input.tokensOut,
      cost_usd: input.costUsd,
      error: input.error,
    })
    .returning("id");
  return row.id as string;
}

export type PlutoActionKind = "open_covered_call" | "open_cash_secured_put" | "roll" | "close_shares" | "close_leg" | "no_trade";
export type PlutoActionOutcome = "validated" | "blocked" | "order_built" | "confirmed" | "filled" | "partially_filled" | "cancelled" | "rejected" | "error" | "no_trade";

export interface PlutoGateResult {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface RecordPlutoActionInput {
  passId: string;
  kind: PlutoActionKind;
  symbol: string;
  tickerId: string | null;
  contract: unknown | null;
  candidateScores: unknown | null;
  deterministicTopPick: unknown | null;
  gateResults: PlutoGateResult[];
  sizeTier: string | null;
  quantity: number | null;
  limitPrice: number | null;
  outcome: PlutoActionOutcome;
  blockReason: string | null;
  referenceBid: number | null;
  referenceMid: number | null;
}

export async function recordPlutoAction(input: RecordPlutoActionInput): Promise<string> {
  const [row] = await db("pluto_actions")
    .insert({
      pass_id: input.passId,
      kind: input.kind,
      symbol: input.symbol,
      ticker_id: input.tickerId,
      contract: input.contract === null ? null : JSON.stringify(input.contract),
      candidate_scores: input.candidateScores === null ? null : JSON.stringify(input.candidateScores),
      deterministic_top_pick: input.deterministicTopPick === null ? null : JSON.stringify(input.deterministicTopPick),
      gate_results: JSON.stringify(input.gateResults),
      size_tier: input.sizeTier,
      quantity: input.quantity,
      limit_price: input.limitPrice,
      outcome: input.outcome,
      block_reason: input.blockReason,
      reference_bid: input.referenceBid,
      reference_mid: input.referenceMid,
    })
    .returning("id");
  return row.id as string;
}

export interface UpdatePlutoActionInput {
  outcome?: PlutoActionOutcome;
  blockReason?: string | null;
  orderRequestId?: string | null;
  gateResults?: PlutoGateResult[];
  fillPrice?: number | null;
  pessimisticPnl?: number | null;
  realizedPnl?: number | null;
  evaluatedAt?: Date | null;
}

export async function updatePlutoAction(actionId: string, input: UpdatePlutoActionInput): Promise<void> {
  await db("pluto_actions")
    .where({ id: actionId })
    .update({
      updated_at: db.fn.now(),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      ...(input.blockReason !== undefined ? { block_reason: input.blockReason } : {}),
      ...(input.orderRequestId !== undefined ? { order_request_id: input.orderRequestId } : {}),
      ...(input.gateResults !== undefined ? { gate_results: JSON.stringify(input.gateResults) } : {}),
      ...(input.fillPrice !== undefined ? { fill_price: input.fillPrice } : {}),
      ...(input.pessimisticPnl !== undefined ? { pessimistic_pnl: input.pessimisticPnl } : {}),
      ...(input.realizedPnl !== undefined ? { realized_pnl: input.realizedPnl } : {}),
      ...(input.evaluatedAt !== undefined ? { evaluated_at: input.evaluatedAt } : {}),
    });
}

export type PlutoEventType =
  | "agent_started"
  | "agent_stopped"
  | "pass_started"
  | "pass_skipped"
  | "model_called"
  | "model_failed"
  | "action_validated"
  | "action_blocked"
  | "order_built"
  | "order_confirmed"
  | "order_outcome"
  | "no_trade"
  | "paused"
  | "resumed"
  | "breaker_tripped"
  | "breaker_reset"
  | "mode_changed"
  | "settings_changed"
  | "ticker_enabled"
  | "ticker_disabled"
  | "lines_changed"
  | "session_schedule"
  | "stress_override_changed"
  | "warning";

/** Appends to the timeline and pushes a `pluto_event` notification so open screens update live. */
export async function recordPlutoEvent(type: PlutoEventType, payload: Record<string, unknown> = {}): Promise<void> {
  const [row] = await db("pluto_events").insert({ type, payload: JSON.stringify(payload) }).returning(["id", "occurred_at"]);
  await publishNotification({ type: "pluto_event", eventId: Number(row.id), eventType: type, occurredAt: new Date(row.occurred_at).toISOString(), payload });
}
