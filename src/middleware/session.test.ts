import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real sessionMiddleware on a bare Express app. The Postgres-backed store is replaced by express-session's in-memory store (the
// real store and the full app are covered by app.smoke.db.test.ts); the options handed to the Postgres store are recorded instead.
const recordedStoreOptions = vi.hoisted(() => [] as Array<Record<string, any>>);
vi.mock("connect-pg-simple", () => ({
  default: (sessionLibrary: typeof import("express-session")) =>
    class RecordingStore extends sessionLibrary.MemoryStore {
      constructor(options: Record<string, any>) {
        super();
        recordedStoreOptions.push(options);
      }
    },
}));

const startedServers: Server[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  recordedStoreOptions.length = 0;
  await Promise.all(startedServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function loadSessionMiddleware(environmentOverrides: Record<string, string>) {
  vi.resetModules();
  vi.stubEnv("SESSION_SECRET", "unit-test-session-secret");
  vi.stubEnv("APP_ENVIRONMENT", "development");
  vi.stubEnv("DATABASE_SSL", "false");
  for (const [name, value] of Object.entries(environmentOverrides)) vi.stubEnv(name, value);
  return (await import("./session.js")).sessionMiddleware;
}

async function serveWithSessionMiddleware(environmentOverrides: Record<string, string>): Promise<string> {
  const sessionMiddleware = await loadSessionMiddleware(environmentOverrides);
  const app = express();
  app.set("trust proxy", 1);
  app.use(sessionMiddleware);
  app.get("/sign-in", (request, response) => {
    request.session.userId = "unit-test-user";
    response.json({ ok: true });
  });
  app.get("/look", (_request, response) => {
    response.json({ ok: true });
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  startedServers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function sessionSetCookie(response: Response): string | undefined {
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith("connect.sid="));
}

describe("sessionMiddleware cookie", () => {
  it("is HttpOnly, SameSite=Lax, path /, 30 days, and plain (not Secure) in development", async () => {
    const baseUrl = await serveWithSessionMiddleware({ APP_ENVIRONMENT: "development" });
    const setCookie = sessionSetCookie(await fetch(`${baseUrl}/sign-in`)) as string;
    expect(setCookie).toMatch(/;\s*HttpOnly/);
    expect(setCookie).toMatch(/;\s*SameSite=Lax/);
    expect(setCookie).toMatch(/;\s*Path=\//);
    expect(setCookie).not.toMatch(/;\s*Secure/);
    const expires = new Date((setCookie.match(/;\s*Expires=([^;]+)/) as RegExpMatchArray)[1] as string).getTime();
    expect(Math.abs((expires - Date.now()) / 1000 - 60 * 60 * 24 * 30)).toBeLessThan(120);
  });

  it("is Secure in staging and production when the proxy reports HTTPS", async () => {
    for (const appEnvironment of ["staging", "production"]) {
      const baseUrl = await serveWithSessionMiddleware({ APP_ENVIRONMENT: appEnvironment });
      const setCookie = sessionSetCookie(await fetch(`${baseUrl}/sign-in`, { headers: { "x-forwarded-proto": "https" } }));
      expect(setCookie, appEnvironment).toMatch(/;\s*Secure/);
    }
  });

  it("is not sent over a connection the proxy reports as plain HTTP in staging and production", async () => {
    for (const appEnvironment of ["staging", "production"]) {
      const baseUrl = await serveWithSessionMiddleware({ APP_ENVIRONMENT: appEnvironment });
      const response = await fetch(`${baseUrl}/sign-in`, { headers: { "x-forwarded-proto": "http" } });
      expect(sessionSetCookie(response), appEnvironment).toBeUndefined();
    }
  });

  it("is not created for a request that stores nothing in the session", async () => {
    const baseUrl = await serveWithSessionMiddleware({});
    expect(sessionSetCookie(await fetch(`${baseUrl}/look`))).toBeUndefined();
  });

  it("is signed: a tampered cookie value is not accepted as the same session", async () => {
    const baseUrl = await serveWithSessionMiddleware({});
    const issued = (sessionSetCookie(await fetch(`${baseUrl}/sign-in`)) as string).split(";")[0] as string;
    const tampered = `${issued.slice(0, -3)}AAA`;
    const response = await fetch(`${baseUrl}/sign-in`, { headers: { cookie: tampered } });
    const reissued = (sessionSetCookie(response) as string).split(";")[0];
    expect(reissued).not.toBe(tampered);
    expect(reissued).not.toBe(issued);
  });
});

describe("sessionMiddleware configuration", () => {
  it("hands the Postgres store a dedicated capped pool on the session table that it never creates itself", async () => {
    await loadSessionMiddleware({ DATABASE_URL: "postgres://example.invalid/unit_test_db", DATABASE_SSL: "false" });
    expect(recordedStoreOptions).toHaveLength(1);
    expect(recordedStoreOptions[0]).toMatchObject({
      tableName: "session",
      createTableIfMissing: false,
      conObject: { connectionString: "postgres://example.invalid/unit_test_db", max: 3, ssl: false },
    });
  });

  it("enables SSL for the session store pool when the database needs it", async () => {
    await loadSessionMiddleware({ DATABASE_SSL: "true" });
    expect(recordedStoreOptions[0]?.conObject.ssl).toEqual({ rejectUnauthorized: false });
  });

  it("refuses to load without SESSION_SECRET", async () => {
    await expect(loadSessionMiddleware({ SESSION_SECRET: "" })).rejects.toThrow("Missing required environment variable: SESSION_SECRET");
  });

  it("refuses to load with an unknown APP_ENVIRONMENT instead of guessing the cookie's secure flag", async () => {
    await expect(loadSessionMiddleware({ APP_ENVIRONMENT: "qa" })).rejects.toThrow('APP_ENVIRONMENT must be "development", "staging" or "production", got: qa');
  });

  it("refuses to load without DATABASE_SSL", async () => {
    await expect(loadSessionMiddleware({ DATABASE_SSL: "" })).rejects.toThrow('DATABASE_SSL must be "true" or "false", got: (missing)');
  });
});
