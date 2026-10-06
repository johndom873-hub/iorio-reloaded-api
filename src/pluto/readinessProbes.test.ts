import { describe, expect, it, vi } from "vitest";
import { openRouterCreditsUrl, probeOpenRouterCredit } from "./readinessProbes.js";

function fakeFetch(status: number, body: unknown) {
  return vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })) as unknown as typeof fetch;
}

describe("probeOpenRouterCredit", () => {
  it("passes with the credit left when it covers a day of Pluto's cost ceiling, spending nothing", async () => {
    const fetchImpl = fakeFetch(200, { data: { total_credits: 20, total_usage: 0.19377 } });
    await expect(probeOpenRouterCredit("key", 1, fetchImpl)).resolves.toBe("$19.81 credit left");
    expect(fetchImpl).toHaveBeenCalledWith(openRouterCreditsUrl, expect.objectContaining({ headers: { Authorization: "Bearer key" } }));
  });

  it("fails when the credit left is below the daily cost ceiling", async () => {
    await expect(probeOpenRouterCredit("key", 1, fakeFetch(200, { data: { total_credits: 20, total_usage: 19.4 } }))).rejects.toThrow("$0.60 credit left, below Pluto's $1.00 daily cost ceiling");
  });

  it("fails when OpenRouter refuses the key", async () => {
    await expect(probeOpenRouterCredit("bad", 1, fakeFetch(401, {}))).rejects.toThrow("OpenRouter refused the key (HTTP 401)");
  });

  it("fails when the answer has no credit figures", async () => {
    await expect(probeOpenRouterCredit("key", 1, fakeFetch(200, { data: {} }))).rejects.toThrow("OpenRouter returned no credit figures");
  });
});
