import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// dotenv is replaced by a no-op so that a variable removed here stays missing instead of being refilled from the developer's .env.
vi.mock("dotenv/config", () => ({}));

const completeEnvironment: Record<string, string> = {
  DATABASE_URL: "postgres://example.invalid/unit_test_db",
  FRONTEND_ORIGIN: "https://frontend.unit-test.example",
  IBKR_TRADING_MODE: "paper",
  IBKR_TUNNEL_SSH_HOST: "tunnel.unit-test.example",
  IBKR_TUNNEL_SSH_PORT: "2222",
  IBKR_TUNNEL_SSH_USERNAME: "tunnel-user",
  IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64: "a2V5",
  IBKR_GATEWAY_HOST: "gateway.unit-test.example",
};
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;

function stubCompleteEnvironment(overrides: Record<string, string | undefined> = {}): void {
  vi.resetModules();
  for (const [name, value] of Object.entries({ ...completeEnvironment, ...overrides })) {
    if (value === undefined) vi.stubEnv(name, undefined as unknown as string);
    else vi.stubEnv(name, value);
  }
  for (const [name, value] of Object.entries(overrides)) if (value === undefined) delete process.env[name];
}

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  if (originalTestDatabaseUrl === undefined) delete process.env.TEST_DATABASE_URL;
  else process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
});

describe("requireEnvironmentVariable", () => {
  it("returns the value of a set variable, untouched", async () => {
    stubCompleteEnvironment();
    vi.stubEnv("SOME_UNIT_TEST_VARIABLE", " spaced value ");
    const { requireEnvironmentVariable } = await import("./env.js");
    expect(requireEnvironmentVariable("SOME_UNIT_TEST_VARIABLE")).toBe(" spaced value ");
  });

  it("throws a message naming the variable when it is unset or empty", async () => {
    stubCompleteEnvironment();
    const { requireEnvironmentVariable } = await import("./env.js");
    delete process.env.SOME_UNIT_TEST_VARIABLE;
    expect(() => requireEnvironmentVariable("SOME_UNIT_TEST_VARIABLE")).toThrow("Missing required environment variable: SOME_UNIT_TEST_VARIABLE");
    vi.stubEnv("SOME_UNIT_TEST_VARIABLE", "");
    expect(() => requireEnvironmentVariable("SOME_UNIT_TEST_VARIABLE")).toThrow("Missing required environment variable: SOME_UNIT_TEST_VARIABLE");
  });
});

describe("requireBooleanEnvironmentVariable", () => {
  it("parses exactly true and false", async () => {
    stubCompleteEnvironment();
    const { requireBooleanEnvironmentVariable } = await import("./env.js");
    vi.stubEnv("SOME_UNIT_TEST_FLAG", "true");
    expect(requireBooleanEnvironmentVariable("SOME_UNIT_TEST_FLAG")).toBe(true);
    vi.stubEnv("SOME_UNIT_TEST_FLAG", "false");
    expect(requireBooleanEnvironmentVariable("SOME_UNIT_TEST_FLAG")).toBe(false);
  });

  it("treats a missing or empty value as missing", async () => {
    stubCompleteEnvironment();
    const { requireBooleanEnvironmentVariable } = await import("./env.js");
    vi.stubEnv("SOME_UNIT_TEST_FLAG", "");
    expect(() => requireBooleanEnvironmentVariable("SOME_UNIT_TEST_FLAG")).toThrow("Missing required environment variable: SOME_UNIT_TEST_FLAG");
  });

  it("rejects every other spelling instead of guessing, quoting what it got", async () => {
    stubCompleteEnvironment();
    const { requireBooleanEnvironmentVariable } = await import("./env.js");
    for (const invalid of ["TRUE", "False", "1", "0", "yes", "no", " true", "true "]) {
      vi.stubEnv("SOME_UNIT_TEST_FLAG", invalid);
      expect(() => requireBooleanEnvironmentVariable("SOME_UNIT_TEST_FLAG"), invalid).toThrow(`SOME_UNIT_TEST_FLAG must be "true" or "false", got: ${invalid}`);
    }
  });
});

