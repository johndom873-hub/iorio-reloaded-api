import { describe, expect, it } from "vitest";
import { createPlutoPromptMasking, maskedDateShiftWeeks, maskPlutoText, unmaskPlutoText } from "./plutoPromptMasking.js";

const payload = {
  as_of: "2026-10-06T19:25:42.687Z",
  session: { date: "2026-10-06", minutes_to_window_end: 5 },
  tickers: [
    {
      symbol: "BMNR",
      spot: 25.84,
      candidates: [{ id: "BMNR:covered_call:2026-10-09:27.5", expiry: "2026-10-09", strike: 27.5 }],
      macro_events: [{ date: "2026-10-07", title: "FOMC Minutes" }],
    },
    { symbol: "BE", spot: 120.5, candidates: [{ id: "BE:cash_secured_put:2026-10-16:110", expiry: "2026-10-16", strike: 110 }] },
  ],
};

describe("masking the Pluto prompt", () => {
  const masking = createPlutoPromptMasking(["BMNR", "BE"]);

  it("names the symbols STOCK_A, STOCK_B … in the session's order and shifts by 1,044 weeks", () => {
    expect(masking).toEqual({ aliasBySymbol: { BMNR: "STOCK_A", BE: "STOCK_B" }, dateShiftWeeks: maskedDateShiftWeeks });
    expect(maskedDateShiftWeeks).toBe(1044);
    const aliases = createPlutoPromptMasking(Array.from({ length: 30 }, (_, position) => `S${position}`)).aliasBySymbol;
    expect([aliases.S0, aliases.S25, aliases.S26, aliases.S29]).toEqual(["STOCK_A", "STOCK_Z", "STOCK_AA", "STOCK_AD"]);
  });

  it("replaces every symbol and moves every date forward, keeping the weekday; prices and words are untouched", () => {
    const masked = JSON.parse(maskPlutoText(JSON.stringify(payload), masking));
    expect(masked.as_of).toBe("2046-10-09T19:25:42.687Z");
    expect(masked.session.date).toBe("2046-10-09");
    expect(masked.tickers[0].symbol).toBe("STOCK_A");
    expect(masked.tickers[0].candidates[0]).toEqual({ id: "STOCK_A:covered_call:2046-10-12:27.5", expiry: "2046-10-12", strike: 27.5 });
    expect(masked.tickers[0].macro_events[0]).toEqual({ date: "2046-10-10", title: "FOMC Minutes" });
    expect(masked.tickers[1].candidates[0].id).toBe("STOCK_B:cash_secured_put:2046-10-19:110");
    expect(masked.tickers[0].spot).toBe(25.84);
    expect(new Date("2026-10-09T12:00:00Z").getUTCDay()).toBe(new Date("2046-10-12T12:00:00Z").getUTCDay());
    expect(JSON.stringify(masked)).not.toMatch(/BMNR|"BE|2026-/);
  });

  it("a symbol inside a longer token or a word is not replaced", () => {
    const text = '{"symbol":"BE","note":"BEST BETA BE.X XBE"}';
    expect(maskPlutoText(text, masking)).toBe('{"symbol":"STOCK_B","note":"BEST BETA BE.X XBE"}');
  });

  it("the model's answer maps back to the real symbol and dates, reasons included", () => {
    const answer = JSON.stringify({ decision: "trade", candidate_id: "STOCK_A:covered_call:2046-10-12:27.5", reasons: ["STOCK_A has FOMC Minutes on 2046-10-10.", "STOCK_Q is unknown."] });
    expect(JSON.parse(unmaskPlutoText(answer, masking))).toEqual({
      decision: "trade",
      candidate_id: "BMNR:covered_call:2026-10-09:27.5",
      reasons: ["BMNR has FOMC Minutes on 2026-10-07.", "STOCK_Q is unknown."],
    });
  });

  it("masking then unmasking gives back the original text", () => {
    const text = JSON.stringify(payload);
    expect(unmaskPlutoText(maskPlutoText(text, masking), masking)).toBe(text);
  });

  it("a digit run that is not a calendar date is left alone", () => {
    expect(maskPlutoText('{"code":"2026-13-45","n":12026-10-06}', masking)).toBe('{"code":"2026-13-45","n":12026-10-06}');
  });
});
