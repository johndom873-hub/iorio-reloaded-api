import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import knexLibrary, { type Knex } from "knex";
import { environment } from "../../config/env.js";
import { askPlutoThroughSubscription, computeLlmRequestHash, type ClaudeCall } from "./askPlutoThroughSubscription.js";
import { createPlutoPromptMasking, maskPlutoText } from "./plutoPromptMasking.js";

if (!environment.testDatabaseUrl) throw new Error("TEST_DATABASE_URL must be set to run the backtest LLM tests.");

const db: Knex = knexLibrary({ client: "pg", connection: environment.testDatabaseUrl });
const symbol = `LLM${Date.now() % 100000}`;
const masking = createPlutoPromptMasking([symbol]);
const candidateId = `${symbol}:cash_secured_put:2026-03-20:95`;
const offeredIds = new Set([candidateId]);
const systemPrompt = `You are Pluto (test ${symbol}).`;
let sessionId: string;
let sequence = 0;

const tradeAnswer = JSON.stringify({
  decision: "trade",
  action_kind: "open_cash_secured_put",
  candidate_id: "STOCK_A:cash_secured_put:2046-03-23:95",
  confidence: 0.8,
  reasons: ["STOCK_A has a strong edge into 2046-03-23."],
  risks_acknowledged: [],
  system_concerns: [],
});

function payloadOn(tradingDate: string) {
  return { session: { date: tradingDate }, tickers: [{ symbol, candidates: [{ id: candidateId, expiry: "2026-03-20", strike: 95 }] }] };
}

function fakeModel(answer: Partial<Awaited<ReturnType<ClaudeCall>>>, seen: { payloads: string[] }): ClaudeCall {
  return async (input) => {
    seen.payloads.push(input.userPayload);
    return { ok: true, rawText: tradeAnswer, servedModelId: "claude-sonnet-5-5", latencyMs: 4800, tokensIn: 5500, tokensOut: 350, costUsd: 0.007, serviceTier: "subscription", httpStatus: null, error: null, usageLimitReached: false, ...answer };
  };
}

function ask(tradingDate: string, callModel: ClaudeCall) {
  sequence += 1;
  return askPlutoThroughSubscription({ connection: db, cliPath: "/unused", workingDirectory: "/unused", timeoutSeconds: 90, systemPrompt, payload: payloadOn(tradingDate), masking, offeredIds, sessionId, sequence, tradingDate, lookTime: "10:30" }, callModel);
}

beforeAll(async () => {
  const [session] = await db("backtest_sessions")
    .insert({ name: "LLM cache test", symbol, start_date: "2026-03-02", end_date: "2026-03-20", starting_value: 100000, tables_mode: "current", settings_snapshot: JSON.stringify({}), llm_masking: JSON.stringify(masking) })
    .returning("id");
  sessionId = session.id;
});

afterAll(async () => {
  await db("backtest_sessions").where({ id: sessionId }).del();
  await db("backtest_llm_calls").where({ system_prompt_hash: createHash("sha256").update(systemPrompt).digest("hex") }).del();
  await db.destroy();
});

describe("a Pluto decision through the subscription in a backtest session", () => {
  it("asks with the masked payload, reads the answer in real terms and caches it", async () => {
    const seen = { payloads: [] as string[] };
    const result = await ask("2026-03-04", fakeModel({}, seen));
    expect(seen.payloads).toHaveLength(1);
    expect(seen.payloads[0]).not.toContain(symbol);
    expect(seen.payloads[0]).toContain("STOCK_A:cash_secured_put:2046-03-23:95");
    expect(result).toMatchObject({ outcome: "decided", cacheHit: false, error: null });
    expect(result.decision?.candidateId).toBe(candidateId);
    expect(result.decision?.reasons[0]).toBe(`${symbol} has a strong edge into 2026-03-20.`);

    const hash = computeLlmRequestHash(systemPrompt, maskPlutoText(JSON.stringify(payloadOn("2026-03-04")), masking));
    const cached = await db("backtest_llm_calls").where({ request_hash: hash }).first();
    expect(cached).toMatchObject({ model: "sonnet", reasoning_effort: "medium", raw_output: tradeAnswer, served_model_id: "claude-sonnet-5-5", tokens_in: 5500, latency_ms: 4800 });
    const logged = await db("backtest_session_llm_calls").where({ session_id: sessionId, sequence }).first();
    expect(logged).toMatchObject({ request_hash: hash, llm_call_id: hash, cache_hit: false, outcome: "decided", look_time: "10:30" });
    expect(logged.decision.candidateId).toBe(candidateId);
  });

  it("the same question again is answered from the cache without calling the model", async () => {
    const seen = { payloads: [] as string[] };
    const result = await ask("2026-03-04", fakeModel({}, seen));
    expect(seen.payloads).toHaveLength(0);
    expect(result).toMatchObject({ outcome: "decided", cacheHit: true });
    expect(result.decision?.candidateId).toBe(candidateId);
  });

  it("a usage-limit stop is reported and logged but never cached", async () => {
    const seen = { payloads: [] as string[] };
    const result = await ask("2026-03-05", fakeModel({ ok: false, rawText: null, error: "Claude AI usage limit reached", usageLimitReached: true }, seen));
    expect(result).toMatchObject({ outcome: "usage_limit", decision: null, cacheHit: false, error: "Claude AI usage limit reached" });
    const hash = computeLlmRequestHash(systemPrompt, maskPlutoText(JSON.stringify(payloadOn("2026-03-05")), masking));
    expect(await db("backtest_llm_calls").where({ request_hash: hash }).first()).toBeUndefined();
    expect(await db("backtest_session_llm_calls").where({ session_id: sessionId, sequence }).first()).toMatchObject({ outcome: "usage_limit", llm_call_id: null });
  });

  it("an answer naming a candidate that was not offered is invalid, as live, and a re-run replays it (live makes one call per decision, no retry)", async () => {
    const wrongCandidate = tradeAnswer.replace("2046-03-23:95", "2046-03-23:90");
    const result = await ask("2026-03-06", fakeModel({ rawText: wrongCandidate }, { payloads: [] }));
    expect(result.outcome).toBe("invalid_answer");
    expect(result.decision).toBeNull();
    expect(result.error).toMatch(/^invalid decision: /);

    const seen = { payloads: [] as string[] };
    const replayed = await ask("2026-03-06", fakeModel({}, seen));
    expect(seen.payloads).toHaveLength(0);
    expect(replayed).toMatchObject({ outcome: "invalid_answer", cacheHit: true, decision: null });
  });

  it("a resumed session asking at the same place overwrites its own log row", async () => {
    const before = await db("backtest_session_llm_calls").where({ session_id: sessionId }).count({ total: "*" }).first();
    sequence = 0;
    await ask("2026-03-04", fakeModel({}, { payloads: [] }));
    const after = await db("backtest_session_llm_calls").where({ session_id: sessionId }).count({ total: "*" }).first();
    expect(Number(after?.total)).toBe(Number(before?.total));
    expect(await db("backtest_session_llm_calls").where({ session_id: sessionId, sequence: 1 }).first()).toMatchObject({ outcome: "decided", cache_hit: true, trading_date: expect.any(Date) });
  });
});
