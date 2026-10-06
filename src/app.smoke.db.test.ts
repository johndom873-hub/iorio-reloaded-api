import "dotenv/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";
import { hashPassword } from "./lib/auth.js";

// Smoke tests over HTTP against the real Express app (src/app.ts): real CORS, JSON parsing, express-session backed by the test
// database, every router mounted exactly as in production, and the real error handler. Only the edges that would reach the outside
// world are replaced: IBKR is never contacted because no request here triggers it, and Telegram / app notifications / the deploy
// notice announcement are mocked.
//
// app.ts reads configuration (frontend origin, app environment, session secret) when it is imported, so each configuration under
// test gets its own module registry (vi.resetModules) and its own listening server on port 0.

vi.mock("./db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the app smoke tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const notifyTelegramMock = vi.fn();
vi.mock("./lib/notifyTelegram.js", () => ({ notifyTelegram: (...args: unknown[]) => notifyTelegramMock(...args) }));
vi.mock("./lib/notificationChannel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/notificationChannel.js")>()),
  publishNotification: vi.fn(),
}));
const announceWebDynoStartMock = vi.fn();
vi.mock("./lib/webDynoStartNotice.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lib/webDynoStartNotice.js")>()),
  announceWebDynoStart: (...args: unknown[]) => announceWebDynoStartMock(...args),
}));
// Lets one test make the /environment/details handler fail with a recognisable message; otherwise the real function runs.
let tradingHaltFailure: Error | null = null;
vi.mock("./lib/platformControls.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/platformControls.js")>();
  return { ...original, fetchTradingHalt: (...args: Parameters<typeof original.fetchTradingHalt>) => (tradingHaltFailure ? Promise.reject(tradingHaltFailure) : original.fetchTradingHalt(...args)) };
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL as string;
const originalSessionSecret = process.env.SESSION_SECRET as string;
const originalDatabaseSsl = process.env.DATABASE_SSL as string;
const configuredFrontendOrigin = "https://frontend.smoke-test.example";
const foreignOrigin = "https://attacker.smoke-test.example";
const sessionCookieName = "connect.sid";
const thirtyDaysInSeconds = 60 * 60 * 24 * 30;
const smokeUserPassword = "smoke-test-password";

interface RunningApp {
  baseUrl: string;
  database: Knex;
  resetLoginFailures: () => void;
  close: () => Promise<void>;
}

const sessionIdsToClean = new Set<string>();

async function startApp(environmentOverrides: Record<string, string>): Promise<RunningApp> {
  vi.resetModules();
  // The session store builds its own pg pool from DATABASE_URL at import time; it must never point at the development database.
  vi.stubEnv("DATABASE_URL", testDatabaseUrl);
  vi.stubEnv("FRONTEND_ORIGIN", configuredFrontendOrigin);
  vi.stubEnv("PASSKEY_LOGIN", "off");
  for (const [name, value] of Object.entries(environmentOverrides)) vi.stubEnv(name, value);
  const { app } = await import("./app.js");
  const { environment } = await import("./config/env.js");
  expect(environment.databaseUrl).toBe(testDatabaseUrl);
  const { db } = await import("./db/connection.js");
  const { resetLoginFailuresForTests } = await import("./lib/loginFailureThrottle.js");
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    database: db,
    resetLoginFailures: resetLoginFailuresForTests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.destroy();
    },
  };
}

function rememberSessionCookies(response: Response): void {
  for (const setCookie of response.headers.getSetCookie()) {
    const match = setCookie.match(new RegExp(`^${sessionCookieName}=([^;]*)`));
    if (!match || !match[1]) continue;
    const signedValue = decodeURIComponent(match[1]);
    if (signedValue.startsWith("s:")) sessionIdsToClean.add(signedValue.slice(2).split(".")[0] as string);
  }
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  cookie?: string;
}

async function send(running: RunningApp, path: string, options: RequestOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.cookie) headers.cookie = options.cookie;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers["content-type"] ??= "application/json";
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(`${running.baseUrl}${path}`, { method: options.method ?? "GET", headers, body });
  rememberSessionCookies(response);
  return response;
}

