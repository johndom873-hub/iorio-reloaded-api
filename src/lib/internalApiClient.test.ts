import { afterEach, describe, expect, it, vi } from "vitest";
import { InternalApiClient } from "./internalApiClient.js";

// The client's configured headers (Pluto's agent lease holder) go on every request after sign-in, beside the session cookie.

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InternalApiClient headers", () => {
  it("sends the configured headers on every request, with the session cookie and the request's own headers", async () => {
    const sent: { url: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, headers: init.headers as Record<string, string> });
        if (url.endsWith("/auth/login")) return new Response("{}", { status: 200, headers: { "set-cookie": "connect.sid=abc; Path=/" } });
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const client = new InternalApiClient({ apiBaseUrl: "http://api", serviceUsername: "pluto", serviceUserPassword: "secret", label: "Pluto", headers: { "X-Pluto-Agent-Holder": "agent.1:abc" } });

    await client.post("/positions/orders/1/confirm", {});
    await client.get("/pluto/state");

    const requests = sent.filter((request) => !request.url.endsWith("/auth/login"));
    expect(requests).toHaveLength(2);
    for (const request of requests) expect(request.headers).toMatchObject({ "X-Pluto-Agent-Holder": "agent.1:abc", Cookie: "connect.sid=abc" });
    expect(requests[0]!.headers["Content-Type"]).toBe("application/json");
  });

  it("sends no extra header when none is configured", async () => {
    const sent: Record<string, string>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push(init.headers as Record<string, string>);
        if (url.endsWith("/auth/login")) return new Response("{}", { status: 200, headers: { "set-cookie": "connect.sid=abc; Path=/" } });
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    await new InternalApiClient({ apiBaseUrl: "http://api", serviceUsername: "genosuke", serviceUserPassword: "secret", label: "Genosuke" }).get("/positions");
    expect(Object.keys(sent[1]!)).toEqual(["Cookie"]);
  });
});
