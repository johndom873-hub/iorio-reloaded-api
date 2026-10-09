import { describe, expect, it } from "vitest";
import { callPlutoModel } from "./modelClient.js";

describe("callPlutoModel latency", () => {
  it("counts the time until the body arrives, not just the headers", async () => {
    // OpenRouter sends headers (and keep-alive whitespace) at once and the answer only when the model is done.
    const bodyDelayMs = 120;
    const answer = { model: "openai/gpt-6-luna", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.0001 } };
    const fetchImpl = (async () => ({
      status: 200,
      ok: true,
      text: async () => {
        await new Promise((resolve) => setTimeout(resolve, bodyDelayMs));
        return `   ${JSON.stringify(answer)}`;
      },
    })) as unknown as typeof fetch;
    const result = await callPlutoModel({ apiKey: "k", modelId: "openai/gpt-6-luna", reasoningEffort: "medium", timeoutSeconds: 5, systemPrompt: "s", userPayload: "{}" }, fetchImpl);
    expect(result.latencyMs).toBeGreaterThanOrEqual(bodyDelayMs - 5);
  });
});