function sessionCookieOf(response: Response): string | null {
  const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${sessionCookieName}=`));
  return setCookie ? (setCookie.split(";")[0] as string) : null;
}

let smokeUserId: string;
const smokeUsername = `smoke-app-${Date.now()}`;
let developmentApp: RunningApp;
let productionApp: RunningApp;

beforeAll(async () => {
  developmentApp = await startApp({ APP_ENVIRONMENT: "development" });
  productionApp = await startApp({ APP_ENVIRONMENT: "production" });
  vi.stubEnv("APP_ENVIRONMENT", "development");
  const [user] = await developmentApp.database("users").insert({ username: smokeUsername, display_name: "Smoke Tester", password_hash: await hashPassword(smokeUserPassword) }).returning("id");
  smokeUserId = user.id;
}, 60_000);

afterAll(async () => {
  if (sessionIdsToClean.size > 0) await developmentApp.database("session").whereIn("sid", [...sessionIdsToClean]).del();
  await developmentApp.database("session").whereRaw("sess::jsonb ->> 'userId' = ?", [smokeUserId]).del();
  await developmentApp.database("users").where({ id: smokeUserId }).del();
  await developmentApp.close();
  await productionApp.close();
  vi.unstubAllEnvs();
});

afterEach(() => {
  tradingHaltFailure = null;
  vi.stubEnv("PASSKEY_LOGIN", "off");
  vi.stubEnv("APP_ENVIRONMENT", "development");
  developmentApp.resetLoginFailures();
  productionApp.resetLoginFailures();
});

async function logIn(running: RunningApp, extraHeaders: Record<string, string> = {}): Promise<string> {
  const response = await send(running, "/auth/login", { method: "POST", body: { username: smokeUsername, password: smokeUserPassword }, headers: extraHeaders });
  expect(response.status).toBe(200);
  const cookie = sessionCookieOf(response);
  expect(cookie).not.toBeNull();
  return cookie as string;
}

const httpsThroughProxy = { "x-forwarded-proto": "https" };

// APP_ENVIRONMENT is baked into the session cookie when app.ts is imported (see startApp) but also read on every request by other
// handlers, so a test that talks to the production instance switches the live value to match.
function actAsProductionEnvironment(): void {
  vi.stubEnv("APP_ENVIRONMENT", "production");
}

// Every mount in app.ts must be classified here. A router added without an entry fails the "no unclassified mount" test, which is
// what forces a decision (guarded or public by design) for every new route.
const guardedMounts = [
  "/genosuke/preferences",
  "/screener",
  "/shortlist",
  "/price-performance",
  "/tickers",
  "/risk-limits",
  "/positions",
  "/notifications",
  "/stream",
  "/trade-blotter",
  "/signals",
  "/order-checks",
  "/system-health",
  "/calendar-events",
  "/dashboard",
  "/pluto",
];
const publicByDesignMounts = [
  // Login page: GET /config, POST /login, POST /logout, GET /session (answers 401 itself), /passkey/* (own gates).
  "/auth",
  // GET / is public (environment name and trading mode only); GET /details is guarded.
  "/environment",
  // Telegram and the frontend server authenticate with shared secret headers checked inside the handlers.
  "POST /genosuke/webhook",
  "POST /deploy-notices",
];
// Mounted without a path; each is either global middleware or the public /health router.
const unpathedUses = ["cors", "express.json", "sessionMiddleware", "requestRateMiddleware", "pulseOnRequestMiddleware", "healthRouter", "errorHandler"];

function readMountsFromAppSource(): { pathedMounts: string[]; unpathedUses: string[] } {
  const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
  const pathedMounts = [...source.matchAll(/^app\.(use|get|post|put|patch|delete)\(\s*"([^"]+)"/gm)].map(([, method, path]) => (method === "use" ? (path as string) : `${(method as string).toUpperCase()} ${path}`));
  const unpathed = [...source.matchAll(/^app\.use\(\s*([A-Za-z_.]+)/gm)].map(([, identifier]) => identifier as string);
  return { pathedMounts, unpathedUses: unpathed };
}

describe("router mounting inventory", () => {
  it("has no mount that is not classified as guarded or public by design", () => {
    const mounts = readMountsFromAppSource();
    expect([...mounts.pathedMounts].sort()).toEqual([...guardedMounts, ...publicByDesignMounts].sort());
    expect([...mounts.unpathedUses].sort()).toEqual([...unpathedUses].sort());
  });
});

describe("GET /health", () => {
  it("answers 200 with status ok and no session cookie when the database responds", async () => {
    const response = await send(developmentApp, "/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("answers 503 with status error when the database check fails", async () => {
    const rawSpy = vi.spyOn(developmentApp.database, "raw").mockRejectedValueOnce(new Error("database unreachable"));
    const response = await send(developmentApp, "/health");
    rawSpy.mockRestore();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", message: "Database unavailable." });
  });
});

describe("authentication guard on every mounted router", () => {
  for (const mount of guardedMounts) {
    it(`${mount} answers 401 to an unauthenticated GET, including an unknown sub-path`, async () => {
      for (const path of [mount, `${mount}/__smoke__/deeper/still`]) {
        const response = await send(developmentApp, path);
        expect(response.status, `GET ${path}`).toBe(401);
        expect(await response.json()).toEqual({ error: "Not logged in." });
      }
    });

    it(`${mount} lets an authenticated session through its guard (unknown sub-path is a plain 404)`, async () => {
      const cookie = await logIn(developmentApp);
      const response = await send(developmentApp, `${mount}/__smoke__/deeper/still/and/deeper`, { cookie });
      expect(response.status).toBe(404);
    });
  }

  it("rejects unauthenticated state-changing and streaming requests, not just the GET listings", async () => {
    const probes: Array<{ method: string; path: string }> = [
      { method: "POST", path: "/positions/orders" },
      { method: "POST", path: "/positions/orders/00000000-0000-0000-0000-000000000000/confirm" },
      { method: "POST", path: "/positions/orders/00000000-0000-0000-0000-000000000000/cancel" },
      { method: "POST", path: "/order-checks/commission-preview" },
      { method: "PUT", path: "/risk-limits/trading-halt" },
      { method: "GET", path: "/stream" },
      { method: "GET", path: "/stream/status" },
      { method: "POST", path: "/stream/some-connection/subscribe" },
      { method: "POST", path: "/stream/some-connection/unsubscribe" },
      { method: "GET", path: "/notifications/stream" },
      { method: "GET", path: "/positions/pnl/stream" },
      { method: "GET", path: "/positions/greeks/stream" },
      { method: "GET", path: "/dashboard/portfolio/stream" },
      { method: "GET", path: "/risk-limits/exposure/stream" },
      { method: "GET", path: "/environment/details" },
    ];
    for (const { method, path } of probes) {
      const response = await send(developmentApp, path, { method, body: method === "GET" ? undefined : {} });
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(await response.json(), `${method} ${path}`).toEqual({ error: "Not logged in." });
    }
  });

  it("serves the multiplexed event stream as text/event-stream to an authenticated session", async () => {
    const cookie = await logIn(developmentApp);
    const abort = new AbortController();
    const response = await fetch(`${developmentApp.baseUrl}/stream`, { headers: { cookie }, signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/event-stream/);
    expect(response.headers.get("cache-control")).toBe("no-cache");
    abort.abort();
  });

  it("stops accepting a session created before passkeys became mandatory, without any session wipe", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    const cookie = await logIn(developmentApp);
    expect((await send(developmentApp, "/auth/session", { cookie })).status).toBe(200);
    vi.stubEnv("PASSKEY_LOGIN", "required");
    expect((await send(developmentApp, "/positions/__smoke__/deeper/still", { cookie })).status).toBe(401);
    expect((await send(developmentApp, "/auth/session", { cookie })).status).toBe(401);
  });
});

describe("routes reachable without a session", () => {
  it("GET /environment reveals only the environment name and the trading mode", async () => {
    const response = await send(developmentApp, "/environment");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ environment: "development", tradingMode: process.env.IBKR_TRADING_MODE });
  });

  it("GET /auth/config tells the login page which sign-in to offer", async () => {
    expect(await (await send(developmentApp, "/auth/config")).json()).toEqual({ passkeyLoginRequired: false });
    vi.stubEnv("PASSKEY_LOGIN", "required");
    expect(await (await send(developmentApp, "/auth/config")).json()).toEqual({ passkeyLoginRequired: true });
  });

  it("POST /auth/login validates input and refuses wrong credentials without issuing a session cookie", async () => {
    const missing = await send(developmentApp, "/auth/login", { method: "POST", body: { username: smokeUsername } });
    expect(missing.status).toBe(400);
    const wrongPassword = await send(developmentApp, "/auth/login", { method: "POST", body: { username: smokeUsername, password: "not-the-password" } });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "Invalid username or password." });
    expect(wrongPassword.headers.getSetCookie()).toEqual([]);
    const unknownUser = await send(developmentApp, "/auth/login", { method: "POST", body: { username: `${smokeUsername}-nobody`, password: smokeUserPassword } });
    expect(unknownUser.status).toBe(401);
  });

  it("GET /auth/session answers 401 itself when nobody is signed in", async () => {
    const response = await send(developmentApp, "/auth/session");
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not logged in." });
  });

  it("POST /auth/logout destroys the session: the old cookie no longer authenticates", async () => {
    const cookie = await logIn(developmentApp);
    const logout = await send(developmentApp, "/auth/logout", { method: "POST", cookie });
    expect(logout.status).toBe(204);
    expect(logout.headers.getSetCookie().join(";")).toMatch(new RegExp(`${sessionCookieName}=;`));
    expect((await send(developmentApp, "/auth/session", { cookie })).status).toBe(401);
  });

  it("keeps the passkey routes closed (404) while PASSKEY_LOGIN is off", async () => {
    for (const path of ["/auth/passkey/login/options", "/auth/passkey/register/options", "/auth/passkey/login/verify", "/auth/passkey/register/verify"]) {
      const response = await send(developmentApp, path, { method: "POST", body: {} });
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual({ error: "Passkey login is not enabled." });
    }
  });

  it("offers a passkey login challenge without a session once PASSKEY_LOGIN is required, but never enrolment", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    vi.stubEnv("PASSKEY_RP_ID", "localhost");
    const options = await send(developmentApp, "/auth/passkey/login/options", { method: "POST", body: {} });
    expect(options.status).toBe(200);
    const optionsBody = (await options.json()) as Record<string, unknown>;
    expect(typeof optionsBody.challenge).toBe("string");
    expect(optionsBody.rpId).toBe("localhost");
    expect(optionsBody.userVerification).toBe("required");

    const registration = await send(developmentApp, "/auth/passkey/register/options", { method: "POST", body: {} });
    expect(registration.status).toBe(401);
  });

  it("never signs in on a password alone while passkeys are required", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    vi.stubEnv("PASSKEY_RP_ID", "localhost");
    const response = await send(developmentApp, "/auth/login", { method: "POST", body: { username: smokeUsername, password: smokeUserPassword } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "passkey_enrollment_required" });
    const cookie = sessionCookieOf(response) as string;
    expect((await send(developmentApp, "/positions/__smoke__/deeper/still", { cookie })).status).toBe(401);
    expect((await send(developmentApp, "/auth/session", { cookie })).status).toBe(401);
  });

  it("POST /genosuke/webhook answers 404 while the Telegram bot is not running", async () => {
    const response = await send(developmentApp, "/genosuke/webhook", { method: "POST", body: { update_id: 1 } });
    expect(response.status).toBe(404);
  });

  it("POST /deploy-notices fails closed without a configured secret, refuses a wrong one and accepts the right one", async () => {
    announceWebDynoStartMock.mockReset();
    vi.stubEnv("DEPLOY_NOTICE_SECRET", "");
    const notConfigured = await send(developmentApp, "/deploy-notices", { method: "POST", body: {} });
    expect(notConfigured.status).toBe(503);

    vi.stubEnv("DEPLOY_NOTICE_SECRET", "smoke-deploy-secret");
    const noHeader = await send(developmentApp, "/deploy-notices", { method: "POST", body: {} });
    expect(noHeader.status).toBe(401);
    const wrongHeader = await send(developmentApp, "/deploy-notices", { method: "POST", body: {}, headers: { "X-Deploy-Notice-Secret": "wrong" } });
    expect(wrongHeader.status).toBe(401);
    expect(announceWebDynoStartMock).not.toHaveBeenCalled();

    const accepted = await send(developmentApp, "/deploy-notices", {
      method: "POST",
      body: { releaseVersion: "v1", commitSha: "abc" },
      headers: { "X-Deploy-Notice-Secret": "smoke-deploy-secret" },
    });
    expect(accepted.status).toBe(204);
    expect(announceWebDynoStartMock).toHaveBeenCalledWith({ subject: "App", current: { releaseVersion: "v1", commitSha: "abc" } });
    vi.stubEnv("DEPLOY_NOTICE_SECRET", "");
  });
});

// express-session turns the configured maxAge into an Expires attribute (it sends no Max-Age).
function expectExpiryInThirtyDays(setCookie: string): void {
  const expiresMatch = setCookie.match(/;\s*Expires=([^;]+)/);
  expect(expiresMatch).not.toBeNull();
  const secondsUntilExpiry = (new Date((expiresMatch as RegExpMatchArray)[1] as string).getTime() - Date.now()) / 1000;
  expect(Math.abs(secondsUntilExpiry - thirtyDaysInSeconds)).toBeLessThan(120);
}

describe("session cookie", () => {
  it("is named connect.sid, HttpOnly, SameSite=Lax, valid for 30 days, and not Secure in development", async () => {
    const response = await send(developmentApp, "/auth/login", { method: "POST", body: { username: smokeUsername, password: smokeUserPassword } });
    const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${sessionCookieName}=`)) as string;
    expect(setCookie).toBeDefined();
    expect(setCookie).toMatch(/;\s*HttpOnly/);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/);
    expect(setCookie).toMatch(/;\s*Path=\//);
    expectExpiryInThirtyDays(setCookie);
    expect(setCookie).not.toMatch(/;\s*Secure/);
    expect(setCookie).not.toMatch(/Domain=/);
  });

  it("is Secure in production when the request arrived over HTTPS through the proxy", async () => {
    actAsProductionEnvironment();
    const response = await send(productionApp, "/auth/login", { method: "POST", body: { username: smokeUsername, password: smokeUserPassword }, headers: httpsThroughProxy });
    expect(response.status).toBe(200);
    const setCookie = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${sessionCookieName}=`)) as string;
    expect(setCookie).toMatch(/;\s*Secure/);
    expect(setCookie).toMatch(/;\s*HttpOnly/);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/);
    expectExpiryInThirtyDays(setCookie);
  });

  it("is withheld in production when the proxy does not report HTTPS, instead of being sent in clear", async () => {
    actAsProductionEnvironment();
    const response = await send(productionApp, "/auth/login", { method: "POST", body: { username: smokeUsername, password: smokeUserPassword } });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().filter((cookie) => cookie.startsWith(`${sessionCookieName}=`))).toEqual([]);
  });

  it("authenticates later requests in production, and is a fresh id after every login", async () => {
    actAsProductionEnvironment();
    const firstCookie = await logIn(productionApp, httpsThroughProxy);
    const secondCookie = await logIn(productionApp, httpsThroughProxy);
    expect(secondCookie).not.toBe(firstCookie);
    const response = await send(productionApp, "/auth/session", { cookie: firstCookie, headers: httpsThroughProxy });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: smokeUserId, username: smokeUsername, displayName: "Smoke Tester" });
  });

  it("is not issued to a visitor who never signed in", async () => {
    for (const path of ["/health", "/environment", "/auth/config", "/positions"]) {
      const response = await send(developmentApp, path);
      expect(response.headers.getSetCookie(), path).toEqual([]);
    }
  });
});

describe("CORS", () => {
  it("allows the configured front-end origin with credentials", async () => {
    const response = await send(developmentApp, "/health", { headers: { origin: configuredFrontendOrigin } });
    expect(response.headers.get("access-control-allow-origin")).toBe(configuredFrontendOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("never echoes a foreign origin nor answers with a wildcard, so browsers block the response", async () => {
    for (const path of ["/health", "/positions", "/auth/login"]) {
      const response = await send(developmentApp, path, { headers: { origin: foreignOrigin } });
      expect(response.headers.get("access-control-allow-origin"), path).toBe(configuredFrontendOrigin);
      expect(response.headers.get("access-control-allow-origin"), path).not.toBe(foreignOrigin);
      expect(response.headers.get("access-control-allow-origin"), path).not.toBe("*");
    }
  });

  it("answers a preflight before authentication with 204, the allowed methods, credentials and a 24 hour cache", async () => {
    const response = await send(developmentApp, "/positions/orders", {
      method: "OPTIONS",
      headers: { origin: configuredFrontendOrigin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(configuredFrontendOrigin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(response.headers.get("access-control-allow-methods")).toMatch(/PUT/);
    expect(response.headers.get("access-control-allow-methods")).toMatch(/DELETE/);
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("does not grant a foreign origin on a preflight either", async () => {
    const response = await send(developmentApp, "/positions/orders", {
      method: "OPTIONS",
      headers: { origin: foreignOrigin, "access-control-request-method": "POST" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(configuredFrontendOrigin);
  });
});

describe("request body handling", () => {
  it("parses a JSON body just under the 100 kb limit", async () => {
    const response = await send(developmentApp, "/auth/login", { method: "POST", body: { padding: "x".repeat(90_000) } });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Username and password are required." });
  });

  it("refuses a JSON body over the 100 kb limit with a JSON error, never a stack trace", async () => {
    const response = await send(developmentApp, "/auth/login", { method: "POST", body: { padding: "x".repeat(150_000) } });
    expect(response.status).toBe(413);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Request body is too large." });
    expect(text).not.toMatch(/PayloadTooLarge|node_modules|\bat .*\(/);
  });

  it("refuses malformed JSON with a JSON error, never a stack trace", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await send(developmentApp, "/auth/login", { method: "POST", body: '{"username": "broken' });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Invalid request." });
    expect(text).not.toMatch(/SyntaxError|node_modules|\bat .*\(/);
  });
});

describe("unknown routes and the error handler", () => {
  it("answers 404 for an unknown route without leaking internals", async () => {
    const response = await send(developmentApp, "/definitely-not-a-route");
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: "Not found." });
    expect(text).not.toMatch(/node_modules|\bat .*\(/);
  });

  it("does not advertise Express and tells browsers not to sniff content types", async () => {
    for (const path of ["/health", "/definitely-not-a-route", "/positions"]) {
      const response = await send(developmentApp, path);
      expect(response.headers.get("x-powered-by"), path).toBeNull();
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("maps a malformed uuid in a route parameter to a JSON 404, not a server error", async () => {
    const cookie = await logIn(developmentApp);
    const response = await send(developmentApp, "/positions/orders/not-a-uuid", { cookie });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found." });
  });

  for (const [label, getApp, headers] of [
    ["development", () => developmentApp, {}],
    ["production", () => productionApp, httpsThroughProxy],
  ] as const) {
    it(`turns an unexpected failure into the generic JSON 500 without message or stack (${label})`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const running = getApp();
      if (label === "production") actAsProductionEnvironment();
      const cookie = await logIn(running, headers);
      tradingHaltFailure = new Error("secret-internal-detail at /srv/app/src/lib/platformControls.ts:41");
      const response = await send(running, "/environment/details", { cookie, headers });
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toMatch(/application\/json/);
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({ error: "Something went wrong. Please try again." });
      expect(text).not.toContain("secret-internal-detail");
      expect(text).not.toMatch(/platformControls|node_modules|\bat .*\(/);
    });
  }

  it("serves the guarded detail route normally once the failure is gone", async () => {
    const cookie = await logIn(developmentApp);
    const response = await send(developmentApp, "/environment/details", { cookie });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { environment: string }).environment).toBe("development");
  });
});

describe("boot configuration of the web app module", () => {
  async function importAppWith(environmentOverrides: Record<string, string>): Promise<unknown> {
    vi.resetModules();
    vi.stubEnv("DATABASE_URL", testDatabaseUrl);
    vi.stubEnv("FRONTEND_ORIGIN", configuredFrontendOrigin);
    vi.stubEnv("APP_ENVIRONMENT", "development");
    vi.stubEnv("SESSION_SECRET", originalSessionSecret);
    vi.stubEnv("DATABASE_SSL", originalDatabaseSsl);
    for (const [name, value] of Object.entries(environmentOverrides)) vi.stubEnv(name, value);
    return import("./app.js");
  }

  it("fails to import without SESSION_SECRET and names the variable", async () => {
    await expect(importAppWith({ SESSION_SECRET: "" })).rejects.toThrow("Missing required environment variable: SESSION_SECRET");
  });

  it("fails to import without FRONTEND_ORIGIN and names the variable", async () => {
    await expect(importAppWith({ FRONTEND_ORIGIN: "" })).rejects.toThrow("Missing required environment variable: FRONTEND_ORIGIN");
  });

  it("fails to import without DATABASE_SSL, which the session store needs", async () => {
    await expect(importAppWith({ DATABASE_SSL: "" })).rejects.toThrow('DATABASE_SSL must be "true" or "false", got: (missing)');
  });

  it("fails to import when APP_ENVIRONMENT is not one of the three known values", async () => {
    await expect(importAppWith({ APP_ENVIRONMENT: "qa" })).rejects.toThrow('APP_ENVIRONMENT must be "development", "staging" or "production", got: qa');
  });
});
