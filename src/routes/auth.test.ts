import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real authRouter and requireAuth on a small express app (in-memory sessions) against the test database. authPasskeys.test.ts
// covers the passkey ceremony and the required-mode password step; this file covers the rest of the password login (validation,
// matching, session regeneration, the failure throttle), logout and the session read.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run auth route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const { hashPassword } = await import("../lib/auth.js");
const { authRouter } = await import("./auth.js");
const { requireAuth } = await import("../middleware/requireAuth.js");
const { resetLoginFailuresForTests } = await import("../lib/loginFailureThrottle.js");

const testDb: Knex = db;

const password = "correct horse battery staple";
const runTag = `auth-route-${Date.now()}`;
const mixedCaseUsername = `Auth-Route-${Date.now()}`;
const deletedUsername = `${runTag}-deleted`;
const originalPasskeyLoginMode = process.env.PASSKEY_LOGIN;
const originalPasskeyRelyingPartyId = process.env.PASSKEY_RP_ID;

let userId: string;
let server: Server;
let baseUrl: string;
let sessionStore: session.MemoryStore;

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  const [user] = await testDb("users").insert({ username: mixedCaseUsername, display_name: "Auth Route Tester", password_hash: passwordHash }).returning("id");
  userId = user.id;

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  sessionStore = new session.MemoryStore();
  app.use(session({ store: sessionStore, secret: "test", resave: false, saveUninitialized: false }));
  app.use((request, _response, next) => {
    // Lets a test make the session store fail to destroy, to reach the logout error branch.
    if (request.header("x-test-destroy-fails")) request.session.destroy = ((callback: (error?: unknown) => void) => callback(new Error("store down"))) as typeof request.session.destroy;
    next();
  });
  app.post("/touch", (request, response) => {
    (request.session as unknown as { touched: boolean }).touched = true;
    response.json({ ok: true });
  });
  app.use("/auth", authRouter);
  app.get("/protected", requireAuth, (_request, response) => {
    response.json({ ok: true });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  process.env.PASSKEY_LOGIN = "off";
  process.env.PASSKEY_RP_ID = "localhost";
  resetLoginFailuresForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await testDb("users").whereIn("id", [userId]).del();
  await testDb("users").where({ username: deletedUsername }).del();
  await testDb.destroy();
  if (originalPasskeyLoginMode === undefined) delete process.env.PASSKEY_LOGIN;
  else process.env.PASSKEY_LOGIN = originalPasskeyLoginMode;
  if (originalPasskeyRelyingPartyId === undefined) delete process.env.PASSKEY_RP_ID;
  else process.env.PASSKEY_RP_ID = originalPasskeyRelyingPartyId;
});

/** A browser: keeps its own session cookie between calls and exposes the raw response headers. */
function browser() {
  let cookie = "";
  async function call(method: "GET" | "POST", path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie();
    const sessionCookie = setCookie.find((header) => header.startsWith("connect.sid="));
    if (sessionCookie) cookie = sessionCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, body: text && (response.headers.get("content-type") ?? "").includes("application/json") ? JSON.parse(text) : null, setCookie };
  }
  return {
    get: (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => call("POST", path, body, headers),
    cookie: () => cookie,
  };
}

const sessionIdOfCookie = (cookie: string) => decodeURIComponent(cookie.slice("connect.sid=".length)).slice(2).split(".")[0]!;
const readStoredSession = (sessionId: string) => new Promise<session.SessionData | null | undefined>((resolve, reject) => sessionStore.get(sessionId, (error, stored) => (error ? reject(error) : resolve(stored))));

const wrongLogin = (client: ReturnType<typeof browser>, address: string) => client.post("/auth/login", { username: mixedCaseUsername, password: "wrong" }, { "X-Forwarded-For": address });
const rightLogin = (client: ReturnType<typeof browser>, address: string) => client.post("/auth/login", { username: mixedCaseUsername, password }, { "X-Forwarded-For": address });

