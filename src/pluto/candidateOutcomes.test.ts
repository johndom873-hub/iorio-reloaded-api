import { describe, expect, it } from "vitest";
import { extractOfferedContracts, holdToExpiryPnl } from "./candidateOutcomes.js";

describe("holdToExpiryPnl", () => {
  it("keeps the premium when the option expires worthless and loses the intrinsic value otherwise", () => {
    expect(holdToExpiryPnl("cash_secured_put", 100, 2.05, 110)).toBe(205);
    expect(holdToExpiryPnl("cash_secured_put", 100, 2.05, 95)).toBe(-295);
    expect(holdToExpiryPnl("covered_call", 130, 1.5, 128)).toBe(150);
    expect(holdToExpiryPnl("covered_call", 130, 1.5, 140)).toBe(-850);
  });
});

describe("extractOfferedContracts", () => {
  it("takes open candidates and roll replacements, never close offers", () => {
    const payload = {
      tickers: [
        {
          symbol: "HOOD",
          candidates: [{ id: "HOOD:cash_secured_put:2026-10-16:100", kind: "open_cash_secured_put", expiry: "2026-10-16", strike: 100, bid: 2.05, ask: 2.15 }],
          rolls: [{ id: "HOOD:roll:leg1:2026-10-30:95", kind: "roll", replacement: { id: "x#replacement", kind: "cash_secured_put", expiry: "2026-10-30", strike: 95, bid: 1.4 } }],
          close_actions: [{ id: "HOOD:close_shares:p1", kind: "close_shares", description: "sell 300 shares" }],
        },
      ],
    };
    expect(extractOfferedContracts(payload)).toEqual([
      { candidateId: "HOOD:cash_secured_put:2026-10-16:100", symbol: "HOOD", strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 100, premiumBid: 2.05 },
      { candidateId: "HOOD:roll:leg1:2026-10-30:95", symbol: "HOOD", strategyKey: "cash_secured_put", expiry: "2026-10-30", strike: 95, premiumBid: 1.4 },
    ]);
    expect(extractOfferedContracts({})).toEqual([]);
  });
});
