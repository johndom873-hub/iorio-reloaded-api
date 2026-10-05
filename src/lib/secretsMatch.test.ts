import { describe, expect, it } from "vitest";
import { secretsMatch } from "./secretsMatch.js";

describe("secretsMatch", () => {
  it("accepts the same secret and rejects any other, including different lengths and empty", () => {
    expect(secretsMatch("s3cret-value", "s3cret-value")).toBe(true);
    expect(secretsMatch("s3cret-valuf", "s3cret-value")).toBe(false);
    expect(secretsMatch("short", "s3cret-value")).toBe(false);
    expect(secretsMatch("", "s3cret-value")).toBe(false);
  });
});
