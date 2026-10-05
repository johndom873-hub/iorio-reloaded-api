import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createHmac } from "node:crypto";
import session from "express-session";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real auth routers and requireAuth on a small express app (in-memory sessions) against the test database. The WebAuthn
// cryptography is mocked: the browser-side ceremony (and so the real signature check) is exercised end to end with a
// virtual authenticator in Playwright. What is tested here is everything around it: which mode allows what, session
// state, challenge handling, enrolment rules, the service-account rule and the throttle.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run auth passkey route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
}));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));

const { db } = await import("../db/connection.js");
const { hashPassword } = await import("../lib/auth.js");
const { authRouter } = await import("./auth.js");
const { requireAuth } = await import("../middleware/requireAuth.js");
const { resetLoginFailuresForTests } = await import("../lib/loginFailureThrottle.js");
const { notifyTelegram } = await import("../lib/notifyTelegram.js");
const webauthn = await import("@simplewebauthn/server");

const testDb: Knex = db;
const verifyRegistrationResponse = vi.mocked(webauthn.verifyRegistrationResponse);
const verifyAuthenticationResponse = vi.mocked(webauthn.verifyAuthenticationResponse);

const password = "correct horse battery staple";
const runTag = `passkey-test-${Date.now()}`;
const regularUsername = `${runTag}-regular`;
const serviceUsername = `${runTag}-service`;
let regularUserId: string;
let serviceUserId: string;
let server: Server;
let baseUrl: string;
let sessionStore: session.MemoryStore;

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  const inserted = await testDb("users")
    .insert([
      { username: regularUsername, display_name: "Regular", password_hash: passwordHash },
      { username: serviceUsername, display_name: "Service", password_hash: passwordHash, is_service_account: true },
    ])
    .returning(["id", "username"]);
  regularUserId = inserted.find((row) => row.username === regularUsername)!.id;
  serviceUserId = inserted.find((row) => row.username === serviceUsername)!.id;

  const app = express();
  app.use(express.json());
  sessionStore = new session.MemoryStore();
  app.use(session({ store: sessionStore, secret: "test", resave: false, saveUninitialized: false }));
  app.use("/auth", authRouter);
  app.get("/protected", requireAuth, (_request, response) => {
    response.json({ ok: true });
  });
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb("users").whereIn("id", [regularUserId, serviceUserId]).delete();
  await testDb.destroy();
});

beforeEach(() => {
  process.env.PASSKEY_LOGIN = "required";
  process.env.PASSKEY_RP_ID = "localhost";
  resetLoginFailuresForTests();
  vi.mocked(notifyTelegram).mockClear();
  verifyRegistrationResponse.mockReset();
  verifyAuthenticationResponse.mockReset();
});

afterEach(async () => {
  await testDb("user_passkeys").whereIn("user_id", [regularUserId, serviceUserId]).delete();
});

// A browser: keeps its own session cookie between calls.
function browser() {
  let cookie = "";
  async function call(method: "GET" | "POST", path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = response.headers.getSetCookie()[0];
    if (setCookie) cookie = setCookie.split(";")[0]!;
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return { get: (path: string) => call("GET", path), post: call.bind(null, "POST") as (path: string, body?: unknown, headers?: Record<string, string>) => ReturnType<typeof call> };
}

const fakeRegistration = { id: "new-credential-id", rawId: "x", type: "public-key", response: {}, clientExtensionResults: {} };
function mockVerifiedRegistration(credentialId = "new-credential-id") {
  verifyRegistrationResponse.mockResolvedValue({
    verified: true,
    registrationInfo: {
      credential: { id: credentialId, publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ["internal"] },
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
    },
  } as never);
}

async function enrolWithPassword(client: ReturnType<typeof browser>, username = regularUsername) {
  return client.post("/auth/login", { username, password });
}

async function registerPasskey(client: ReturnType<typeof browser>, credentialId = "new-credential-id") {
  await client.post("/auth/passkey/register/options");
  mockVerifiedRegistration(credentialId);
  return client.post("/auth/passkey/register/verify", { ...fakeRegistration, id: credentialId });
}

async function signInWithPasskey(client: ReturnType<typeof browser>, credentialId: string, newCounter = 0) {
  await client.post("/auth/passkey/login/options");
  verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { credentialID: credentialId, newCounter } } as never);
  return client.post("/auth/passkey/login/verify", { id: credentialId });
}

