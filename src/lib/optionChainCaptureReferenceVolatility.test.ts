import { describe, expect, it } from "vitest";
import { chooseReferenceVolatility } from "./optionChainCaptureReferenceVolatility.js";

const base = { todayIso: "2026-09-21", latestImpliedVolatility: 0.4, latestImpliedVolatilityDateIso: "2026-09-18", yangZhang21DayVolatility: 0.3 };

describe("chooseReferenceVolatility", () => {
  it("uses the latest IV when it is within 5 days", () => {
    expect(chooseReferenceVolatility(base)).toEqual({ volatility: 0.4, source: "implied_volatility" });
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatilityDateIso: "2026-09-16" }).source).toBe("implied_volatility");
  });
  it("falls back to Yang-Zhang when the IV is 6+ days old, missing, or non-positive", () => {
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatilityDateIso: "2026-09-15" })).toEqual({ volatility: 0.3, source: "yang_zhang_21d" });
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatility: null }).source).toBe("yang_zhang_21d");
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatility: 0 }).source).toBe("yang_zhang_21d");
  });
  it("rejects an IV dated in the future", () => {
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatilityDateIso: "2026-09-25" }).source).toBe("yang_zhang_21d");
  });
  it("uses the widest window when nothing is usable", () => {
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatility: null, yangZhang21DayVolatility: null })).toEqual({ volatility: null, source: "widest_window" });
    expect(chooseReferenceVolatility({ ...base, latestImpliedVolatility: null, yangZhang21DayVolatility: NaN }).source).toBe("widest_window");
  });
});
