import { describe, expect, it } from "vitest";
import { classifyFingerprintChange, tickerFingerprint } from "./inputHash.js";

describe("tickerFingerprint / classifyFingerprintChange", () => {
  const open = tickerFingerprint([], []);
  it("labels a held-leg-only change as held_leg and anything touching the open candidates as grade_crossing", () => {
    const withCloses = tickerFingerprint([], [], ["HOOD:close_shares:p1"]);
    expect(withCloses).not.toBe(open);
    expect(classifyFingerprintChange(open, withCloses)).toBe("held_leg");
    expect(classifyFingerprintChange(withCloses, open)).toBe("held_leg");
    expect(classifyFingerprintChange(undefined, withCloses)).toBe("grade_crossing");
    // A changed open part is a grade crossing even if the held part moved too.
    const other = `deadbeef|${withCloses.split("|").slice(1).join("|")}`;
    expect(classifyFingerprintChange(open, other)).toBe("grade_crossing");
  });
  it("keeps the three parts separable", () => {
    expect(tickerFingerprint([], [], ["b", "a"]).split("|")).toHaveLength(3);
    expect(tickerFingerprint([], [], ["b", "a"]).endsWith("closes:a,b")).toBe(true);
  });
});