describe("PASSKEY_LOGIN=off", () => {
  beforeEach(() => {
    process.env.PASSKEY_LOGIN = "off";
  });

  it("reports passkeys as not required and signs in with the password as before", async () => {
    const client = browser();
    expect((await client.get("/auth/config")).body).toEqual({ passkeyLoginRequired: false });
    const login = await client.post("/auth/login", { username: regularUsername, password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ id: regularUserId, username: regularUsername });
    expect((await client.get("/auth/session")).status).toBe(200);
    expect((await client.get("/protected")).status).toBe(200);
  });

  it("does not expose the passkey routes", async () => {
    const client = browser();
    expect((await client.post("/auth/passkey/login/options")).status).toBe(404);
    expect((await client.post("/auth/passkey/register/options")).status).toBe(404);
  });
});

describe("PASSKEY_LOGIN=required: password step", () => {
  it("reports passkeys as required", async () => {
    expect((await browser().get("/auth/config")).body).toEqual({ passkeyLoginRequired: true });
  });

  it("a correct password opens enrolment but does not sign anyone in", async () => {
    const client = browser();
    const login = await enrolWithPassword(client);
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ status: "passkey_enrollment_required" });
    expect((await client.get("/auth/session")).status).toBe(401);
    expect((await client.get("/protected")).status).toBe(401);
  });

  it("a wrong password is refused as before", async () => {
    const login = await browser().post("/auth/login", { username: regularUsername, password: "nope" });
    expect(login.status).toBe(401);
  });

  it("refuses the password once the user has a passkey that has worked, pointing at the passkey button", async () => {
    await testDb("user_passkeys").insert({
      user_id: regularUserId, credential_id: "used-credential", public_key: Buffer.from([1]), device_type: "multiDevice", backed_up: true, last_used_at: new Date(),
    });
    const client = browser();
    const login = await enrolWithPassword(client);
    expect(login.status).toBe(403);
    expect(login.body.error).toContain("passkey");
    expect((await client.get("/auth/session")).status).toBe(401);
  });

  it("still allows enrolment when the user's only passkey has never signed in (saved but never worked)", async () => {
    await testDb("user_passkeys").insert({
      user_id: regularUserId, credential_id: "never-used", public_key: Buffer.from([1]), device_type: "multiDevice", backed_up: true,
    });
    const login = await enrolWithPassword(browser());
    expect(login.body).toEqual({ status: "passkey_enrollment_required" });
  });
});

describe("PASSKEY_LOGIN=required: enrolment", () => {
  it("refuses to start registration without a correct password first", async () => {
    expect((await browser().post("/auth/passkey/register/options")).status).toBe(401);
  });

  it("offers a discoverable, user-verified registration for the RP ID, labelled with the environment", async () => {
    const client = browser();
    await enrolWithPassword(client);
    const options = await client.post("/auth/passkey/register/options");
    expect(options.status).toBe(200);
    expect(options.body.rp).toMatchObject({ id: "localhost", name: "Iorio Reloaded" });
    expect(options.body.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(options.body.user.name).toBe(`${regularUsername} (development)`);
    expect(options.body.attestation).toBe("none");
  });

  it("stores the passkey, alerts Telegram, closes the enrolment window and still does not sign in", async () => {
    const client = browser();
    await enrolWithPassword(client);
    const registered = await registerPasskey(client);
    expect(registered.body).toEqual({ status: "registered" });

    const stored = await testDb("user_passkeys").where({ user_id: regularUserId }).first();
    expect(stored).toMatchObject({ credential_id: "new-credential-id", device_type: "multiDevice", backed_up: true, last_used_at: null });
    expect(Buffer.from(stored.public_key)).toEqual(Buffer.from([1, 2, 3]));
    expect(stored.transports).toEqual(["internal"]);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyTelegram).mock.calls[0]![0]).toContain(regularUsername);

    expect((await client.get("/auth/session")).status).toBe(401);
    expect((await client.post("/auth/passkey/register/options")).status).toBe(401);
  });

  it("replaces an earlier passkey that never signed in", async () => {
    await testDb("user_passkeys").insert({
      user_id: regularUserId, credential_id: "never-used", public_key: Buffer.from([9]), device_type: "singleDevice", backed_up: false,
    });
    const client = browser();
    await enrolWithPassword(client);
    await registerPasskey(client, "second-attempt");
    const ids = (await testDb("user_passkeys").where({ user_id: regularUserId })).map((row) => row.credential_id);
    expect(ids).toEqual(["second-attempt"]);
  });

  it("rejects a registration that fails verification and stores nothing", async () => {
    const client = browser();
    await enrolWithPassword(client);
    await client.post("/auth/passkey/register/options");
    verifyRegistrationResponse.mockResolvedValue({ verified: false } as never);
    const result = await client.post("/auth/passkey/register/verify", fakeRegistration);
    expect(result.status).toBe(400);
    expect(await testDb("user_passkeys").where({ user_id: regularUserId })).toHaveLength(0);
    expect(notifyTelegram).not.toHaveBeenCalled();
  });

  it("rejects a registration whose verification throws", async () => {
    const client = browser();
    await enrolWithPassword(client);
    await client.post("/auth/passkey/register/options");
    verifyRegistrationResponse.mockRejectedValue(new Error("Unexpected registration response origin"));
    const result = await client.post("/auth/passkey/register/verify", fakeRegistration);
    expect(result.status).toBe(400);
    expect(result.body.error).toContain("origin");
  });

  it("uses a registration challenge once", async () => {
    const client = browser();
    await enrolWithPassword(client);
    await client.post("/auth/passkey/register/options");
    mockVerifiedRegistration();
    expect((await client.post("/auth/passkey/register/verify", fakeRegistration)).status).toBe(200);
    expect((await client.post("/auth/passkey/register/verify", fakeRegistration)).status).toBe(401);
  });

  it("refuses registration verify when no registration was started", async () => {
    const client = browser();
    await enrolWithPassword(client);
    mockVerifiedRegistration();
    expect((await client.post("/auth/passkey/register/verify", fakeRegistration)).status).toBe(401);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });
});

