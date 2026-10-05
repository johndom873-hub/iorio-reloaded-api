import type { Knex } from "knex";
import { describe, expect, it } from "vitest";
import { fillWorthlessExpiredOptionPrices, worthlessPriceForExpiredOption, type ExpiredOptionCandidateLeg } from "./expiredOptionWorthlessPrice.js";

const afterExpiryClose = new Date("2026-10-02T22:30:00Z");
const beforeExpiryClose = new Date("2026-10-02T19:59:00Z");

describe("worthlessPriceForExpiredOption", () => {
  const base = { expiryIsoDate: "2026-10-02", now: afterExpiryClose };

  it("is 0 for a put that closed above its strike and for a call that closed below it", () => {
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "put", strike: 110, expiryClose: 119.33 })).toBe(0);
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "call", strike: 200, expiryClose: 183 })).toBe(0);
  });

  it("treats a close exactly at the strike as worthless, like the settlement audit", () => {
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "put", strike: 50, expiryClose: 50 })).toBe(0);
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "call", strike: 50, expiryClose: 50 })).toBe(0);
  });

  it("is null for an in-the-money option, even by a cent", () => {
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "put", strike: 26.5, expiryClose: 26.27 })).toBeNull();
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "call", strike: 100, expiryClose: 100.01 })).toBeNull();
  });

  it("is null when there is no expiry-day close", () => {
    expect(worthlessPriceForExpiredOption({ ...base, optionType: "put", strike: 110, expiryClose: null })).toBeNull();
  });

  it("is null before the expiry date's 16:00 Eastern close, whatever the close says", () => {
    expect(worthlessPriceForExpiredOption({ ...base, now: beforeExpiryClose, optionType: "put", strike: 110, expiryClose: 119.33 })).toBeNull();
  });
});

describe("fillWorthlessExpiredOptionPrices", () => {
  const leg = (legId: string, symbol: string, optionType: "call" | "put", strike: number, expiryYyyymmdd = "20261002"): ExpiredOptionCandidateLeg => ({
    legId,
    symbol,
    optionType,
    strike,
    expiryYyyymmdd,
  });
  const databaseReturning = (rows: { symbol: string; tradingDate: string; close: number }[]) =>
    ({ raw: async () => ({ rows }) }) as unknown as Knex;
  const failingDatabase = { raw: async () => { throw new Error("no query expected"); } } as unknown as Knex;

  it("fills 0 only for unpriced legs that finished out of the money", async () => {
    const database = databaseReturning([
      { symbol: "INTC", tradingDate: "2026-10-02", close: 119.33 },
      { symbol: "HOOD", tradingDate: "2026-10-02", close: 112.74 },
    ]);
    const result = await fillWorthlessExpiredOptionPrices(
      [leg("intc", "INTC", "put", 110), leg("hood", "HOOD", "put", 114), leg("nobar", "ZZZZ", "put", 10)],
      { intc: null, hood: null, nobar: null },
      afterExpiryClose,
      database,
    );
    expect(result.pricesByLegId).toEqual({ intc: 0, hood: null, nobar: null });
    expect(result.filledLegIds).toEqual(["intc"]);
  });

  it("never overrides a price IBKR returned, and treats a missing key as unpriced", async () => {
    const database = databaseReturning([{ symbol: "BMNR", tradingDate: "2026-10-02", close: 30 }]);
    const result = await fillWorthlessExpiredOptionPrices(
      [leg("priced", "BMNR", "put", 26.5), leg("absent", "BMNR", "put", 26)],
      { priced: 0.22 },
      afterExpiryClose,
      database,
    );
    expect(result.pricesByLegId).toEqual({ priced: 0.22, absent: 0 });
    expect(result.filledLegIds).toEqual(["absent"]);
  });

  it("does not query the database when nothing is unpriced and expired", async () => {
    const stillTrading = await fillWorthlessExpiredOptionPrices([leg("a", "COIN", "call", 200)], { a: null }, beforeExpiryClose, failingDatabase);
    expect(stillTrading.filledLegIds).toEqual([]);
    const alreadyPriced = await fillWorthlessExpiredOptionPrices([leg("a", "COIN", "call", 200)], { a: 1.5 }, afterExpiryClose, failingDatabase);
    expect(alreadyPriced.pricesByLegId).toEqual({ a: 1.5 });
  });

  it("matches each leg to the close of its own expiry date", async () => {
    const database = databaseReturning([
      { symbol: "COIN", tradingDate: "2026-10-02", close: 183 },
      { symbol: "COIN", tradingDate: "2026-10-09", close: 250 },
    ]);
    const result = await fillWorthlessExpiredOptionPrices(
      [leg("expired", "COIN", "call", 190, "20261002"), leg("later", "COIN", "call", 190, "20261009")],
      { expired: null, later: null },
      afterExpiryClose,
      database,
    );
    expect(result.pricesByLegId).toEqual({ expired: 0, later: null });
  });
});
