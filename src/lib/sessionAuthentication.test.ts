import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { isAuthenticatedSession, regenerateSession } from "./sessionAuthentication.js";

afterEach(() => vi.unstubAllEnvs());

describe("isAuthenticatedSession", () => {
  it("is false without a user id in either mode", () => {
    for (const mode of ["off", "required"]) {
      vi.stubEnv("PASSKEY_LOGIN", mode);
      expect(isAuthenticatedSession({})).toBe(false);
      expect(isAuthenticatedSession({ authMethod: "passkey" })).toBe(false);
      expect(isAuthenticatedSession({ userId: "" })).toBe(false);
    }
  });

  it("is true for any session with a user id while passkeys are off", () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    expect(isAuthenticatedSession({ userId: "u1" })).toBe(true);
    expect(isAuthenticatedSession({ userId: "u1", authMethod: "password" })).toBe(true);
  });

  it("accepts only passkey and service_password sessions while passkeys are required", () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    expect(isAuthenticatedSession({ userId: "u1", authMethod: "passkey" })).toBe(true);
    expect(isAuthenticatedSession({ userId: "u1", authMethod: "service_password" })).toBe(true);
    expect(isAuthenticatedSession({ userId: "u1", authMethod: "password" })).toBe(false);
    expect(isAuthenticatedSession({ userId: "u1" })).toBe(false);
  });
});

describe("regenerateSession", () => {
  it("resolves once the session has been regenerated", async () => {
    const regenerate = vi.fn((callback: (error?: unknown) => void) => callback());
    await expect(regenerateSession({ session: { regenerate } } as unknown as Request)).resolves.toBeUndefined();
    expect(regenerate).toHaveBeenCalledTimes(1);
  });

  it("rejects with the store's error so a failed regeneration never leaves the old id authenticated", async () => {
    const storeFailure = new Error("session store down");
    const regenerate = vi.fn((callback: (error?: unknown) => void) => callback(storeFailure));
    await expect(regenerateSession({ session: { regenerate } } as unknown as Request)).rejects.toBe(storeFailure);
  });
});
