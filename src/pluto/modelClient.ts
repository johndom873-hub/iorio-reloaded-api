import { plutoDecisionJsonSchema } from "./decisionSchema.js";

// Pluto's own OpenRouter client (Marcelo, 2026-09-28: OpenRouter so the model is a config value).
// One non-streaming chat completion per call, strict JSON-schema response format, reasoning
// effort passed through, and the served model id and service tier read back from the response for the ledger.
// The model is requested with the :floor variant (Marcelo, 2026-10-06): OpenRouter sorts the model's endpoints by
// price, admits the cheaper flex tier, and moves to the next endpoint when the cheapest is down or at capacity.
// Provider fallbacks only ever change the provider serving the same model, never the model.
// Cost comes from OpenRouter's own usage accounting (usage.include) — no local price table.

const openRouterEndpoint = "https://openrouter.ai/api/v1/chat/completions";

export interface PlutoModelCallInput {
  apiKey: string;
  modelId: string;
  reasoningEffort: "low" | "medium" | "high";
  timeoutSeconds: number;
  systemPrompt: string;
  userPayload: string;
  /** Best-effort reproducibility where the provider honours it. */
  seed?: number;
}

export interface PlutoModelCallResult {
  ok: boolean;
  rawText: string | null;
  servedModelId: string | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** The OpenRouter service tier that served the call (default, flex, priority), when reported. */
  serviceTier: string | null;
  error: string | null;
  httpStatus: number | null;
}

/** "openai/gpt-6-luna" → "openai/gpt-6-luna:floor"; an id that already carries a routing variant is sent as is. */
export function requestedModelId(modelId: string): string {
  return modelId.includes(":") ? modelId : `${modelId}:floor`;
}

interface OpenRouterResponse {
  id?: string;
  model?: string;
  service_tier?: string | null;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  error?: { message?: string; code?: number | string };
}

export async function callPlutoModel(input: PlutoModelCallInput, fetchImpl: typeof fetch = fetch): Promise<PlutoModelCallResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
  const body = {
    model: requestedModelId(input.modelId),
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: input.userPayload },
    ],
    response_format: { type: "json_schema", json_schema: { name: "pluto_decision", strict: true, schema: plutoDecisionJsonSchema } },
    reasoning: { effort: input.reasoningEffort },
    provider: { allow_fallbacks: true },
    usage: { include: true },
    temperature: 0,
    ...(input.seed !== undefined ? { seed: input.seed } : {}),
  };
  try {
    const response = await fetchImpl(openRouterEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}`, "HTTP-Referer": "https://ioriore.com", "X-Title": "Iorio Pluto" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    const text = await response.text();
    let json: OpenRouterResponse;
    try {
      json = JSON.parse(text) as OpenRouterResponse;
    } catch {
      return { ok: false, rawText: text.slice(0, 2000), servedModelId: null, latencyMs, tokensIn: null, tokensOut: null, costUsd: null, serviceTier: null, error: `non-JSON response (${response.status})`, httpStatus: response.status };
    }
    const usage = json.usage ?? {};
    const base = { servedModelId: json.model ?? null, latencyMs, tokensIn: usage.prompt_tokens ?? null, tokensOut: usage.completion_tokens ?? null, costUsd: usage.cost ?? null, serviceTier: json.service_tier ?? null, httpStatus: response.status };
    if (!response.ok || json.error) {
      return { ok: false, rawText: text.slice(0, 2000), error: `OpenRouter ${response.status}: ${json.error?.message ?? text.slice(0, 300)}`, ...base };
    }
    const content = json.choices?.[0]?.message?.content ?? null;
    if (!content) return { ok: false, rawText: text.slice(0, 2000), error: `empty completion (finish_reason ${json.choices?.[0]?.finish_reason ?? "unknown"})`, ...base };
    return { ok: true, rawText: content, error: null, ...base };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, rawText: null, servedModelId: null, latencyMs, tokensIn: null, tokensOut: null, costUsd: null, serviceTier: null, error: aborted ? `timed out after ${input.timeoutSeconds}s` : error instanceof Error ? error.message : String(error), httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}
