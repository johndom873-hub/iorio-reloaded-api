import { describe, expect, it } from "vitest";
import { decideLeapsExpiryWarning, formatLeapsExpiryMessage, type HeldLeapsLeg, type LeapsExpiryWarningInput } from "./leapsExpiryWarnings.js";

const base: LeapsExpiryWarningInput = { expiry: "2028-06-16", strike: 82, warnedOn: null, sessionDateIso: "2028-05-17", tradingDaysToExpiry: null, stockClose: 89.4 };

describe("decideLeapsExpiryWarning", () => {
  it("sends the notice once at 30 calendar days or less, in or out of the money", () => {
    expect(decideLeapsExpiryWarning(base)).toEqual({ kind: "expiryNotice", calendarDaysToExpiry: 30 });
    expect(decideLeapsExpiryWarning({ ...base, stockClose: 75 })).toEqual({ kind: "expiryNotice", calendarDaysToExpiry: 30 });
    expect(decideLeapsExpiryWarning({ ...base, stockClose: null })).toEqual({ kind: "expiryNotice", calendarDaysToExpiry: 30 });
    expect(decideLeapsExpiryWarning({ ...base, sessionDateIso: "2028-05-16" })).toBeNull();
    expect(decideLeapsExpiryWarning({ ...base, warnedOn: "2028-05-17" })).toBeNull();
    expect(decideLeapsExpiryWarning({ ...base, sessionDateIso: "2028-05-20", warnedOn: "2028-05-17" })).toBeNull();
  });

  it("sends the notice late for a LEAPS bought inside its last 30 days", () => {
    expect(decideLeapsExpiryWarning({ ...base, sessionDateIso: "2028-06-01" })).toEqual({ kind: "expiryNotice", calendarDaysToExpiry: 15 });
  });

  it("warns on each of the last 5 trading days while in the money, once per session", () => {
    const finalDays = { ...base, sessionDateIso: "2028-06-09", tradingDaysToExpiry: 5, warnedOn: "2028-05-17" };
    expect(decideLeapsExpiryWarning(finalDays)).toEqual({ kind: "finalDays", tradingDaysToExpiry: 5 });
    expect(decideLeapsExpiryWarning({ ...finalDays, sessionDateIso: "2028-06-15", tradingDaysToExpiry: 1 })).toEqual({ kind: "finalDays", tradingDaysToExpiry: 1 });
    expect(decideLeapsExpiryWarning({ ...finalDays, tradingDaysToExpiry: 6 })).toBeNull();
    expect(decideLeapsExpiryWarning({ ...finalDays, warnedOn: "2028-06-09" })).toBeNull();
    expect(decideLeapsExpiryWarning({ ...finalDays, stockClose: 82 })).toBeNull();
    expect(decideLeapsExpiryWarning({ ...finalDays, stockClose: null })).toBeNull();
  });

  it("prefers the final-days warning when both apply", () => {
    expect(decideLeapsExpiryWarning({ ...base, sessionDateIso: "2028-06-12", tradingDaysToExpiry: 4 })).toEqual({ kind: "finalDays", tradingDaysToExpiry: 4 });
  });

  it("says nothing on or after the expiry", () => {
    expect(decideLeapsExpiryWarning({ ...base, sessionDateIso: "2028-06-16", tradingDaysToExpiry: 0 })).toBeNull();
  });
});

describe("formatLeapsExpiryMessage", () => {
  const leg: HeldLeapsLeg = { legId: "leg", tickerId: "ticker", symbol: "TLT", expiry: "2028-06-16", strike: 82, contracts: 110, multiplier: 100, warnedOn: null };

  it("writes the 30-day notice", () => {
    expect(formatLeapsExpiryMessage({ leg, warning: { kind: "expiryNotice", calendarDaysToExpiry: 30 }, sessionDateIso: "2028-05-17", stockClose: 89.4, freeCash: null })).toBe(
      [
        "LEAPS expiring in 30 days: TLT $82 Call · 16 Jun (30DTE), 110 contracts.",
        "In the money: TLT is at $89.40.",
        "If it is still in the money at the close on 16 Jun, IBKR exercises it: 11,000 shares at $82.00, $902,000 of cash.",
        "Sell it before then, or keep that cash free.",
      ].join("\n"),
    );
    expect(formatLeapsExpiryMessage({ leg: { ...leg, contracts: 1 }, warning: { kind: "expiryNotice", calendarDaysToExpiry: 30 }, sessionDateIso: "2028-05-17", stockClose: null, freeCash: null })).toBe(
      [
        "LEAPS expiring in 30 days: TLT $82 Call · 16 Jun (30DTE), 1 contract.",
        "If it is in the money at the close on 16 Jun, IBKR exercises it: 100 shares at $82.00, $8,200 of cash.",
        "Sell it before then, or keep that cash free.",
      ].join("\n"),
    );
  });

  it("writes the final-days warning, with free cash when known", () => {
    expect(formatLeapsExpiryMessage({ leg, warning: { kind: "finalDays", tradingDaysToExpiry: 3 }, sessionDateIso: "2028-06-11", stockClose: 89.4, freeCash: 502_458.4 })).toBe(
      [
        "LEAPS in the money, 3 trading days to expiry: TLT $82 Call · 16 Jun (5DTE), 110 contracts.",
        "TLT is at $89.40. At expiry IBKR exercises it: 11,000 shares at $82.00, $902,000 of cash. Free cash now: $502,458.",
        "Sell it before the close on 16 Jun, or raise the cash.",
      ].join("\n"),
    );
    expect(formatLeapsExpiryMessage({ leg, warning: { kind: "finalDays", tradingDaysToExpiry: 1 }, sessionDateIso: "2028-06-15", stockClose: 89.4, freeCash: null })).toContain("1 trading day to expiry");
  });
});
