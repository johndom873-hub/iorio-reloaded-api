import "dotenv/config";
// Pluto backtest (Marcelo, 2026-09-29). Scores decision-makers on the recorded history: for every
// pass whose offered candidates have settled and been labelled (pluto_candidate_outcomes, the
// approved hold-to-expiry formula), the P&L of the candidate each decision-maker picks.
//
//   npm run pluto:backtest                          # free: the decision as recorded, the Edge $ top pick, best possible, always no-trade
//   npm run pluto:backtest -- --model openai/gpt-6-luna --model ~typesafe/jev-latest   # replays each case through those models (costs money)
//   options: --since 2026-10-01  --limit 200  --allow-partial (score cases with some candidates unlabelled)
//            --current-prompt (today's prompt instead of the stored one)  --json
//
// Read the numbers as a ranking of decision-makers, not as booked P&L: a candidate's label is what
// holding it to expiry would have made at the bid the model saw.
import { db } from "../src/db/connection.js";
import { labelExpiredCandidateOutcomes, loadCandidateOutcomes } from "../src/pluto/candidateOutcomes.js";
import { callJevDecision, isDecisionsModel, jevQuestionsForPayload, plutoDecisionFromJev } from "../src/pluto/decisionsClient.js";
import { parsePlutoDecision, type PlutoDecision } from "../src/pluto/decisionSchema.js";
import { callPlutoModel } from "../src/pluto/modelClient.js";
import { buildPlutoSystemPrompt } from "../src/pluto/prompt.js";
import { loadPlutoPrompt } from "../src/pluto/prompts.js";
import { loadPlutoSettings } from "../src/pluto/settingsStore.js";

interface BacktestCase {
  passId: string;
  label: string;
  payload: Record<string, unknown>;
  offeredIds: Set<string>;
  outcomes: Map<string, number>;
  storedPrompt: string | null;
  recorded: { verdict: string | null; candidateId: string | null; confidence: number | null };
  topPickId: string | null;
}

interface Pick {
  candidateId: string | null;
  confidence: number | null;
  costUsd: number;
  latencyMs: number;
  error: string | null;
}

interface Tally {
  name: string;
  cases: number;
  trades: number;
  scored: number;
  pnl: number;
  wins: number;
  losses: number;
  costUsd: number;
  latencyMs: number;
  errors: number;
  calibration: Map<string, { count: number; wins: number }>;
}

function parseArguments(argv: string[]) {
  const models: string[] = [];
  let since: string | null = null;
  let limit = 500;
  let allowPartial = false;
  let currentPrompt = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    const next = () => argv[++index]!;
    if (argument === "--model") models.push(next());
    else if (argument === "--since") since = next();
    else if (argument === "--limit") limit = Number(next());
    else if (argument === "--allow-partial") allowPartial = true;
    else if (argument === "--current-prompt") currentPrompt = true;
    else if (argument === "--json") json = true;
    else throw new Error(`Unknown argument ${argument}`);
  }
  return { models, since, limit, allowPartial, currentPrompt, json };
}

function collectOfferedIds(payload: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value as Record<string, unknown>)) key === "id" && typeof child === "string" ? ids.add(child) : walk(child);
  };
  walk(payload.tickers);
  return ids;
}

/** Close offers have no hold-to-expiry label; a case is complete when every open/roll id is labelled. */
function labellableIds(payload: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const ticker of Array.isArray(payload.tickers) ? (payload.tickers as Record<string, unknown>[]) : []) {
    for (const candidate of Array.isArray(ticker.candidates) ? (ticker.candidates as Record<string, unknown>[]) : []) if (typeof candidate.id === "string") ids.push(candidate.id);
    for (const roll of Array.isArray(ticker.rolls) ? (ticker.rolls as Record<string, unknown>[]) : []) if (typeof roll.id === "string") ids.push(roll.id);
  }
  return ids;
}