describe("PASSKEY_LOGIN=required: passkey sign-in", () => {
  beforeEach(async () => {
    await testDb("user_passkeys").insert({
      user_id: regularUserId, credential_id: "regular-credential", public_key: Buffer.from([1, 2, 3]), counter: 4, transports: ["internal"], device_type: "multiDevice", backed_up: true,
    });
  });

  it("asks for a user-verified, username-less assertion", async () => {
    const options = await browser().post("/auth/passkey/login/options");
    expect(options.status).toBe(200);
    expect(options.body).toMatchObject({ rpId: "localhost", userVerification: "required" });
    expect(options.body.allowCredentials ?? []).toEqual([]);
  });

  it("signs the user in, records the use and passes the stored credential to the verifier", async () => {
    const client = browser();
    const result = await signInWithPasskey(client, "regular-credential", 5);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: regularUserId, username: regularUsername, displayName: "Regular" });

    expect((await client.get("/auth/session")).status).toBe(200);
    expect((await client.get("/protected")).status).toBe(200);
    const stored = await testDb("user_passkeys").where({ credential_id: "regular-credential" }).first();
    expect(Number(stored.counter)).toBe(5);
    expect(stored.last_used_at).not.toBeNull();

    const verifierArguments = verifyAuthenticationResponse.mock.calls[0]![0];
    expect(verifierArguments).toMatchObject({ expectedRPID: "localhost", requireUserVerification: true });
    expect(verifierArguments.credential).toMatchObject({ id: "regular-credential", counter: 4, transports: ["internal"] });
    expect(Array.from(verifierArguments.credential.publicKey)).toEqual([1, 2, 3]);
  });

  it("refuses a passkey the server does not know, without calling the verifier", async () => {
    const client = browser();
    await client.post("/auth/passkey/login/options");
    const result = await client.post("/auth/passkey/login/verify", { id: "someone-elses-credential" });
    expect(result.status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect((await client.get("/auth/session")).status).toBe(401);
  });

  it("refuses an assertion that fails verification, or whose verification throws", async () => {
    const client = browser();
    await client.post("/auth/passkey/login/options");
    verifyAuthenticationResponse.mockResolvedValue({ verified: false, authenticationInfo: {} } as never);
    expect((await client.post("/auth/passkey/login/verify", { id: "regular-credential" })).status).toBe(401);

    await client.post("/auth/passkey/login/options");
    verifyAuthenticationResponse.mockRejectedValue(new Error("bad signature"));
    expect((await client.post("/auth/passkey/login/verify", { id: "regular-credential" })).status).toBe(401);
    expect((await client.get("/auth/session")).status).toBe(401);
    const stored = await testDb("user_passkeys").where({ credential_id: "regular-credential" }).first();
    expect(stored.last_used_at).toBeNull();
  });

  it("refuses a verify call with no outstanding challenge, and a challenge used twice", async () => {
    const client = browser();
    verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { credentialID: "regular-credential", newCounter: 5 } } as never);
    expect((await client.post("/auth/passkey/login/verify", { id: "regular-credential" })).status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();

    const second = browser();
    await signInWithPasskey(second, "regular-credential");
    const replayClient = browser();
    expect((await replayClient.post("/auth/passkey/login/verify", { id: "regular-credential" })).status).toBe(401);
  });

  it("does not accept a registration challenge as a sign-in challenge", async () => {
    const client = browser();
    await enrolWithPassword(client);
    // The user above has a never-used passkey, so enrolment is open and a registration challenge is outstanding.
    await client.post("/auth/passkey/register/options");
    verifyAuthenticationResponse.mockResolvedValue({ verified: true, authenticationInfo: { credentialID: "regular-credential", newCounter: 5 } } as never);
    expect((await client.post("/auth/passkey/login/verify", { id: "regular-credential" })).status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it("once a passkey has worked, the password alone is refused for that user", async () => {
    await signInWithPasskey(browser(), "regular-credential");
    const client = browser();
    expect((await enrolWithPassword(client)).status).toBe(403);
  });

  it("throttles an address after ten failed passkey sign-ins", async () => {
    const client = browser();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await client.post("/auth/passkey/login/options");
      expect((await client.post("/auth/passkey/login/verify", { id: "unknown" })).status).toBe(401);
    }
    expect((await client.post("/auth/passkey/login/options")).status).toBe(429);
    expect((await client.post("/auth/login", { username: regularUsername, password })).status).toBe(429);
  });
});

