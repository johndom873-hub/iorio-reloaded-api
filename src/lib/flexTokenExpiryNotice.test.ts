import { describe, expect, it } from "vitest";
import { decideFlexTokenExpiryNotice, formatFlexTokenExpiryNotice } from "./flexTokenExpiryNotice.js";

const expiresOn = "2027-11-13";

describe("decideFlexTokenExpiryNotice", () => {
  it("sends the 30-day notice on the first run inside 30 days", () => {
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-10-14", "2027-10-13")).toBe(30);
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-10-13", "2027-10-12")).toBeNull();
  });

  it("sends it once, on the first trading day after a weekend that held the 30-day mark", () => {
    // Expiry Mon 15 Nov 2027: the 30-day mark is Sat 16 Oct, so the first run inside it is Mon 18 Oct.
    expect(decideFlexTokenExpiryNotice("2027-11-15", "2027-10-18", "2027-10-15")).toBe(30);
    expect(decideFlexTokenExpiryNotice("2027-11-15", "2027-10-19", "2027-10-18")).toBeNull();
  });

  it("sends the 7-day notice on the first run inside 7 days, and not again", () => {
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-11-06", "2027-11-05")).toBe(7);
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-11-08", "2027-11-06")).toBeNull();
  });

  it("sends only the tighter notice when one run crosses both thresholds", () => {
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-11-08", "2027-10-01")).toBe(7);
  });

  it("is silent far from expiry, on the expiry day and after it", () => {
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-05-01", "2027-04-30")).toBeNull();
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-11-13", "2027-11-12")).toBeNull();
    expect(decideFlexTokenExpiryNotice(expiresOn, "2027-11-15", "2027-11-12")).toBeNull();
  });
});

describe("formatFlexTokenExpiryNotice", () => {
  it("names the threshold and both variables to update", () => {
    const text = formatFlexTokenExpiryNotice(30);
    expect(text).toContain("within 30 days");
    expect(text).toContain("IBKR_FLEX_TOKEN and IBKR_FLEX_TOKEN_EXPIRES_ON");
  });
});