async function loadCases(since: string | null, limit: number, allowPartial: boolean): Promise<{ cases: BacktestCase[]; skippedUnlabelled: number }> {
  let query = db("pluto_decisions as d").join("pluto_passes as p", "p.id", "d.pass_id").where("d.call_index", 1).select("p.id as pass_id", "p.started_at", "p.trigger", "d.input_payload", "d.parsed_output", "d.prompt_id").orderBy("p.started_at", "desc").limit(limit);
  if (since) query = query.where("p.started_at", ">=", since);
  const rows = await query;
  const passIds = rows.map((row) => row.pass_id as string);
  const outcomes = await loadCandidateOutcomes(passIds);
  const topPicks: { pass_id: string; deterministic_top_pick: { id?: string } | null }[] = passIds.length === 0 ? [] : await db("pluto_actions").whereIn("pass_id", passIds).whereNotNull("deterministic_top_pick").select("pass_id", "deterministic_top_pick");
  const prompts = new Map<string, string | null>();
  const cases: BacktestCase[] = [];
  let skippedUnlabelled = 0;
  for (const row of rows) {
    const payload = row.input_payload as Record<string, unknown>;
    const labelled = outcomes.get(row.pass_id) ?? new Map<string, number>();
    const needed = labellableIds(payload);
    const complete = needed.length > 0 && needed.every((id) => labelled.has(id));
    if (!complete && !(allowPartial && labelled.size > 0)) {
      skippedUnlabelled += 1;
      continue;
    }
    if (row.prompt_id && !prompts.has(row.prompt_id)) prompts.set(row.prompt_id, (await loadPlutoPrompt(row.prompt_id))?.content ?? null);
    cases.push({
      passId: row.pass_id,
      label: `${new Date(row.started_at).toISOString().slice(0, 16)} ${row.trigger} ${String(row.pass_id).slice(0, 8)}`,
      payload,
      offeredIds: collectOfferedIds(payload),
      outcomes: labelled,
      storedPrompt: row.prompt_id ? (prompts.get(row.prompt_id) ?? null) : null,
      recorded: { verdict: row.parsed_output?.decision ?? null, candidateId: row.parsed_output?.candidate_id ?? null, confidence: row.parsed_output?.confidence ?? null },
      topPickId: topPicks.find((pick) => pick.pass_id === row.pass_id)?.deterministic_top_pick?.id ?? null,
    });
  }
  return { cases, skippedUnlabelled };
}

function newTally(name: string): Tally {
  return { name, cases: 0, trades: 0, scored: 0, pnl: 0, wins: 0, losses: 0, costUsd: 0, latencyMs: 0, errors: 0, calibration: new Map() };
}

/** No trade scores 0; a trade scores its label; a chosen id without a label is left unscored. */
function score(tally: Tally, backtestCase: BacktestCase, pick: Pick): void {
  tally.cases += 1;
  tally.costUsd += pick.costUsd;
  tally.latencyMs += pick.latencyMs;
  if (pick.error) tally.errors += 1;
  if (pick.candidateId === null) {
    tally.scored += 1;
    return;
  }
  tally.trades += 1;
  const pnl = backtestCase.outcomes.get(pick.candidateId);
  if (pnl === undefined) return;
  tally.scored += 1;
  tally.pnl += pnl;
  if (pnl > 0) tally.wins += 1;
  else tally.losses += 1;
  if (pick.confidence !== null) {
    const bucket = `${(Math.floor(pick.confidence * 5) / 5).toFixed(1)}–${(Math.floor(pick.confidence * 5) / 5 + 0.2).toFixed(1)}`;
    const entry = tally.calibration.get(bucket) ?? { count: 0, wins: 0 };
    entry.count += 1;
    if (pnl > 0) entry.wins += 1;
    tally.calibration.set(bucket, entry);
  }
}

async function modelPick(backtestCase: BacktestCase, modelId: string, systemPrompt: string, effort: "low" | "medium" | "high", timeoutSeconds: number): Promise<Pick> {
  const apiKey = process.env.OPENROUTER_API_KEY!;
  let decision: PlutoDecision | null = null;
  let error: string | null = null;
  let costUsd = 0;
  let latencyMs = 0;
  if (isDecisionsModel(modelId)) {
    const call = await callJevDecision({ apiKey, modelId, state: backtestCase.payload, questions: jevQuestionsForPayload(backtestCase.payload, backtestCase.offeredIds), timeoutSeconds });
    decision = call.answers ? plutoDecisionFromJev(call.answers, backtestCase.offeredIds) : null;
    error = call.error;
    costUsd = call.costUsd ?? 0;
    latencyMs = call.latencyMs;
  } else {
    const call = await callPlutoModel({ apiKey, modelId, reasoningEffort: effort, timeoutSeconds, systemPrompt, userPayload: JSON.stringify(backtestCase.payload), seed: 1 });
    const parsed = call.rawText ? parsePlutoDecision(call.rawText, backtestCase.offeredIds) : null;
    decision = parsed?.ok ? parsed.decision : null;
    error = call.error ?? (parsed && !parsed.ok ? parsed.error : null);
    costUsd = call.costUsd ?? 0;
    latencyMs = call.latencyMs;
  }
  return { candidateId: decision?.decision === "trade" ? decision.candidateId : null, confidence: decision?.confidence ?? null, costUsd, latencyMs, error };
}

