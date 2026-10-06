import { describe, expect, it } from "vitest";
import { formatSignedDollars } from "./formatSignedDollars.js";

describe("formatSignedDollars", () => {
  it("puts the minus before the dollar sign", () => {
    expect(formatSignedDollars(-0.05, 2)).toBe("−$0.05");
    expect(formatSignedDollars(-13.4, 0)).toBe("−$13");
  });

  it("shows no sign on a positive amount unless asked, and a plus when asked", () => {
    expect(formatSignedDollars(1.5, 2)).toBe("$1.50");
    expect(formatSignedDollars(13.4, 0, true)).toBe("+$13");
  });

  it("never shows a minus on an amount that rounds to zero", () => {
    expect(formatSignedDollars(-0.004, 2)).toBe("$0.00");
    expect(formatSignedDollars(0.3, 0, true)).toBe("+$0");
    expect(formatSignedDollars(-0.4, 0, true)).toBe("+$0");
    expect(formatSignedDollars(-0, 2, true)).toBe("+$0.00");
  });
});
