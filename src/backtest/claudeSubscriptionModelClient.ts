import { spawn as spawnProcess } from "node:child_process";

// Claude through Marcelo's subscription, not the API (Marcelo 2026-10-12), for the Analyse window's Summary and
// Recommendation (analysisSummary.ts): the Claude Code CLI run headless (the sgtechno pattern), on the CLI's own
// subscription login, with a strict JSON schema for the answer. Claude Code's own prompt, tools, MCP servers, skills and
// settings files are left out so the call carries the caller's prompt and little else. Cost is the CLI's API-equivalent
// figure: nothing is billed, it counts toward the plan's usage limits.

export type ClaudeReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeSubscriptionCallInput {
  cliPath: string;
  /** Working directory for the CLI: an empty folder, so no project instructions are picked up. */
  workingDirectory: string;
  timeoutSeconds: number;
  systemPrompt: string;
  userPayload: string;
  /** The answer's JSON schema. */
  jsonSchema: object;
  /** The model ("sonnet", "claude-opus-5-5") and its effort. */
  model: string;
  effort: ClaudeReasoningEffort;
}

/**
 * Why a call failed: the plan's limit; a CLI that cannot run (every later call would fail the same way); a failure that
 * passes (overloaded, rate limited, a timeout, the CLI crashing); or the model answering without the schema's shape.
 */
export type ClaudeCallFailureKind = "usage_limit" | "fatal" | "transient" | "answer";

export interface ClaudeSubscriptionCallResult {
  ok: boolean;
  /** The structured answer as JSON text; on a failure, whatever the CLI printed, when anything. */
  rawText: string | null;
  servedModelId: string | null;
  latencyMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  /** "subscription" once the CLI answered; null when it printed no envelope. */
  serviceTier: string | null;
  error: string | null;
  /** Always null: the CLI reports no HTTP status. */
  httpStatus: number | null;
  /** The plan's usage limit stopped the call. */
  usageLimitReached: boolean;
  /** Null when the call answered. */
  failureKind: ClaudeCallFailureKind | null;
}