function report(tally: Tally) {
  const tradesScored = tally.wins + tally.losses;
  return {
    decisionMaker: tally.name,
    cases: tally.cases,
    scored: tally.scored,
    trades: tally.trades,
    tradeRate: tally.cases === 0 ? "n/a" : `${Math.round((tally.trades / tally.cases) * 100)}%`,
    totalPnl: Math.round(tally.pnl * 100) / 100,
    pnlPerCase: tally.scored === 0 ? 0 : Math.round((tally.pnl / tally.scored) * 100) / 100,
    hitRate: tradesScored === 0 ? "n/a" : `${Math.round((tally.wins / tradesScored) * 100)}%`,
    costUsd: Math.round(tally.costUsd * 10000) / 10000,
    meanLatencyMs: tally.cases === 0 ? 0 : Math.round(tally.latencyMs / tally.cases),
    errors: tally.errors,
    calibration: [...tally.calibration.entries()].sort().map(([bucket, entry]) => `${bucket}: ${entry.wins}/${entry.count} won`).join(" · ") || "n/a",
  };
}

const options = parseArguments(process.argv.slice(2));
const settings = await loadPlutoSettings();
const labelling = await labelExpiredCandidateOutcomes();
const { cases, skippedUnlabelled } = await loadCases(options.since, options.limit, options.allowPartial);
if (!options.json) console.log(`Labelled ${labelling.labelled} new outcome(s) (${labelling.pending} pending expiry). ${cases.length} scorable case(s), ${skippedUnlabelled} skipped for missing labels.`);
if (cases.length === 0) {
  await db.destroy();
  process.exit(0);
}

const tallies: Tally[] = [newTally("recorded decision"), newTally("Edge $ top pick"), newTally("best possible"), newTally("always no-trade")];
for (const backtestCase of cases) {
  score(tallies[0]!, backtestCase, { candidateId: backtestCase.recorded.verdict === "trade" ? backtestCase.recorded.candidateId : null, confidence: backtestCase.recorded.confidence, costUsd: 0, latencyMs: 0, error: null });
  score(tallies[1]!, backtestCase, { candidateId: backtestCase.topPickId, confidence: null, costUsd: 0, latencyMs: 0, error: null });
  const best = [...backtestCase.outcomes.entries()].sort((a, b) => b[1] - a[1])[0];
  score(tallies[2]!, backtestCase, { candidateId: best && best[1] > 0 ? best[0] : null, confidence: null, costUsd: 0, latencyMs: 0, error: null });
  score(tallies[3]!, backtestCase, { candidateId: null, confidence: null, costUsd: 0, latencyMs: 0, error: null });
}
if (options.models.length > 0 && !process.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is required to replay models.");
const todaysPrompt = buildPlutoSystemPrompt(settings);
for (const modelId of options.models) {
  const tally = newTally(modelId);
  for (const backtestCase of cases) {
    const pick = await modelPick(backtestCase, modelId, options.currentPrompt ? todaysPrompt : (backtestCase.storedPrompt ?? todaysPrompt), settings.reasoningEffort, settings.callTimeoutSeconds);
    score(tally, backtestCase, pick);
    if (!options.json) console.log(`${backtestCase.label} · ${modelId} → ${pick.candidateId ?? "no trade"}${pick.candidateId ? ` (${backtestCase.outcomes.get(pick.candidateId) ?? "unlabelled"})` : ""}${pick.error ? ` · ${pick.error}` : ""}`);
  }
  tallies.push(tally);
}
const reports = tallies.map(report);
if (options.json) console.log(JSON.stringify({ cases: cases.length, skippedUnlabelled, reports }, null, 2));
else {
  console.log("\nBacktest (hold-to-expiry labels; no trade = 0)");
  console.table(reports.map(({ calibration, ...rest }) => rest));
  for (const entry of reports) if (entry.calibration !== "n/a") console.log(`${entry.decisionMaker} calibration — ${entry.calibration}`);
}
await db.destroy();
process.exit(0);
