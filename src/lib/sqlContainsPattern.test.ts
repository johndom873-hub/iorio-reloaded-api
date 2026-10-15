import { describe, expect, it } from "vitest";
import { sqlContainsPattern } from "./sqlContainsPattern.js";

describe("sqlContainsPattern", () => {
  it("wraps the text in % and escapes the characters ILIKE would read as wildcards or escapes", () => {
    expect(sqlContainsPattern("Ladder grid v3")).toBe("%Ladder grid v3%");
    expect(sqlContainsPattern("shock 90%")).toBe("%shock 90\\%%");
    expect(sqlContainsPattern("cc_100")).toBe("%cc\\_100%");
    expect(sqlContainsPattern("a\\b")).toBe("%a\\\\b%");
  });
});
