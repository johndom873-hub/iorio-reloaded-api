import { describe, expect, it } from "vitest";
import { followTheMidIsOn } from "./orderLimitPriceChanges.js";

describe("followTheMidIsOn (Marcelo 2026-11-10)", () => {
  it("is on in every environment, production included", () => {
    expect(followTheMidIsOn("production")).toBe(true);
    expect(followTheMidIsOn("staging")).toBe(true);
    expect(followTheMidIsOn("development")).toBe(true);
  });
});
