import { afterEach, describe, expect, it, vi } from "vitest";
import { GenosukeApiClient } from "./apiClient.js";
import type { GenosukeConfig } from "./config.js";

const config = { apiBaseUrl: "http://127.0.0.1:1", serviceUsername: "svc", serviceUserPassword: "pw" } as GenosukeConfig;

function loginResponse(): Response {
  return new Response("{}", { status: 200, headers: { "Set-Cookie": "connect.sid=abc; Path=/; HttpOnly" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("GenosukeApiClient", () => {
  it("does not use the session cookie until the whole login response has been read", async () => {
    // Mimics express-session: headers and all but the last byte arrive at once, the last byte
    // only after the session is saved.
    let releaseLastByte: () => void = () => {};
    const lastByteReleased = new Promise<void>((resolve) => (releaseLastByte = resolve));
    const slowLogin = new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode("{"));
          await lastByteReleased;
          controller.enqueue(new TextEncoder().encode("}"));
          controller.close();
        },
      }),
      { status: 200, headers: { "Set-Cookie": "connect.sid=abc; Path=/; HttpOnly" } },
    );
    const events: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/auth/login")) return slowLogin;
        events.push("data request sent");
        return new Response("[]", { status: 200 });
      }),
    );

    const pending = new GenosukeApiClient(config).get("/a");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events).toEqual([]);

    events.push("session saved");
    releaseLastByte();
    await pending;
    expect(events).toEqual(["session saved", "data request sent"]);
  });

  it("logs in once when several requests start cold in parallel", async () => {
    const fetchMock = vi.fn(async (url: string) => (url.endsWith("/auth/login") ? loginResponse() : new Response("[]", { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GenosukeApiClient(config);

    await Promise.all([client.get("/a"), client.get("/b"), client.get("/c")]);

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/login"));
    expect(loginCalls).toHaveLength(1);
  });

  it("re-logs in once on a 401 and retries with the fresh cookie", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let dataCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/login")) return loginResponse();
      dataCalls += 1;
      return dataCalls === 1 ? new Response("{}", { status: 401 }) : new Response("[]", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new GenosukeApiClient(config);

    await expect(client.get("/a")).resolves.toEqual([]);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/auth/login"))).toHaveLength(2);
  });
});
