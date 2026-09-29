import "dotenv/config";
// Pluto replay harness (Marcelo, 2026-09-28: needed to evaluate typesafe/jev-1.13 against
// openai/gpt-6-luna, and to compare prompt versions). Re-sends recorded decision payloads to one
// or more OpenRouter models and reports schema validity, latency, cost, served model (silent
// routing shows up here), and agreement with the recorded verdict and the Edge $ top pick.
//
// Usage:
//   npm run pluto:replay -- --latest 20 --model openai/gpt-6-luna --model typesafe/jev-1.13
//   npm run pluto:replay -- --pass <passId> --model typesafe/jev-1.13 --effort low
//   npm run pluto:replay -- --fixture tmp/somePayload.json --model openai/gpt-6-luna
//   add --calls 2 to send two seeded calls per case (agreement rate), --json for machine output,
//   --current-prompt to use today's prompt instead of the one stored with each decision.
//   A typesafe/* model goes to the Decisions API (choice over the offered ids + no_trade).
// Every call costs real money through OPENROUTER_API_KEY; the summary prints the total.
import { readFileSync } from "node:fs";
import { db } from "../src/db/connection.js";
import { parsePlutoDecision, reconcileAgreement, type PlutoDecision } from "../src/pluto/decisionSchema.js";
import { callPlutoModel, type PlutoModelCallResult } from "../src/pluto/modelClient.js";
import { buildPlutoSystemPrompt } from "../src/pluto/prompt.js";
import { callJevDecision, jevQuestionsForPayload, plutoDecisionFromJev } from "../src/pluto/decisionsClient.js";
import { loadPlutoPrompt } from "../src/pluto/prompts.js";
import { loadPlutoSettings } from "../src/pluto/settingsStore.js";

interface ReplayCase {
  label: string;
  payload: Record<string, unknown>;
  /** The system prompt this payload was judged under; null when not recorded (falls back to today's). */
  storedPrompt: string | null;
  recordedVerdict: string | null;
  recordedCandidateId: string | null;
  topPickId: string | null;
}

interface CaseResult {
  caseLabel: string;
  modelId: string;
  ok: boolean;
  servedModelId: string | null;
  latencyMs: number;
  costUsd: number;
  tokensIn: number | null;
  tokensOut: number | null;
  schemaValid: boolean;
  verdict: string | null;
  candidateId: string | null;
  confidence: number | null;
  agreesWithRecorded: boolean | null;
  agreesWithTopPick: boolean | null;
  callsAgreed: boolean | null;
  error: string | null;
}

function parseArguments(argv: string[]) {
  const models: string[] = [];
  let latest = 0;
  let passId: string | null = null;
  let fixture: string | null = null;
  let effort: "low" | "medium" | "high" | null = null;
  let calls = 1;
  let json = false;
  let currentPrompt = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = () => argv[++index];
    if (argument === "--model") models.push(next()!);
    else if (argument === "--latest") latest = Number(next());
    else if (argument === "--pass") passId = next()!;
    else if (argument === "--fixture") fixture = next()!;
    else if (argument === "--effort") effort = next() as "low" | "medium" | "high";
    else if (argument === "--calls") calls = Number(next());
    else if (argument === "--json") json = true;
    else if (argument === "--current-prompt") currentPrompt = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return { models, latest, passId, fixture, effort, calls, json, currentPrompt };
}

/** Every "id" under the payload's tickers is an offered candidate/roll/close id. */
function collectOfferedIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (key === "id" && typeof child === "string") ids.add(child);
        else walk(child);
      }
    }
  };
  walk(payload.tickers);
  return ids;
}

async function loadRecordedCases(latest: number, passId: string | null): Promise<ReplayCase[]> {
  let query = db("pluto_decisions as d").join("pluto_passes as p", "p.id", "d.pass_id").where("d.call_index", 1).select("d.pass_id", "d.input_payload", "d.parsed_output", "d.prompt_id", "p.started_at", "p.trigger").orderBy("p.started_at", "desc");
  query = passId ? query.where("d.pass_id", passId) : query.limit(latest);
  const rows = await query;
  const passIds = rows.map((row) => row.pass_id);
  const topPicks: { pass_id: string; deterministic_top_pick: { id?: string } | null }[] = passIds.length === 0 ? [] : await db("pluto_actions").whereIn("pass_id", passIds).whereNotNull("deterministic_top_pick").select("pass_id", "deterministic_top_pick");
  const prompts = new Map<string, string | null>();
  for (const row of rows) if (row.prompt_id && !prompts.has(row.prompt_id)) prompts.set(row.prompt_id, (await loadPlutoPrompt(row.prompt_id))?.content ?? null);
  return rows.map((row) => ({
    label: `${new Date(row.started_at).toISOString().slice(0, 16)} ${row.trigger} ${String(row.pass_id).slice(0, 8)}`,
    payload: row.input_payload,
    storedPrompt: row.prompt_id ? (prompts.get(row.prompt_id) ?? null) : null,
    recordedVerdict: row.parsed_output?.decision ?? null,
    recordedCandidateId: row.parsed_output?.candidate_id ?? null,
    topPickId: topPicks.find((pick) => pick.pass_id === row.pass_id)?.deterministic_top_pick?.id ?? null,
  }));
}

