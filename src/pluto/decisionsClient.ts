import { kindFromCandidateId, type PlutoDecision } from "./decisionSchema.js";

// TypeSafe Jev through OpenRouter's Decisions API (alpha): one forward pass that answers typed
// questions about a `state` with calibrated probabilities, no text. Evaluated 2026-09-29; used by
// the replay/backtest tooling, not by the live loop (Marcelo's call pending shadow-mode results).

export const openRouterDecisionsUrl = "https://openrouter.ai/api/alpha/decisions";

/** The alias OpenRouter resolves to the newest Jev; the response still names the exact version served, which the ledger records. */
export const jevLatestModelId = "~typesafe/jev-latest";

/** Pure: a model id that must go to the Decisions API rather than chat/completions ("typesafe/jev-1.13", "~typesafe/jev-latest"). */
export function isDecisionsModel(modelId: string): boolean {
  return modelId.replace(/^~/, "").startsWith("typesafe/");
}

export interface JevQuestions {
  [name: string]: { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string } | { type: "score"; instructions: string; criteria: string[] };
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface JevNoulAnswer {
  type: "noul";
  noul: number;
}
export interface JevScoreAnswer {
  type: "score";
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JevAnswer = JevChoiceAnswer | JevNoulAnswer | JevScoreAnswer;

export interface JevCallResult {
  ok: boolean;
  servedModelId: string | null;
  answers: Record<string, JevAnswer> | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  error: string | null;
  httpStatus: number | null;
}

export async function callJevDecision(input: { apiKey: string; modelId: string; state: unknown; questions: JevQuestions; timeoutSeconds: number }, fetchImpl: typeof fetch = fetch): Promise<JevCallResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutSeconds * 1000);
  try {
    const response = await fetchImpl(openRouterDecisionsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: input.modelId, state: input.state, questions: input.questions }),
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => null)) as { model?: string; answers?: Record<string, JevAnswer>; usage?: { input_tokens?: number; output_tokens?: number; cost?: number }; error?: { message?: string } } | null;
    // After the body, as in modelClient: headers can arrive long before the answer.
    const latencyMs = Date.now() - startedAt;
    if (!response.ok || !json?.answers) {
      return { ok: false, servedModelId: json?.model ?? null, answers: null, latencyMs, tokensIn: null, tokensOut: null, costUsd: null, error: `OpenRouter decisions ${response.status}: ${json?.error?.message ?? "no answers"}`, httpStatus: response.status };
    }
    return { ok: true, servedModelId: json.model ?? null, answers: json.answers, latencyMs, tokensIn: json.usage?.input_tokens ?? null, tokensOut: json.usage?.output_tokens ?? null, costUsd: json.usage?.cost ?? null, error: null, httpStatus: response.status };
  } catch (error) {
    return { ok: false, servedModelId: null, answers: null, latencyMs: Date.now() - startedAt, tokensIn: null, tokensOut: null, costUsd: null, error: error instanceof Error ? error.message : String(error), httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Pure: Pluto's decision as a Jev question set — a choice over the offered ids plus no_trade, and a stand-aside noul. */
export function jevQuestionsForPayload(payload: Record<string, unknown>, offeredIds: ReadonlySet<string>): JevQuestions {
  const criteria: Record<string, string> = {};
  const tickers = Array.isArray(payload.tickers) ? (payload.tickers as Record<string, unknown>[]) : [];
  for (const ticker of tickers) {
    for (const candidate of Array.isArray(ticker.candidates) ? (ticker.candidates as Record<string, unknown>[]) : []) {
      if (typeof candidate.id === "string" && offeredIds.has(candidate.id)) criteria[candidate.id] = `Open ${String(candidate.kind ?? "").replace("open_", "").replace(/_/g, " ")} on ${String(ticker.symbol)}: $${String(candidate.strike)} expiring ${String(candidate.expiry)}`;
    }
    for (const roll of Array.isArray(ticker.rolls) ? (ticker.rolls as Record<string, unknown>[]) : []) {
      if (typeof roll.id === "string" && offeredIds.has(roll.id)) criteria[roll.id] = `Roll the held ${String(ticker.symbol)} leg into $${String((roll.replacement as Record<string, unknown> | undefined)?.strike)} expiring ${String((roll.replacement as Record<string, unknown> | undefined)?.expiry)}`;
    }
    for (const close of Array.isArray(ticker.close_actions) ? (ticker.close_actions as Record<string, unknown>[]) : []) {
      if (typeof close.id === "string" && offeredIds.has(close.id)) criteria[close.id] = String(close.description ?? close.id);
    }
  }
  criteria.no_trade = "Do nothing this pass";
  return {
    action: {
      type: "choice",
      instructions:
        "You are a disciplined short-premium options trader following the parameters in `parameters`. Prefer candidates with high net_edge_vp and edge_dollars, tight spread_pct, solid oi and vol, delta inside the band, and no earnings or macro event before expiry; a roll needs a clearly positive net_roll_edge_vp. Choose no_trade when nothing is clearly attractive or the account is near its limits.",
      criteria,
    },
    system_concern: { type: "noul", instructions: "The `account`, `market` or `session` state argues for standing aside this pass regardless of the candidates." },
  };
}

/** Pure: Jev's answers as a PlutoDecision the rest of the pipeline understands. Reasons carry the probabilities, since Jev gives no prose. */
export function plutoDecisionFromJev(answers: Record<string, JevAnswer>, offeredIds: ReadonlySet<string>): PlutoDecision {
  const action = answers.action;
  const concern = answers.system_concern;
  const concernProbability = concern && concern.type === "noul" ? concern.noul : null;
  if (!action || action.type !== "choice") {
    return { decision: "no_trade", actionKind: null, candidateId: null, confidence: 0, reasons: ["jev: no choice answer"], risksAcknowledged: [], systemConcerns: [] };
  }
  const probability = action.probabilities[action.choice] ?? 0;
  const summary = `jev: ${action.choice} p=${probability.toFixed(2)} confidence=${action.confidence.toFixed(2)}${concernProbability !== null ? ` stand_aside=${concernProbability.toFixed(2)}` : ""}`;
  if (concernProbability !== null && concernProbability >= 0.5) {
    return { decision: "abstain_system_concern", actionKind: null, candidateId: null, confidence: concernProbability, reasons: [summary], risksAcknowledged: [], systemConcerns: [{ symbol: null, concern: `jev stand-aside probability ${concernProbability.toFixed(2)}` }] };
  }
  if (action.choice === "no_trade" || !offeredIds.has(action.choice)) {
    return { decision: "no_trade", actionKind: null, candidateId: null, confidence: action.confidence, reasons: [summary], risksAcknowledged: [], systemConcerns: [] };
  }
  return { decision: "trade", actionKind: kindFromCandidateId(action.choice), candidateId: action.choice, confidence: action.confidence, reasons: [summary], risksAcknowledged: [], systemConcerns: [] };
}
