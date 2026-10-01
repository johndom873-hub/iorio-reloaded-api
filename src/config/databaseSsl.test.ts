import { afterEach, describe, expect, it, vi } from "vitest";
import { postgresSslOption, readDatabaseSsl } from "./databaseSsl.js";

afterEach(() => vi.unstubAllEnvs());

describe("readDatabaseSsl", () => {
  it("accepts exactly true and false", () => {
    vi.stubEnv("DATABASE_SSL", "true");
    expect(readDatabaseSsl()).toBe(true);
    vi.stubEnv("DATABASE_SSL", "false");
    expect(readDatabaseSsl()).toBe(false);
  });

  it("rejects a missing, empty or any other value instead of guessing", () => {
    vi.stubEnv("DATABASE_SSL", "");
    expect(() => readDatabaseSsl()).toThrow(/DATABASE_SSL must be "true" or "false", got: \(missing\)/);
    vi.stubEnv("DATABASE_SSL", "1");
    expect(() => readDatabaseSsl()).toThrow(/got: 1/);
    vi.stubEnv("DATABASE_SSL", "TRUE");
    expect(() => readDatabaseSsl()).toThrow(/got: TRUE/);
  });
});

describe("postgresSslOption", () => {
  it("is an SSL option only when enabled", () => {
    vi.stubEnv("DATABASE_SSL", "true");
    expect(postgresSslOption()).toEqual({ rejectUnauthorized: false });
    vi.stubEnv("DATABASE_SSL", "false");
    expect(postgresSslOption()).toBe(false);
  });
});