async function runCase(replayCase: ReplayCase, modelId: string, effort: "low" | "medium" | "high", timeoutSeconds: number, systemPrompt: string, calls: number): Promise<CaseResult> {
  const offeredIds = collectOfferedIds(replayCase.payload);
  const userPayload = JSON.stringify(replayCase.payload);
  const results: { call: Pick<PlutoModelCallResult, "ok" | "servedModelId" | "latencyMs" | "costUsd" | "tokensIn" | "tokensOut">; decision: PlutoDecision | null; error: string | null }[] = [];
  const isDecisionsModel = modelId.startsWith("typesafe/");
  for (let seed = 1; seed <= (isDecisionsModel ? 1 : calls); seed += 1) {
    if (isDecisionsModel) {
      const call = await callJevDecision({ apiKey: process.env.OPENROUTER_API_KEY!, modelId, state: replayCase.payload, questions: jevQuestionsForPayload(replayCase.payload, offeredIds), timeoutSeconds });
      results.push({ call, decision: call.answers ? plutoDecisionFromJev(call.answers, offeredIds) : null, error: call.error });
      continue;
    }
    const call = await callPlutoModel({ apiKey: process.env.OPENROUTER_API_KEY!, modelId, reasoningEffort: effort, timeoutSeconds, systemPrompt, userPayload, seed });
    const parsed = call.rawText ? parsePlutoDecision(call.rawText, offeredIds) : null;
    results.push({ call, decision: parsed?.ok ? parsed.decision : null, error: call.error ?? (parsed && !parsed.ok ? parsed.error : null) });
  }
  const first = results[0]!;
  const decision = first.decision;
  const callsAgreed = results.length >= 2 && results.every((result) => result.decision) ? reconcileAgreement(results[0]!.decision!, results[1]!.decision!).agreed : null;
  return {
    caseLabel: replayCase.label,
    modelId,
    ok: results.every((result) => result.call.ok),
    servedModelId: first.call.servedModelId,
    latencyMs: Math.round(results.reduce((sum, result) => sum + result.call.latencyMs, 0) / results.length),
    costUsd: results.reduce((sum, result) => sum + (result.call.costUsd ?? 0), 0),
    tokensIn: first.call.tokensIn,
    tokensOut: first.call.tokensOut,
    schemaValid: results.every((result) => result.decision !== null),
    verdict: decision?.decision ?? null,
    candidateId: decision?.candidateId ?? null,
    confidence: decision?.confidence ?? null,
    agreesWithRecorded: decision && replayCase.recordedVerdict ? decision.decision === replayCase.recordedVerdict && (decision.candidateId ?? null) === replayCase.recordedCandidateId : null,
    agreesWithTopPick: decision && replayCase.topPickId ? decision.decision === "trade" && decision.candidateId === replayCase.topPickId : null,
    callsAgreed,
    error: results.find((result) => result.error)?.error ?? null,
  };
}

function summarize(results: CaseResult[], modelId: string) {
  const mine = results.filter((result) => result.modelId === modelId);
  const rate = (predicate: (result: CaseResult) => boolean | null) => {
    const applicable = mine.filter((result) => predicate(result) !== null);
    return applicable.length === 0 ? "n/a" : `${Math.round((applicable.filter((result) => predicate(result) === true).length / applicable.length) * 100)}% of ${applicable.length}`;
  };
  return {
    modelId,
    cases: mine.length,
    servedModels: [...new Set(mine.map((result) => result.servedModelId ?? "?"))].join(", "),
    schemaValid: rate((result) => result.schemaValid),
    meanLatencyMs: mine.length === 0 ? 0 : Math.round(mine.reduce((sum, result) => sum + result.latencyMs, 0) / mine.length),
    totalCostUsd: Math.round(mine.reduce((sum, result) => sum + result.costUsd, 0) * 10000) / 10000,
    agreesWithRecorded: rate((result) => result.agreesWithRecorded),
    agreesWithTopPick: rate((result) => result.agreesWithTopPick),
    callsAgreed: rate((result) => result.callsAgreed),
    tradeRate: rate((result) => (result.verdict === null ? null : result.verdict === "trade")),
  };
}

const options = parseArguments(process.argv.slice(2));
if (!process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required.");
const settings = await loadPlutoSettings();
const models = options.models.length > 0 ? options.models : [settings.modelId];
const effort = options.effort ?? settings.reasoningEffort;
const systemPrompt = buildPlutoSystemPrompt(settings);

let cases: ReplayCase[];
if (options.fixture) {
  const payload = JSON.parse(readFileSync(options.fixture, "utf-8")) as Record<string, unknown>;
  cases = [{ label: options.fixture, payload, storedPrompt: null, recordedVerdict: null, recordedCandidateId: null, topPickId: null }];
} else {
  cases = await loadRecordedCases(options.latest || 10, options.passId);
}
if (cases.length === 0) throw new Error("No recorded decisions to replay (Pluto has not called the model yet); use --fixture.");

const results: CaseResult[] = [];
for (const replayCase of cases) {
  for (const modelId of models) {
    const result = await runCase(replayCase, modelId, effort, settings.callTimeoutSeconds, options.currentPrompt ? systemPrompt : (replayCase.storedPrompt ?? systemPrompt), options.calls);
    results.push(result);
    if (!options.json) console.log(`${result.caseLabel} · ${modelId} → ${result.ok ? "" : "HTTP FAIL "}${result.schemaValid ? "valid" : "INVALID"} · ${result.verdict ?? "—"}${result.candidateId ? ` ${result.candidateId}` : ""} · conf ${result.confidence ?? "—"} · ${result.latencyMs} ms · $${result.costUsd.toFixed(4)} · served ${result.servedModelId ?? "?"}${result.error ? ` · ${result.error}` : ""}`);
  }
}
const summaries = models.map((modelId) => summarize(results, modelId));
if (options.json) console.log(JSON.stringify({ effort, promptVersion: settings.promptVersion, results, summaries }, null, 2));
else {
  console.log("\nSummary");
  console.table(summaries);
}
await db.destroy();
process.exit(0);
