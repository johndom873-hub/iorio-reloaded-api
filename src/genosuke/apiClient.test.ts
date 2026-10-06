import { afterEach, describe, expect, it, vi } from "vitest";
import { GenosukeApiClient, GenosukeApiError } from "./apiClient.js";
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

type FetchCall = { url: string; init: RequestInit };

/** Routes /auth/login to `login` and everything else to `data`, recording every call. */
function stubFetch(data: (call: FetchCall, index: number) => Response | Promise<Response>, login: () => Response = loginResponse) {
  const calls: FetchCall[] = [];
  let dataIndex = 0;
  const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/auth/login")) return login();
    return data({ url, init }, dataIndex++);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, dataCalls: () => calls.filter((call) => !call.url.endsWith("/auth/login")), loginCalls: () => calls.filter((call) => call.url.endsWith("/auth/login")) };
}

describe("GenosukeApiClient login", () => {
  it("logs in as the service user with the forwarded-proto header the session cookie needs", async () => {
    const { loginCalls } = stubFetch(() => new Response("[]"));
    await new GenosukeApiClient(config).get("/a");
    const [login] = loginCalls();
    expect(login!.url).toBe("http://127.0.0.1:1/auth/login");
    expect(login!.init.method).toBe("POST");
    expect(login!.init.headers).toEqual({ "Content-Type": "application/json", "X-Forwarded-Proto": "https" });
    expect(JSON.parse(login!.init.body as string)).toEqual({ username: "svc", password: "pw" });
  });

  it("sends only the cookie's name=value pair on data requests", async () => {
    const { dataCalls } = stubFetch(() => new Response("[]"));
    await new GenosukeApiClient(config).get("/a");
    expect((dataCalls()[0]!.init.headers as Record<string, string>).Cookie).toBe("connect.sid=abc");
  });

  it("logs in once and reuses the cookie across sequential requests", async () => {
    const { loginCalls, dataCalls } = stubFetch(() => new Response("[]"));
    const client = new GenosukeApiClient(config);
    await client.get("/a");
    await client.get("/b");
    expect(loginCalls()).toHaveLength(1);
    expect(dataCalls()).toHaveLength(2);
  });

  it("throws a GenosukeApiError with the login status and body when the login is refused", async () => {
    stubFetch(() => new Response("[]"), () => new Response("bad credentials", { status: 401 }));
    const error = await new GenosukeApiClient(config).get("/a").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GenosukeApiError);
    expect((error as GenosukeApiError).status).toBe(401);
    expect((error as GenosukeApiError).message).toBe("Genosuke service-user login failed: bad credentials");
  });

  it("throws a 500 error when the login response carries no session cookie", async () => {
    stubFetch(() => new Response("[]"), () => new Response("{}", { status: 200 }));
    const error = (await new GenosukeApiClient(config).get("/a").catch((caught: unknown) => caught)) as GenosukeApiError;
    expect(error.status).toBe(500);
    expect(error.message).toBe("Genosuke login succeeded but no session cookie was returned.");
  });

  it("tries to log in again on the next request after a failed login", async () => {
    let loginAttempts = 0;
    const { dataCalls } = stubFetch(
      () => new Response("[]"),
      () => (++loginAttempts === 1 ? new Response("down", { status: 503 }) : loginResponse()),
    );
    const client = new GenosukeApiClient(config);
    await expect(client.get("/a")).rejects.toThrow("login failed");
    await expect(client.get("/a")).resolves.toEqual([]);
    expect(loginAttempts).toBe(2);
    expect(dataCalls()).toHaveLength(1);
  });
});

