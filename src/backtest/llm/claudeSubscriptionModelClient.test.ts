import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { callClaudeSubscriptionModel, claudeCliArguments, type SpawnClaudeCli } from "./claudeSubscriptionModelClient.js";

// The envelope shape the CLI printed in the 2026-10-12 probe (Sonnet 5.5, medium effort, one stored BMNR decision).
const successEnvelope = {
  type: "result",
  subtype: "success",
  is_error: false,
  duration_api_ms: 4632,
  result: '{"decision":"no_trade"}',
  structured_output: { decision: "no_trade", action_kind: null, candidate_id: null, confidence: 0.9, reasons: ["Weak edge."] },
  total_cost_usd: 0.0070326,
  usage: { input_tokens: 2, cache_creation_input_tokens: 614, cache_read_input_tokens: 4882, output_tokens: 368 },
  modelUsage: { "claude-haiku-5-5": { outputTokens: 12 }, "claude-sonnet-5-5": { outputTokens: 368 } },
};

interface FakeRun {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  startError?: Error;
  hang?: boolean;
}

function fakeSpawn(run: FakeRun, seen: { args?: string[]; stdin?: string; cwd?: string; killed?: boolean } = {}): SpawnClaudeCli {
  return (_cliPath, args, workingDirectory) => {
    seen.args = args;
    seen.cwd = workingDirectory;
    const process = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    process.stdout = new EventEmitter();
    process.stderr = new EventEmitter();
    let stdin = "";
    return {
      stdin: {
        write: (text: string) => (stdin += text),
        end: () => {
          seen.stdin = stdin;
          setImmediate(() => {
            if (run.startError) return process.emit("error", run.startError);
            if (run.hang) return;
            if (run.stdout) process.stdout.emit("data", run.stdout);
            if (run.stderr) process.stderr.emit("data", run.stderr);
            process.emit("close", run.exitCode ?? 0);
          });
        },
      },
      stdout: process.stdout,
      stderr: process.stderr,
      on: (event: string, listener: (...args: unknown[]) => void) => process.on(event, listener),
      kill: () => (seen.killed = true),
    } as ReturnType<SpawnClaudeCli>;
  };
}

const input = { cliPath: "/opt/homebrew/bin/claude", workingDirectory: "/tmp/empty", timeoutSeconds: 90, systemPrompt: "You are Pluto.", userPayload: '{"tickers":[]}' };

describe("Pluto's decision through the Claude subscription CLI", () => {
  it("asks Sonnet at medium effort with Pluto's prompt and schema, no tools and nothing of Claude Code's own", () => {
    const args = claudeCliArguments("You are Pluto.");
    const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
    expect(valueOf("--model")).toBe("sonnet");
    expect(valueOf("--effort")).toBe("medium");
    expect(valueOf("--system-prompt")).toBe("You are Pluto.");
    expect(valueOf("--tools")).toBe("");
    expect(valueOf("--output-format")).toBe("json");
    expect(JSON.parse(valueOf("--json-schema")!)).toHaveProperty("properties.decision");
    expect(args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--exclude-dynamic-system-prompt-sections"]));
    expect(args).not.toContain("--bare");
  });

  it("returns the structured answer as the raw text, the answering model, all input tokens and the API-equivalent cost", async () => {
    const seen: { stdin?: string; cwd?: string } = {};
    const result = await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: JSON.stringify(successEnvelope) }, seen));
    expect(seen.stdin).toBe('{"tickers":[]}');
    expect(seen.cwd).toBe("/tmp/empty");
    expect(result).toMatchObject({ ok: true, error: null, usageLimitReached: false, failureKind: null, servedModelId: "claude-sonnet-5-5", tokensIn: 5498, tokensOut: 368, costUsd: 0.0070326, serviceTier: "subscription" });
    expect(JSON.parse(result.rawText!)).toEqual(successEnvelope.structured_output);
  });

  it("an error envelope saying the plan's limit was hit is a usage-limit stop, not a failure of the call's content", async () => {
    const envelope = { type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760300000", usage: {} };
    const result = await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 1 }));
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ usageLimitReached: true, failureKind: "usage_limit" });
    expect(result.error).toMatch(/usage limit reached/);
  });

  it("every way the CLI words the plan's limit is a usage-limit stop", async () => {
    for (const text of ["usage limit reached", "usage credit limit reached", "you have reached your weekly usage limit", "You've used 100% of your 5-hour usage limit.", "You've hit your limit · resets 5pm"]) {
      const envelope = { type: "result", subtype: "success", is_error: true, result: text, usage: {} };
      expect((await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 1 }))).failureKind).toBe("usage_limit");
    }
  });

  it("an API error that passes (overloaded, rate limited) is a passing failure, retried by the caller", async () => {
    for (const text of ["API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\"}}", "API Error: 429 rate_limit_error"]) {
      const envelope = { type: "result", subtype: "success", is_error: true, result: text, usage: {} };
      expect((await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: JSON.stringify(envelope), exitCode: 1 }))).failureKind).toBe("transient");
    }
  });

  it("an answer without structured output is a failed call of the model's own, as live counts one", async () => {
    const { structured_output: _dropped, ...envelope } = successEnvelope;
    const result = await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: JSON.stringify(envelope) }));
    expect(result).toMatchObject({ ok: false, usageLimitReached: false, failureKind: "answer", error: "Claude CLI returned no structured output" });
  });

  it("output that is not JSON reports stderr: a lost login cannot run, anything else passes", async () => {
    const loggedOut = await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: "", stderr: "Invalid API key · Please run /login", exitCode: 1 }));
    expect(loggedOut).toMatchObject({ ok: false, usageLimitReached: false, failureKind: "fatal" });
    expect(loggedOut.error).toContain("Please run /login");
    const crashed = await callClaudeSubscriptionModel(input, fakeSpawn({ stdout: "", stderr: "Segmentation fault", exitCode: 139 }));
    expect(crashed.failureKind).toBe("transient");
  });

  it("a CLI that cannot start cannot run; one that does not answer in time is a passing failure", async () => {
    const notFound = await callClaudeSubscriptionModel(input, fakeSpawn({ startError: new Error("spawn ENOENT") }));
    expect(notFound).toMatchObject({ error: "Claude CLI could not start: spawn ENOENT", failureKind: "fatal" });
    const seen: { killed?: boolean } = {};
    const timedOut = await callClaudeSubscriptionModel({ ...input, timeoutSeconds: 0.05 }, fakeSpawn({ hang: true }, seen));
    expect(timedOut).toMatchObject({ error: "timed out after 0.05s", failureKind: "transient" });
    expect(seen.killed).toBe(true);
  });
});
