import { describe, expect, it } from "vitest";
import { detectTradingModeFromAccountIds } from "./detectTradingModeFromAccountIds.js";

describe("detectTradingModeFromAccountIds", () => {
  it("recognises paper accounts", () => {
    expect(detectTradingModeFromAccountIds(["DUR123456"])).toBe("paper");
  });
  it("recognises live accounts", () => {
    expect(detectTradingModeFromAccountIds(["U1234567"])).toBe("live");
  });
  it("is unknown for a paper/live mix, unrecognised ids, or no accounts", () => {
    expect(detectTradingModeFromAccountIds(["DUR123456", "U1234567"])).toBe("unknown");
    expect(detectTradingModeFromAccountIds(["F1234567"])).toBe("unknown");
    expect(detectTradingModeFromAccountIds([])).toBe("unknown");
  });
});