describe("PASSKEY_LOGIN=required: service account", () => {
  it("signs in with the password over the loopback (no X-Forwarded-For) and the session works", async () => {
    const client = browser();
    const login = await client.post("/auth/login", { username: serviceUsername, password });
    expect(login.status).toBe(200);
    expect(login.body).toMatchObject({ id: serviceUserId });
    expect((await client.get("/protected")).status).toBe(200);
  });

  it("refuses the password when the request came through the router (X-Forwarded-For present)", async () => {
    const client = browser();
    const login = await client.post("/auth/login", { username: serviceUsername, password }, { "X-Forwarded-For": "203.0.113.9" });
    expect(login.status).toBe(401);
    expect(login.body.error).toBe("Invalid username or password.");
    expect((await client.get("/protected")).status).toBe(401);
  });

  it("does not let a regular user skip the passkey by omitting X-Forwarded-For", async () => {
    const client = browser();
    const login = await enrolWithPassword(client);
    expect(login.body).toEqual({ status: "passkey_enrollment_required" });
    expect((await client.get("/protected")).status).toBe(401);
  });
});

describe("switching the mode", () => {
  it("rejects a password session created while off once passkeys are required, and accepts it again when set back to off", async () => {
    process.env.PASSKEY_LOGIN = "off";
    const client = browser();
    await client.post("/auth/login", { username: regularUsername, password });
    expect((await client.get("/protected")).status).toBe(200);

    process.env.PASSKEY_LOGIN = "required";
    expect((await client.get("/protected")).status).toBe(401);
    expect((await client.get("/auth/session")).status).toBe(401);

    process.env.PASSKEY_LOGIN = "off";
    expect((await client.get("/protected")).status).toBe(200);
  });

  it("rejects a session with a user id but no recorded authentication method once passkeys are required", async () => {
    const legacySessionId = "legacy-session";
    await new Promise<void>((resolve, reject) =>
      sessionStore.set(legacySessionId, { cookie: { originalMaxAge: null, httpOnly: true, path: "/" }, userId: regularUserId } as session.SessionData, (error) => (error ? reject(error) : resolve())),
    );
    // express-session reads the session by the signed cookie value ("s:<id>.<HMAC-SHA256, unpadded base64>").
    const signature = createHmac("sha256", "test").update(legacySessionId).digest("base64").replace(/=+$/, "");
    const cookie = `connect.sid=${encodeURIComponent(`s:${legacySessionId}.${signature}`)}`;

    process.env.PASSKEY_LOGIN = "off";
    expect((await fetch(`${baseUrl}/protected`, { headers: { Cookie: cookie } })).status).toBe(200);
    process.env.PASSKEY_LOGIN = "required";
    expect((await fetch(`${baseUrl}/protected`, { headers: { Cookie: cookie } })).status).toBe(401);
  });
});
