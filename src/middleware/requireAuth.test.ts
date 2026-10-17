import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import type { SessionUser } from "../lib/sessionUser.js";

const loadSessionUserMock = vi.fn<(userId: string) => Promise<SessionUser | null>>();
vi.mock("../lib/sessionUser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionUser.js")>()),
  loadSessionUser: (userId: string) => loadSessionUserMock(userId),
}));

const { requireAdmin, requireAuth } = await import("./requireAuth.js");

function user(overrides: Partial<SessionUser> = {}): SessionUser {
  return { id: "u1", displayName: "Tester", accessLevel: "trader", disabledAt: null, ...overrides };
}

beforeEach(() => {
  loadSessionUserMock.mockReset();
  loadSessionUserMock.mockImplementation(async (userId) => user({ id: userId }));
});
afterEach(() => vi.unstubAllEnvs());

async function runGuard(session: Record<string, unknown>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const next = vi.fn() as unknown as NextFunction;
  const destroy = vi.fn();
  const request = { session: { ...session, destroy } } as unknown as Request;
  await requireAuth(request, { status } as unknown as Response, next);
  return { status, json, next, destroy, request };
}

describe("requireAuth", () => {
  it("answers 401 with the standard body and does not continue when the session has no user", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    const { status, json, next } = await runGuard({});
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Not logged in." });
    expect(next).not.toHaveBeenCalled();
    expect(loadSessionUserMock).not.toHaveBeenCalled();
  });

  it("continues for any session with a user while passkeys are off, whatever the authentication method", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    for (const session of [{ userId: "u1" }, { userId: "u1", authMethod: "password" }, { userId: "u1", authMethod: "passkey" }]) {
      const { status, next } = await runGuard(session);
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });

  it("continues only for passkey and service-account sessions while passkeys are required", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    for (const authMethod of ["passkey", "service_password"]) {
      expect((await runGuard({ userId: "u1", authMethod })).next).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects password sessions, sessions without an authentication method, and pending enrolments while passkeys are required", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    const sessions = [
      { userId: "u1", authMethod: "password" },
      { userId: "u1" },
      { pendingPasskeyEnrollment: { userId: "u1", expiresAt: Date.now() + 60_000 } },
      { authMethod: "passkey" },
    ];
    for (const session of sessions) {
      const { status, next } = await runGuard(session);
      expect(status, JSON.stringify(session)).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("fails loudly instead of letting a request through when PASSKEY_LOGIN is missing or invalid", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "");
    await expect(runGuard({ userId: "u1" })).rejects.toThrow("Missing required environment variable: PASSKEY_LOGIN");
    vi.stubEnv("PASSKEY_LOGIN", "maybe");
    await expect(runGuard({ userId: "u1" })).rejects.toThrow('PASSKEY_LOGIN must be "off" or "required", got: maybe');
  });

  it("records the signed-in user on the request for the routes after it", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    loadSessionUserMock.mockResolvedValue(user({ id: "u7", accessLevel: "admin" }));
    const { request, next } = await runGuard({ userId: "u7" });
    expect(next).toHaveBeenCalledTimes(1);
    expect(request.sessionUser).toEqual(user({ id: "u7", accessLevel: "admin" }));
    expect(loadSessionUserMock).toHaveBeenCalledWith("u7");
  });

  it("answers 401 for a session whose user no longer exists", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    loadSessionUserMock.mockResolvedValue(null);
    const { status, json, next } = await runGuard({ userId: "gone" });
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Not logged in." });
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 401 for a disabled user and destroys the session", async () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    loadSessionUserMock.mockResolvedValue(user({ disabledAt: new Date("2026-10-17T00:00:00Z") }));
    const { status, json, next, destroy } = await runGuard({ userId: "u1" });
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "This account is disabled." });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireAdmin", () => {
  function runAdminGuard(sessionUser: SessionUser | undefined) {
    const json = vi.fn();
    const status = vi.fn().mockReturnValue({ json });
    const next = vi.fn() as unknown as NextFunction;
    requireAdmin({ sessionUser } as unknown as Request, { status } as unknown as Response, next);
    return { status, json, next };
  }

  it("lets an admin through", () => {
    const { status, next } = runAdminGuard(user({ accessLevel: "admin" }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(status).not.toHaveBeenCalled();
  });

  it("refuses a trader, and a request requireAuth has not identified, with 403", () => {
    for (const sessionUser of [user({ accessLevel: "trader" }), undefined]) {
      const { status, json, next } = runAdminGuard(sessionUser);
      expect(status).toHaveBeenCalledWith(403);
      expect(json).toHaveBeenCalledWith({ error: "Only an admin can do this." });
      expect(next).not.toHaveBeenCalled();
    }
  });
});