interface ProcessHandle {
  stdin: { write(text: string): void; end(): void };
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  stderr: { on(event: "data", listener: (chunk: Buffer | string) => void): void };
  on(event: "close", listener: (exitCode: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  kill(signal: NodeJS.Signals): void;
}

export type SpawnClaudeCli = (cliPath: string, args: string[], workingDirectory: string) => ProcessHandle;

const spawnClaudeCli: SpawnClaudeCli = (cliPath, args, workingDirectory) => spawnProcess(cliPath, args, { cwd: workingDirectory, stdio: ["pipe", "pipe", "pipe"] });

interface CliEnvelope {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
  modelUsage?: Record<string, { outputTokens?: number }>;
}

// The plan's limits in the CLI's own words (2.1.296: "usage limit reached", "usage credit limit reached", "you have
// reached your weekly usage limit", "… of your 5-hour usage limit", "You've hit your limit · resets …", "You've hit your
// session limit · resets …"; older builds "Claude AI usage limit reached|<time>").
const usageLimitPattern = /usage limit reached|usage credit limit reached|weekly usage limit|5-hour usage limit|hit your (?:session |weekly )?limit/i;
// A CLI that cannot run at all: every later call would fail the same way.
const fatalFailurePattern = /could not start|please run \/login|invalid api key|not logged in|authentication|unauthorized|credit balance too low/i;

function classifyFailure(message: string, fallback: ClaudeCallFailureKind): ClaudeCallFailureKind {
  if (usageLimitPattern.test(message)) return "usage_limit";
  if (fatalFailurePattern.test(message)) return "fatal";
  return fallback;
}

function failed(kind: ClaudeCallFailureKind) {
  return { usageLimitReached: kind === "usage_limit", failureKind: kind };
}

export function claudeCliArguments(systemPrompt: string, jsonSchema: object, model: string, effort: ClaudeReasoningEffort): string[] {
  return [
    "-p",
    "--output-format", "json",
    "--model", model,
    "--effort", effort,
    "--system-prompt", systemPrompt,
    "--tools", "",
    "--json-schema", JSON.stringify(jsonSchema),
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "local",
    "--exclude-dynamic-system-prompt-sections",
  ];
}

/**
 * The model that answered: the one asked for ("sonnet" finds claude-sonnet-5-5, a full id finds itself). The CLI also
 * runs a small helper model on the side over the whole prompt, which can write more than a short answer, so the most
 * output decides only when no model matches the request.
 */
function answeringModel(modelUsage: CliEnvelope["modelUsage"], requestedModel: string): string | null {
  const entries = Object.entries(modelUsage ?? {});
  if (entries.length === 0) return null;
  const matching = entries.filter(([name]) => name.toLowerCase().includes(requestedModel.toLowerCase()));
  return (matching.length > 0 ? matching : entries).reduce((best, entry) => ((entry[1].outputTokens ?? 0) > (best[1].outputTokens ?? 0) ? entry : best))[0];
}

export function readClaudeCliOutput(stdout: string, stderr: string, exitCode: number | null, latencyMs: number, requestedModel: string): ClaudeSubscriptionCallResult {
  const empty = { servedModelId: null, latencyMs, tokensIn: null, tokensOut: null, costUsd: null, serviceTier: null, httpStatus: null };
  let envelope: CliEnvelope;
  try {
    envelope = JSON.parse(stdout) as CliEnvelope;
  } catch {
    // No envelope at all: the CLI crashed or printed something else; a passing failure unless it says why.
    const message = `Claude CLI exited ${exitCode}: ${(stderr || stdout).trim().slice(0, 500)}`;
    return { ok: false, rawText: stdout.slice(0, 2000) || null, error: message, ...failed(classifyFailure(message, "transient")), ...empty };
  }
  const usage = envelope.usage ?? {};
  const figures = {
    servedModelId: answeringModel(envelope.modelUsage, requestedModel),
    latencyMs,
    tokensIn: usage.input_tokens === undefined ? null : usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    tokensOut: usage.output_tokens ?? null,
    costUsd: envelope.total_cost_usd ?? null,
    serviceTier: "subscription",
    httpStatus: null,
  };
  if (envelope.is_error || exitCode !== 0) {
    // An error the API or the CLI reported (overloaded, rate limited, …): passing unless it is the plan's limit or the login.
    const message = `Claude CLI ${envelope.subtype ?? "error"} (exit ${exitCode}): ${(envelope.result ?? stderr).trim().slice(0, 500)}`;
    return { ok: false, rawText: envelope.result ?? null, error: message, ...failed(classifyFailure(message, "transient")), ...figures };
  }
  if (envelope.structured_output === undefined || envelope.structured_output === null) {
    return { ok: false, rawText: envelope.result ?? null, error: "Claude CLI returned no structured output", ...failed("answer"), ...figures };
  }
  return { ok: true, rawText: JSON.stringify(envelope.structured_output), error: null, usageLimitReached: false, failureKind: null, ...figures };
}

export function callClaudeSubscriptionModel(input: ClaudeSubscriptionCallInput, spawn: SpawnClaudeCli = spawnClaudeCli): Promise<ClaudeSubscriptionCallResult> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ClaudeSubscriptionCallResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(input.cliPath, claudeCliArguments(input.systemPrompt, input.jsonSchema, input.model, input.effort), input.workingDirectory);
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, rawText: null, servedModelId: null, latencyMs: Date.now() - startedAt, tokensIn: null, tokensOut: null, costUsd: null, serviceTier: "subscription", httpStatus: null, error: `timed out after ${input.timeoutSeconds}s`, ...failed("transient") });
    }, input.timeoutSeconds * 1000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) =>
      finish({ ok: false, rawText: null, servedModelId: null, latencyMs: Date.now() - startedAt, tokensIn: null, tokensOut: null, costUsd: null, serviceTier: "subscription", httpStatus: null, error: `Claude CLI could not start: ${error.message}`, ...failed("fatal") }),
    );
    child.on("close", (exitCode) => finish(readClaudeCliOutput(stdout, stderr, exitCode, Date.now() - startedAt, input.model)));
    child.stdin.write(input.userPayload);
    child.stdin.end();
  });
}