describe("GET /auth/config", () => {
  it("needs no session", async () => {
    expect((await browser().get("/auth/config")).status).toBe(200);
  });

  it("is a 500 when PASSKEY_LOGIN holds neither off nor required", async () => {
    process.env.PASSKEY_LOGIN = "maybe";
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await browser().get("/auth/config")).status).toBe(500);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("POST /auth/login: validation", () => {
  it.each([
    ["no body fields", {}],
    ["no password", { username: mixedCaseUsername }],
    ["no username", { password }],
    ["an empty username", { username: "", password }],
    ["an empty password", { username: mixedCaseUsername, password: "" }],
    ["a null password", { username: mixedCaseUsername, password: null }],
  ])("%s is a 400 and starts no session", async (_label, body) => {
    const client = browser();
    const response = await client.post("/auth/login", body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: "Username and password are required." });
    expect(response.setCookie).toEqual([]);
  });

  it("a request with no JSON body at all is a 400", async () => {
    const response = await fetch(`${baseUrl}/auth/login`, { method: "POST" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Username and password are required." });
  });

  it("requests refused for missing fields do not count towards the throttle", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 12; attempt += 1) await client.post("/auth/login", { username: mixedCaseUsername }, { "X-Forwarded-For": "10.0.0.1" });
    expect((await rightLogin(client, "10.0.0.1")).status).toBe(200);
  });

  it("a username that is not text is a 400, like a missing one", async () => {
    for (const value of [12345, ["a"], { name: "x" }, true]) {
      expect((await browser().post("/auth/login", { username: value, password })).status, JSON.stringify(value)).toBe(400);
    }
  });
});

describe("POST /auth/login: credentials", () => {
  it("signs the user in: answers with id, username and display name only, and the session then works", async () => {
    const client = browser();
    const login = await client.post("/auth/login", { username: mixedCaseUsername, password });

    expect(login.status).toBe(200);
    expect(login.body).toEqual({ id: userId, username: mixedCaseUsername, displayName: "Auth Route Tester" });
    expect(login.setCookie.some((header) => header.startsWith("connect.sid=") && header.includes("HttpOnly"))).toBe(true);
    expect((await client.get("/protected")).status).toBe(200);
    expect((await client.get("/auth/session")).body).toEqual({ id: userId, username: mixedCaseUsername, displayName: "Auth Route Tester" });
  });

  it("stores the user id and the password authentication method in the session", async () => {
    const client = browser();
    await client.post("/auth/login", { username: mixedCaseUsername, password });
    expect(await readStoredSession(sessionIdOfCookie(client.cookie()))).toMatchObject({ userId, authMethod: "password" });
  });

  it.each([
    ["lower case", mixedCaseUsername.toLowerCase()],
    ["upper case", mixedCaseUsername.toUpperCase()],
  ])("matches the username in %s, and answers with the stored spelling", async (_label, typed) => {
    const login = await browser().post("/auth/login", { username: typed, password });
    expect(login.status).toBe(200);
    expect(login.body.username).toBe(mixedCaseUsername);
  });

  it("does not trim the username: a trailing space is an unknown user", async () => {
    expect((await browser().post("/auth/login", { username: `${mixedCaseUsername} `, password })).status).toBe(401);
  });

  it("the password is case-sensitive", async () => {
    expect((await browser().post("/auth/login", { username: mixedCaseUsername, password: password.toUpperCase() })).status).toBe(401);
  });

  it("a wrong password and an unknown user get the same 401 and no session cookie", async () => {
    const client = browser();
    const wrongPassword = await client.post("/auth/login", { username: mixedCaseUsername, password: "wrong" });
    const unknownUser = await client.post("/auth/login", { username: `${runTag}-nobody`, password });
    expect(wrongPassword).toMatchObject({ status: 401, body: { error: "Invalid username or password." }, setCookie: [] });
    expect(unknownUser).toMatchObject({ status: 401, body: { error: "Invalid username or password." }, setCookie: [] });
    expect((await client.get("/protected")).status).toBe(401);
  });

  it("a password that is not text is a 400 (never an unhandled error) and signs nobody in", async () => {
    const client = browser();
    for (const value of [12345, ["x"], { p: 1 }, true]) {
      expect((await client.post("/auth/login", { username: mixedCaseUsername, password: value })).status, JSON.stringify(value)).toBe(400);
    }
    expect((await client.get("/protected")).status).toBe(401);
  });

  it("gives the browser a fresh session id on login, and the one it carried before no longer exists", async () => {
    const client = browser();
    await client.post("/touch", {});
    const sessionIdBefore = sessionIdOfCookie(client.cookie());
    expect(await readStoredSession(sessionIdBefore)).toMatchObject({ touched: true });

    await client.post("/auth/login", { username: mixedCaseUsername, password });

    const sessionIdAfter = sessionIdOfCookie(client.cookie());
    expect(sessionIdAfter).not.toBe(sessionIdBefore);
    expect(await readStoredSession(sessionIdBefore)).toBeUndefined();
    expect(await readStoredSession(sessionIdAfter)).toMatchObject({ userId });
  });

  it("a session an attacker planted before login does not become the signed-in one", async () => {
    const attacker = browser();
    await attacker.post("/touch", {});
    // The victim's browser was handed the attacker's session cookie.
    const plantedCookie = attacker.cookie();
    const response = await fetch(`${baseUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: plantedCookie }, body: JSON.stringify({ username: mixedCaseUsername, password }) });
    expect(response.status).toBe(200);
    expect((await fetch(`${baseUrl}/protected`, { headers: { Cookie: plantedCookie } })).status).toBe(401);
  });
});

describe("POST /auth/login: failure throttle", () => {
  it("refuses the eleventh attempt from an address after ten failures, even with the correct password, and starts no session", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) expect((await wrongLogin(client, "10.1.0.1")).status).toBe(401);

    const throttled = await rightLogin(client, "10.1.0.1");

    expect(throttled).toMatchObject({ status: 429, body: { error: "Too many failed login attempts — try again in 15 minutes." }, setCookie: [] });
    expect((await client.get("/protected")).status).toBe(401);
  });

  it("nine failures do not throttle", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 9; attempt += 1) await wrongLogin(client, "10.1.0.2");
    expect((await rightLogin(client, "10.1.0.2")).status).toBe(200);
  });

  it("an unknown username counts as a failure just like a wrong password", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) await client.post("/auth/login", { username: `${runTag}-nobody`, password }, { "X-Forwarded-For": "10.1.0.3" });
    expect((await rightLogin(client, "10.1.0.3")).status).toBe(429);
  });

  it("is per address: another address is unaffected while the first stays throttled", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongLogin(client, "10.1.0.4");

    expect((await rightLogin(browser(), "10.1.0.5")).status).toBe(200);
    expect((await rightLogin(browser(), "10.1.0.4")).status).toBe(429);
  });

  it("identifies the address by the entry the router appended, so a client cannot dodge the throttle by forging X-Forwarded-For", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongLogin(client, `192.0.2.${attempt}, 10.1.0.6`);

    expect((await rightLogin(browser(), "198.51.100.7, 10.1.0.6")).status).toBe(429);
    expect((await rightLogin(browser(), "10.1.0.6, 172.16.0.1")).status).toBe(200);
  });

  it("a successful login clears the address's failures", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 9; attempt += 1) await wrongLogin(client, "10.1.0.7");
    expect((await rightLogin(client, "10.1.0.7")).status).toBe(200);

    for (let attempt = 0; attempt < 9; attempt += 1) await wrongLogin(client, "10.1.0.7");
    expect((await rightLogin(client, "10.1.0.7")).status).toBe(200);
  });

  it("a throttled address stays throttled for the whole 15 minutes and is free again at 15 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongLogin(client, "10.1.0.8");

    vi.setSystemTime(new Date("2026-03-10T12:14:59.999Z"));
    expect((await rightLogin(client, "10.1.0.8")).status).toBe(429);

    vi.setSystemTime(new Date("2026-03-10T12:15:00Z"));
    expect((await rightLogin(client, "10.1.0.8")).status).toBe(200);
  });

  it("failures older than 15 minutes stop counting, so spaced-out failures never throttle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const client = browser();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 2, 10, 12, attempt * 8)));
      expect((await wrongLogin(client, "10.1.0.9")).status).toBe(401);
    }
  });

  it("is checked before the password: a throttled address gets 429 for an unknown user too", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) await wrongLogin(client, "10.1.0.10");
    expect((await client.post("/auth/login", { username: `${runTag}-nobody`, password: "x" }, { "X-Forwarded-For": "10.1.0.10" })).status).toBe(429);
  });

  it("applies when passkeys are required too, and a correct password that opens enrolment clears the failures", async () => {
    process.env.PASSKEY_LOGIN = "required";
    const client = browser();
    for (let attempt = 0; attempt < 9; attempt += 1) await wrongLogin(client, "10.1.0.11");
    expect((await rightLogin(client, "10.1.0.11")).body).toEqual({ status: "passkey_enrollment_required" });
    for (let attempt = 0; attempt < 9; attempt += 1) await wrongLogin(client, "10.1.0.11");
    expect((await rightLogin(client, "10.1.0.11")).status).toBe(200);

    for (let attempt = 0; attempt < 10; attempt += 1) await wrongLogin(client, "10.1.0.12");
    expect((await rightLogin(client, "10.1.0.12")).status).toBe(429);
  });
});

describe("POST /auth/logout", () => {
  it("ends the session: 204, the cookie is cleared, the stored session is gone and the old cookie no longer works", async () => {
    const client = browser();
    await client.post("/auth/login", { username: mixedCaseUsername, password });
    const cookieBefore = client.cookie();
    expect((await client.get("/protected")).status).toBe(200);

    const logout = await client.post("/auth/logout");

    expect(logout.status).toBe(204);
    expect(logout.body).toBeNull();
    expect(logout.setCookie.some((header) => header.startsWith("connect.sid=;") && /expires=Thu, 01 Jan 1970/i.test(header))).toBe(true);
    expect(await readStoredSession(sessionIdOfCookie(cookieBefore))).toBeUndefined();
    const replay = await fetch(`${baseUrl}/protected`, { headers: { Cookie: cookieBefore } });
    expect(replay.status).toBe(401);
    expect((await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: cookieBefore } })).status).toBe(401);
  });

  it("logging out with no session is still a 204", async () => {
    expect((await browser().post("/auth/logout")).status).toBe(204);
  });

  it("logging out twice is a 204 both times", async () => {
    const client = browser();
    await client.post("/auth/login", { username: mixedCaseUsername, password });
    expect((await client.post("/auth/logout")).status).toBe(204);
    expect((await client.post("/auth/logout")).status).toBe(204);
  });

  it("a session store that cannot destroy the session is a 500 with a message, and the cookie is not cleared", async () => {
    const client = browser();
    await client.post("/auth/login", { username: mixedCaseUsername, password });

    const logout = await client.post("/auth/logout", undefined, { "x-test-destroy-fails": "1" });

    expect(logout.status).toBe(500);
    expect(logout.body).toEqual({ error: "Failed to log out." });
    expect(logout.setCookie.some((header) => header.startsWith("connect.sid=;"))).toBe(false);
    expect((await client.get("/protected")).status).toBe(200);
  });
});

describe("GET /auth/session", () => {
  it("without a session is a 401", async () => {
    expect(await browser().get("/auth/session")).toMatchObject({ status: 401, body: { error: "Not logged in." } });
  });

  it("with a session that has no user is a 401", async () => {
    const client = browser();
    await client.post("/touch", {});
    expect((await client.get("/auth/session")).status).toBe(401);
  });

  it("for a user deleted after signing in is a 401, while requireAuth still lets the session through", async () => {
    const passwordHash = await hashPassword(password);
    await testDb("users").insert({ username: deletedUsername, display_name: "Soon Deleted", password_hash: passwordHash });
    const client = browser();
    expect((await client.post("/auth/login", { username: deletedUsername, password })).status).toBe(200);
    expect((await client.get("/auth/session")).status).toBe(200);

    await testDb("users").where({ username: deletedUsername }).del();

    expect(await client.get("/auth/session")).toMatchObject({ status: 401, body: { error: "Not logged in." } });
    expect((await client.get("/protected")).status).toBe(200);
  });

  it("reads the display name and username as they are now", async () => {
    const client = browser();
    await client.post("/auth/login", { username: mixedCaseUsername, password });
    await testDb("users").where({ id: userId }).update({ display_name: "Renamed Tester" });
    try {
      expect((await client.get("/auth/session")).body).toEqual({ id: userId, username: mixedCaseUsername, displayName: "Renamed Tester" });
    } finally {
      await testDb("users").where({ id: userId }).update({ display_name: "Auth Route Tester" });
    }
  });

  it("never exposes the password hash", async () => {
    const client = browser();
    const login = await client.post("/auth/login", { username: mixedCaseUsername, password });
    const sessionRead = await client.get("/auth/session");
    for (const body of [login.body, sessionRead.body]) expect(JSON.stringify(body)).not.toMatch(/argon2|password/i);
  });
});