describe("ibkrMarketDataLinesEnabled", () => {
  it("reads IBKR_MARKET_DATA_LINES_ENABLED at call time, so a change after import is seen", async () => {
    stubCompleteEnvironment();
    const { ibkrMarketDataLinesEnabled } = await import("./env.js");
    vi.stubEnv("IBKR_MARKET_DATA_LINES_ENABLED", "true");
    expect(ibkrMarketDataLinesEnabled()).toBe(true);
    vi.stubEnv("IBKR_MARKET_DATA_LINES_ENABLED", "false");
    expect(ibkrMarketDataLinesEnabled()).toBe(false);
  });

  it("throws when the flag is missing or not a boolean", async () => {
    stubCompleteEnvironment();
    const { ibkrMarketDataLinesEnabled } = await import("./env.js");
    vi.stubEnv("IBKR_MARKET_DATA_LINES_ENABLED", "");
    expect(() => ibkrMarketDataLinesEnabled()).toThrow("Missing required environment variable: IBKR_MARKET_DATA_LINES_ENABLED");
    vi.stubEnv("IBKR_MARKET_DATA_LINES_ENABLED", "on");
    expect(() => ibkrMarketDataLinesEnabled()).toThrow('IBKR_MARKET_DATA_LINES_ENABLED must be "true" or "false", got: on');
  });
});

describe("environment object (validated when the module is first imported)", () => {
  it("collects the configuration, converting the SSH port to a number", async () => {
    stubCompleteEnvironment();
    delete process.env.TEST_DATABASE_URL;
    const { environment } = await import("./env.js");
    expect(environment).toEqual({
      databaseUrl: completeEnvironment.DATABASE_URL,
      testDatabaseUrl: undefined,
      frontendOrigin: completeEnvironment.FRONTEND_ORIGIN,
      ibkrTradingMode: "paper",
      ibkrTunnelSshHost: completeEnvironment.IBKR_TUNNEL_SSH_HOST,
      ibkrTunnelSshPort: 2222,
      ibkrTunnelSshUsername: completeEnvironment.IBKR_TUNNEL_SSH_USERNAME,
      ibkrTunnelSshPrivateKeyBase64: completeEnvironment.IBKR_TUNNEL_SSH_PRIVATE_KEY_BASE64,
      ibkrGatewayHost: completeEnvironment.IBKR_GATEWAY_HOST,
    });
  });

  it("exposes TEST_DATABASE_URL when it is set, and does not require it", async () => {
    stubCompleteEnvironment();
    vi.stubEnv("TEST_DATABASE_URL", "postgres://example.invalid/unit_test_db_for_tests");
    const { environment } = await import("./env.js");
    expect(environment.testDatabaseUrl).toBe("postgres://example.invalid/unit_test_db_for_tests");
  });

  it("accepts both trading modes", async () => {
    for (const mode of ["paper", "live"] as const) {
      stubCompleteEnvironment({ IBKR_TRADING_MODE: mode });
      const { environment } = await import("./env.js");
      expect(environment.ibkrTradingMode).toBe(mode);
      vi.resetModules();
    }
  });

  it("rejects an unknown trading mode, quoting it", async () => {
    stubCompleteEnvironment({ IBKR_TRADING_MODE: "demo" });
    await expect(import("./env.js")).rejects.toThrow('IBKR_TRADING_MODE must be "paper" or "live", got: demo');
  });

  for (const requiredName of Object.keys(completeEnvironment)) {
    it(`fails the import with a clear message when ${requiredName} is missing`, async () => {
      stubCompleteEnvironment({ [requiredName]: undefined });
      await expect(import("./env.js")).rejects.toThrow(`Missing required environment variable: ${requiredName}`);
    });

    it(`fails the import when ${requiredName} is empty`, async () => {
      stubCompleteEnvironment({ [requiredName]: "" });
      await expect(import("./env.js")).rejects.toThrow(`Missing required environment variable: ${requiredName}`);
    });
  }
});

describe("IBKR_TUNNEL_SSH_PORT", () => {
  it.each(["22", "2222", "65535"])("accepts %s", async (port) => {
    stubCompleteEnvironment({ IBKR_TUNNEL_SSH_PORT: port });
    const { environment } = await import("./env.js");
    expect(environment.ibkrTunnelSshPort).toBe(Number(port));
  });

  it.each(["abc", "0", "-1", "65536", "22.5", "1e3x"])("refuses %s at boot instead of carrying a NaN or an unusable port", async (port) => {
    stubCompleteEnvironment({ IBKR_TUNNEL_SSH_PORT: port });
    await expect(import("./env.js")).rejects.toThrow("IBKR_TUNNEL_SSH_PORT must be a port number between 1 and 65535");
  });
});
