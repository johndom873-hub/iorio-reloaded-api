import { afterEach, describe, expect, it, vi } from "vitest";
import { readAppEnvironment } from "./appEnvironment.js";

afterEach(() => vi.unstubAllEnvs());

describe("readAppEnvironment", () => {
  it("accepts exactly the three known environments", () => {
    for (const name of ["development", "staging", "production"] as const) {
      vi.stubEnv("APP_ENVIRONMENT", name);
      expect(readAppEnvironment()).toBe(name);
    }
  });

  it("treats a missing or empty value as missing and rejects anything else, quoting it", () => {
    vi.stubEnv("APP_ENVIRONMENT", "");
    expect(() => readAppEnvironment()).toThrow("Missing required environment variable: APP_ENVIRONMENT");
    for (const invalid of ["prod", "Production", "test", "qa"]) {
      vi.stubEnv("APP_ENVIRONMENT", invalid);
      expect(() => readAppEnvironment(), invalid).toThrow(`APP_ENVIRONMENT must be "development", "staging" or "production", got: ${invalid}`);
    }
  });
});
