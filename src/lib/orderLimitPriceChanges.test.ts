import { describe, expect, it } from "vitest";
import { followTheMidIsOn } from "./orderLimitPriceChanges.js";

describe("followTheMidIsOn (Marcelo 2026-11-09)", () => {
  it("is off on production until it has run against IBKR on staging, on everywhere else", () => {
    expect(followTheMidIsOn("production")).toBe(false);
    expect(followTheMidIsOn("staging")).toBe(true);
    expect(followTheMidIsOn("development")).toBe(true);
  });
});