describe("GenosukeApiClient responses", () => {
  it("throws a GenosukeApiError naming the method, path, status and body on an error status", async () => {
    stubFetch(() => new Response("route exploded", { status: 500 }));
    const error = (await new GenosukeApiClient(config).get("/positions").catch((caught: unknown) => caught)) as GenosukeApiError;
    expect(error).toBeInstanceOf(GenosukeApiError);
    expect(error.status).toBe(500);
    expect(error.message).toBe("GET /positions → 500: route exploded");
  });

  it("does not retry a 409 or any other non-401 error", async () => {
    const { dataCalls, loginCalls } = stubFetch(() => new Response("open position", { status: 409 }));
    await expect(new GenosukeApiClient(config).delete("/shortlist/e1")).rejects.toThrow("DELETE /shortlist/e1 → 409: open position");
    expect(dataCalls()).toHaveLength(1);
    expect(loginCalls()).toHaveLength(1);
  });

  it("gives up after one re-login when the 401 persists", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dataCalls, loginCalls } = stubFetch(() => new Response("unauthorised", { status: 401 }));
    const error = (await new GenosukeApiClient(config).get("/a").catch((caught: unknown) => caught)) as GenosukeApiError;
    expect(error.status).toBe(401);
    expect(dataCalls()).toHaveLength(2);
    expect(loginCalls()).toHaveLength(2);
    expect(errorLog).toHaveBeenCalledWith("Genosuke API: 401 persisted on GET /a after a fresh login");
  });

  it("returns undefined for a 204 without reading a body", async () => {
    stubFetch(() => new Response(null, { status: 204 }));
    expect(await new GenosukeApiClient(config).delete("/shortlist/e1")).toBeUndefined();
  });

  it("parses a JSON body", async () => {
    stubFetch(() => new Response(JSON.stringify({ id: "x", n: 1 }), { status: 200 }));
    expect(await new GenosukeApiClient(config).get("/a")).toEqual({ id: "x", n: 1 });
  });

  it("rejects on a 200 whose body is not JSON", async () => {
    stubFetch(() => new Response("<html>", { status: 200 }));
    await expect(new GenosukeApiClient(config).get("/a")).rejects.toThrow(SyntaxError);
  });
});

describe("GenosukeApiClient streamed responses", () => {
  const stream = (text: string) => new Response(text, { status: 200, headers: { "Content-Type": "text/event-stream" } });

  it("returns the body of the final data frame, ignoring heartbeats", async () => {
    stubFetch(() => stream(`: heartbeat\n\ndata: {"status":200,"body":{"stale":true}}\n\n: heartbeat\n\ndata: {"status":200,"body":{"ok":true}}\n\n`));
    expect(await new GenosukeApiClient(config).post("/system-health/check-ibkr", {})).toEqual({ ok: true });
  });

  it("throws the embedded status and body when the final frame reports an error", async () => {
    stubFetch(() => stream('data: {"status":503,"body":{"error":"gateway down"}}\n\n'));
    const error = (await new GenosukeApiClient(config).post("/system-health/check-ibkr", {}).catch((caught: unknown) => caught)) as GenosukeApiError;
    expect(error.status).toBe(503);
    expect(error.message).toBe('POST /system-health/check-ibkr → 503: {"error":"gateway down"}');
  });

  it("throws a 502 when the stream ends without a result frame", async () => {
    stubFetch(() => stream(": heartbeat\n\n"));
    const error = (await new GenosukeApiClient(config).get("/slow").catch((caught: unknown) => caught)) as GenosukeApiError;
    expect(error.status).toBe(502);
    expect(error.message).toBe("GET /slow → stream ended without a result");
  });
});

describe("GenosukeApiClient verbs", () => {
  it.each([
    ["post", "POST"],
    ["patch", "PATCH"],
    ["put", "PUT"],
  ] as const)("%s sends a JSON body with the method %s", async (verb, method) => {
    const { dataCalls } = stubFetch(() => new Response("{}"));
    await new GenosukeApiClient(config)[verb]("/things", { a: 1 });
    const [call] = dataCalls();
    expect(call!.init.method).toBe(method);
    expect(call!.init.body).toBe('{"a":1}');
    expect(call!.init.headers).toEqual({ "Content-Type": "application/json", Cookie: "connect.sid=abc" });
    expect(call!.url).toBe("http://127.0.0.1:1/things");
  });

  it("get sends no method override or body, and delete uses DELETE", async () => {
    const { dataCalls } = stubFetch(() => new Response("{}"));
    const client = new GenosukeApiClient(config);
    await client.get("/a");
    await client.delete("/b");
    expect(dataCalls()[0]!.init.method).toBeUndefined();
    expect(dataCalls()[0]!.init.body).toBeUndefined();
    expect(dataCalls()[1]!.init.method).toBe("DELETE");
  });
});
