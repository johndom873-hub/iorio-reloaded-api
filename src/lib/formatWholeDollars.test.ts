import { describe, expect, it } from "vitest";
import { formatWholeDollars } from "./formatWholeDollars.js";

describe("formatWholeDollars", () => {
  it("groups thousands and puts the minus sign before the dollar sign", () => {
    expect(formatWholeDollars(50_036.4)).toBe("$50,036");
    expect(formatWholeDollars(-1_084.2)).toBe("−$1,084");
    expect(formatWholeDollars(-0.4)).toBe("$0");
  });

  it("shows a plus sign when asked, never on an amount below zero", () => {
    expect(formatWholeDollars(1_234.5, true)).toBe("+$1,235");
    expect(formatWholeDollars(-1_234.5, true)).toBe("−$1,234");
    expect(formatWholeDollars(-0.4, true)).toBe("+$0");
  });
});
