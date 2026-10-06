import { afterEach, describe, expect, it, vi } from "vitest";
import { readPasskeyLoginMode, readPasskeyRelyingPartyId, validatePasskeyConfiguration } from "./passkeyLoginMode.js";

afterEach(() => vi.unstubAllEnvs());

describe("readPasskeyLoginMode", () => {
  it("accepts exactly off and required", () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    expect(readPasskeyLoginMode()).toBe("off");
    vi.stubEnv("PASSKEY_LOGIN", "required");
    expect(readPasskeyLoginMode()).toBe("required");
  });

  it("treats a missing or empty value as missing and rejects anything else, quoting it", () => {
    vi.stubEnv("PASSKEY_LOGIN", "");
    expect(() => readPasskeyLoginMode()).toThrow("Missing required environment variable: PASSKEY_LOGIN");
    for (const invalid of ["on", "Required", "true", "optional"]) {
      vi.stubEnv("PASSKEY_LOGIN", invalid);
      expect(() => readPasskeyLoginMode(), invalid).toThrow(`PASSKEY_LOGIN must be "off" or "required", got: ${invalid}`);
    }
  });
});

describe("readPasskeyRelyingPartyId", () => {
  it("returns the configured registrable domain, and throws when it is missing", () => {
    vi.stubEnv("PASSKEY_RP_ID", "ioriore.com");
    expect(readPasskeyRelyingPartyId()).toBe("ioriore.com");
    vi.stubEnv("PASSKEY_RP_ID", "");
    expect(() => readPasskeyRelyingPartyId()).toThrow("Missing required environment variable: PASSKEY_RP_ID");
  });
});

describe("validatePasskeyConfiguration", () => {
  it("needs no relying party id while passkeys are off", () => {
    vi.stubEnv("PASSKEY_LOGIN", "off");
    vi.stubEnv("PASSKEY_RP_ID", "");
    expect(() => validatePasskeyConfiguration()).not.toThrow();
  });

  it("requires the relying party id once passkeys are required", () => {
    vi.stubEnv("PASSKEY_LOGIN", "required");
    vi.stubEnv("PASSKEY_RP_ID", "");
    expect(() => validatePasskeyConfiguration()).toThrow("Missing required environment variable: PASSKEY_RP_ID");
    vi.stubEnv("PASSKEY_RP_ID", "localhost");
    expect(() => validatePasskeyConfiguration()).not.toThrow();
  });

  it("fails on a missing or invalid mode before anything else", () => {
    vi.stubEnv("PASSKEY_LOGIN", "");
    expect(() => validatePasskeyConfiguration()).toThrow("Missing required environment variable: PASSKEY_LOGIN");
    vi.stubEnv("PASSKEY_LOGIN", "sometimes");
    expect(() => validatePasskeyConfiguration()).toThrow('PASSKEY_LOGIN must be "off" or "required", got: sometimes');
  });
});
