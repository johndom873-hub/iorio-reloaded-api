import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { parsePlutoDecision, type ParsedPlutoDecision } from "../../pluto/decisionSchema.js";
import { backtestClaudeModel, backtestClaudeReasoningEffort, callClaudeSubscriptionModel, type ClaudeSubscriptionCallInput, type ClaudeSubscriptionCallResult } from "./claudeSubscriptionModelClient.js";
import { maskPlutoText, unmaskPlutoText, type PlutoPromptMasking } from "./plutoPromptMasking.js";

// One decision in the backtest's LLM mode: the payload masked, answered from the cache when exactly this question was
// asked before, otherwise by Claude through the subscription; the answer unmasked and read by Pluto's own parser against
// the real candidate ids; the call logged on the session. A failed call is never cached. One that the subscription
// rather than the model caused stops the session (Marcelo 2026-10-12), so it can resume later without losing or repeating
// a call: the plan's limit and a CLI that cannot run at once, a passing failure after its retries. Only the model
// answering without the decision's shape counts as live counts a failed call: no trade.

export type SessionLlmCallOutcome = "decided" | "invalid_answer" | "call_failed" | "usage_limit";

type PlutoDecision = Extract<ParsedPlutoDecision, { ok: true }>["decision"];

export interface AskPlutoThroughSubscriptionInput {
  connection: Knex;
  cliPath: string;
  workingDirectory: string;
  timeoutSeconds: number;
  systemPrompt: string;
  /** The live prompt payload, in real symbols and dates. */
  payload: unknown;
  masking: PlutoPromptMasking;
  offeredIds: ReadonlySet<string>;
  sessionId: string;
  /** The call's place in the session; a resumed session that asks again overwrites its own row. */
  sequence: number;
  tradingDate: string;
  lookTime: string;
}

export interface AskPlutoThroughSubscriptionResult {
  outcome: SessionLlmCallOutcome;
  decision: PlutoDecision | null;
  cacheHit: boolean;
  error: string | null;
  /** Why the session must stop here and be resumed later; null when it goes on. */
  stopSessionBecause: string | null;
}

export type ClaudeCall = (input: ClaudeSubscriptionCallInput) => Promise<ClaudeSubscriptionCallResult>;

/** Waits before each retry of a passing failure (Marcelo 2026-10-12): three retries, then the session stops. */
export const passingFailureRetryDelaysSeconds: readonly number[] = [10, 30, 90];

export interface AskPlutoRetryOptions {
  retryDelaysSeconds?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
}

const sleepFor = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export function computeLlmRequestHash(systemPrompt: string, maskedPayloadText: string): string {
  return createHash("sha256").update(JSON.stringify([backtestClaudeModel, backtestClaudeReasoningEffort, systemPrompt, maskedPayloadText])).digest("hex");
}

export async function askPlutoThroughSubscription(
  input: AskPlutoThroughSubscriptionInput,
  callModel: ClaudeCall = callClaudeSubscriptionModel,
  retry: AskPlutoRetryOptions = {},
): Promise<AskPlutoThroughSubscriptionResult> {
  const retryDelaysSeconds = retry.retryDelaysSeconds ?? passingFailureRetryDelaysSeconds;
  const sleep = retry.sleep ?? sleepFor;
  const maskedPayloadText = maskPlutoText(JSON.stringify(input.payload), input.masking);
  const requestHash = computeLlmRequestHash(input.systemPrompt, maskedPayloadText);
  const cached: { raw_output: string } | undefined = await input.connection("backtest_llm_calls").where({ request_hash: requestHash }).first("raw_output");

  let rawOutput: string | null = cached?.raw_output ?? null;
  let failure: { outcome: "call_failed" | "usage_limit"; error: string; stopSessionBecause: string | null } | null = null;
  if (!cached) {
    const ask = () => callModel({ cliPath: input.cliPath, workingDirectory: input.workingDirectory, timeoutSeconds: input.timeoutSeconds, systemPrompt: input.systemPrompt, userPayload: maskedPayloadText });
    let call = await ask();
    for (let retryIndex = 0; !call.ok && call.failureKind === "transient" && retryIndex < retryDelaysSeconds.length; retryIndex++) {
      await sleep(retryDelaysSeconds[retryIndex]! * 1000);
      call = await ask();
    }
    if (call.ok && call.rawText) {
      rawOutput = call.rawText;
      await input.connection("backtest_llm_calls")
        .insert({
          request_hash: requestHash,
          model: backtestClaudeModel,
          reasoning_effort: backtestClaudeReasoningEffort,
          system_prompt_hash: createHash("sha256").update(input.systemPrompt).digest("hex"),
          masked_payload: maskedPayloadText,
          raw_output: call.rawText,
          served_model_id: call.servedModelId,
          tokens_in: call.tokensIn,
          tokens_out: call.tokensOut,
          api_equivalent_cost_usd: call.costUsd,
          latency_ms: call.latencyMs,
        })
        .onConflict("request_hash")
        .ignore();
    } else {
      const error = call.error ?? "no answer";
      const stopSessionBecause =
        call.failureKind === "usage_limit"
          ? "Claude usage limit reached"
          : call.failureKind === "fatal"
            ? "the Claude CLI cannot run"
            : call.failureKind === "transient"
              ? `Claude did not answer after ${retryDelaysSeconds.length} retries`
              : null;
      failure = { outcome: call.failureKind === "usage_limit" ? "usage_limit" : "call_failed", error, stopSessionBecause };
    }
  }

  const parsed = rawOutput === null ? null : parsePlutoDecision(unmaskPlutoText(rawOutput, input.masking), input.offeredIds);
  const decision = parsed?.ok ? parsed.decision : null;
  const outcome: SessionLlmCallOutcome = failure?.outcome ?? (decision ? "decided" : "invalid_answer");
  const error = failure?.error ?? (parsed && !parsed.ok ? `invalid decision: ${parsed.error}` : null);

  await input.connection("backtest_session_llm_calls")
    .insert({
      session_id: input.sessionId,
      sequence: input.sequence,
      trading_date: input.tradingDate,
      look_time: input.lookTime,
      request_hash: requestHash,
      llm_call_id: rawOutput === null ? null : requestHash,
      cache_hit: cached !== undefined,
      outcome,
      decision: decision ? JSON.stringify(decision) : null,
      error,
    })
    .onConflict(["session_id", "sequence"])
    .merge();

  return { outcome, decision, cacheHit: cached !== undefined, error, stopSessionBecause: failure?.stopSessionBecause ?? null };
}
