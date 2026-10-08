import { describe, expect, it } from "vitest";
import { daysToExpiry, describeOptionContract, describeOrderSize, formatDayMonth, formatStrike, optionRightWord } from "./optionContractLabel.js";

describe("optionContractLabel", () => {
  it("formats the pieces", () => {
    expect(formatDayMonth("2026-10-09")).toBe("9 Oct");
    expect(formatDayMonth("20261231")).toBe("31 Dec");
    expect(formatStrike(46)).toBe("$46");
    expect(formatStrike(42.5)).toBe("$42.5");
    expect(formatStrike(152.25)).toBe("$152.25");
    expect(optionRightWord("C")).toBe("Call");
    expect(optionRightWord("put")).toBe("Put");
    expect(daysToExpiry("2026-10-09", "2026-10-07")).toBe(2);
    expect(daysToExpiry("2026-11-02", "2026-10-30")).toBe(3);
  });

  it("words a contract with or without its symbol and DTE", () => {
    expect(describeOptionContract({ symbol: "SMCI", strike: 47, right: "C", expiry: "2026-10-09", dte: 2 })).toBe("SMCI $47 Call · 9 Oct (2DTE)");
    expect(describeOptionContract({ strike: 47, right: "P", expiry: "2026-10-09", dte: null })).toBe("$47 Put · 9 Oct");
    expect(`SMCI Sell ${describeOptionContract({ strike: 46, right: "C", expiry: "2026-10-09", dte: 2 })}${describeOrderSize(11, 0.39)}`).toBe("SMCI Sell $46 Call · 9 Oct (2DTE) · 11× @ 0.39");
    expect(describeOrderSize(3, null)).toBe(" · 3×");
  });
});
