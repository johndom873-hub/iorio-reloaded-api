import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { requireAuth } from "./requireAuth.js";

afterEach(() => vi.unstubAllEnvs());

function runGuard(session: Record<string, unknown>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const next = vi.fn() as unknown as NextFunction;
  requireAuth({ session } as unknown as Request, { status } as unknown as Response, next);
  return { status, json, next };
}

describe("requireAuth", () => {
  it("answers 401 with the standard body and does not continue when the session has no user", () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    const { status, json, next } = runGuard({});
    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ error: "Not logged in." });
    expect(next).not.toHaveBeenCalled();
  });

  it("continues for any session with a user while passkeys are off, whatever the authentication method", () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    for (const session of [{ userId: "u1" }, { userId: "u1", authMethod: "password" }, { userId: "u1", authMethod: "passkey" }]) {
      const { status, next } = runGuard(session);
      expect(next).toHaveBeenCalledTimes(1);
      expect(status).not.toHaveBeenCalled();
    }
  });

  it("continues only for passkey and service-account sessions while passkeys are required", () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    for (const authMethod of ["passkey", "service_password"]) {
      expect(runGuard({ userId: "u1", authMethod }).next).toHaveBeenCalledTimes(1);
    }
  });

  it("rejects password sessions, sessions without an authentication method, and pending enrolments while passkeys are required", () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    const sessions = [
      { userId: "u1", authMethod: "password" },
      { userId: "u1" },
      { pendingPasskeyEnrollment: { userId: "u1", expiresAt: Date.now() + 60_000 } },
      { authMethod: "passkey" },
    ];
    for (const session of sessions) {
      const { status, next } = runGuard(session);
      expect(status, JSON.stringify(session)).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("fails loudly instead of letting a request through when PASSKEY_LOGIN is missing or invalid", () => {
    vi.stubEnv("PASSKEY_LOGIN", "");
    expect(() => runGuard({ userId: "u1" })).toThrow("Missing required environment variable: PASSKEY_LOGIN");
    vi.stubEnv("PASSKEY_LOGIN", "maybe");
    expect(() => runGuard({ userId: "u1" })).toThrow('PASSKEY_LOGIN must be "off" or "required", got: maybe');
  });
});
