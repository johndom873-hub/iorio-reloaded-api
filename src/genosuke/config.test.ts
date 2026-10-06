import { afterEach, describe, expect, it, vi } from "vitest";

// config/env.js loads the whole application environment at import time; only its variable reader matters here.
vi.mock("../config/env.js", () => ({
  requireEnvironmentVariable: (variableName: string) => {
    const value = process.env[variableName];
    if (!value) throw new Error(`Missing required environment variable: ${variableName}`);
    return value;
  },
}));

const { loadGenosukeConfig } = await import("./config.js");

const fullEnvironment: Record<string, string> = {
  GENOSUKE_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHAT_ID: "-100123",
  OPENROUTER_API_KEY: "or-key",
  GENOSUKE_MODEL: "vendor/model",
  GENOSUKE_SERVICE_USERNAME: "genosuke-svc",
  GENOSUKE_SERVICE_USER_PASSWORD: "pw",
  GENOSUKE_WEBHOOK_URL: "https://example.test/genosuke/webhook",
  GENOSUKE_WEBHOOK_SECRET: "hook-secret",
  PORT: "3030",
};

function setEnvironment(overrides: Record<string, string | undefined> = {}) {
  for (const [name, value] of Object.entries({ ...fullEnvironment, ...overrides })) {
    if (value === undefined) vi.stubEnv(name, undefined as unknown as string);
    else vi.stubEnv(name, value);
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loadGenosukeConfig", () => {
  it("is off unless GENOSUKE_ENABLED is exactly 'true'", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      setEnvironment({ GENOSUKE_ENABLED: value });
      expect(loadGenosukeConfig(), `GENOSUKE_ENABLED=${String(value)}`).toBeNull();
    }
  });

  it("does not read any other variable while disabled", () => {
    setEnvironment({ GENOSUKE_ENABLED: "false", TELEGRAM_BOT_TOKEN: undefined, OPENROUTER_API_KEY: undefined });
    expect(() => loadGenosukeConfig()).not.toThrow();
  });

  it("reads every value from the environment and points the API client at the same dyno's port", () => {
    setEnvironment();
    expect(loadGenosukeConfig()).toEqual({
      telegramBotToken: "bot-token",
      telegramChatId: "-100123",
      openRouterApiKey: "or-key",
      openRouterModel: "vendor/model",
      serviceUsername: "genosuke-svc",
      serviceUserPassword: "pw",
      webhookUrl: "https://example.test/genosuke/webhook",
      webhookSecret: "hook-secret",
      apiBaseUrl: "http://127.0.0.1:3030",
    });
  });

  it("refuses to start without a PORT instead of pointing the API client at http://127.0.0.1:undefined", () => {
    setEnvironment({ PORT: undefined });
    expect(() => loadGenosukeConfig()).toThrow("Missing required environment variable: PORT");
  });

  it.each([
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_CHAT_ID",
    "OPENROUTER_API_KEY",
    "GENOSUKE_MODEL",
    "GENOSUKE_SERVICE_USERNAME",
    "GENOSUKE_SERVICE_USER_PASSWORD",
    "GENOSUKE_WEBHOOK_URL",
    "GENOSUKE_WEBHOOK_SECRET",
  ])("throws naming %s when it is missing while enabled", (variableName) => {
    setEnvironment({ [variableName]: undefined });
    expect(() => loadGenosukeConfig()).toThrow(`Missing required environment variable: ${variableName}`);
  });

  it("treats an empty value as missing", () => {
    setEnvironment({ GENOSUKE_WEBHOOK_SECRET: "" });
    expect(() => loadGenosukeConfig()).toThrow("GENOSUKE_WEBHOOK_SECRET");
  });
});
