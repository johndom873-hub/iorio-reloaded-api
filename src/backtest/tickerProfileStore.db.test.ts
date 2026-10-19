import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import knexLibrary from "knex";

// The Analyse window header's profiles against the test database, TradingView's scanner stubbed: one request over every
// exchange (the stored TradingView ticker when known), the first exchange kept when a symbol answers on several, kinds
// mapped (an ETF fund, an ADR), stored and read back; a symbol TradingView doesn't list falls back to the IBKR name.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run ticker profile tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const { db } = await import("../db/connection.js");
const { loadTickerProfile, refreshTickerProfiles } = await import("./tickerProfileStore.js");
const suffix = `${Date.now() % 10000}`;
const stock = `PS${suffix}`;
const fund = `PF${suffix}`;
const adr = `PA${suffix}`;
const unlisted = `PU${suffix}`;
const symbols = [stock, fund, adr, unlisted];

afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db("backtest_ticker_profiles").whereIn("symbol", symbols).delete();
  await db("tickers").whereIn("symbol", symbols).delete();
  await db.destroy();
});

describe("ticker profiles", () => {
  it("stores TradingView's name, sector, industry and kind, and falls back to the IBKR name for a symbol it doesn't list", async () => {
    await db("tickers").insert([
      { symbol: adr, company_name: "PROFILE ADR CORP-SPON ADR", sector: "Communications", tradingview_ticker: `NYSE:${adr}` },
      { symbol: unlisted, company_name: "UNLISTED PROFILE INC", sector: "Technology" },
    ]);
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const requested = JSON.parse(init.body).symbols.tickers as string[];
      // Every exchange for the symbols without a stored ticker; the stored one alone for the ADR.
      expect(requested).toContain(`NASDAQ:${stock}`);
      expect(requested).toContain(`CBOE:${fund}`);
      expect(requested.filter((ticker) => ticker.endsWith(`:${adr}`))).toEqual([`NYSE:${adr}`]);
      return new Response(
        JSON.stringify({
          data: [
            { s: `NYSE:${stock}`, d: ["Wrong Listing Inc.", "Finance", "Other", "stock", ["common"]] },
            { s: `NASDAQ:${stock}`, d: ["Profile Stock, Inc.", "Finance", "Investment Banks/Brokers", "stock", ["common"]] },
            { s: `CBOE:${fund}`, d: ["Profile Memory ETF", "Miscellaneous", "Investment Trusts/Mutual Funds", "fund", ["etf"]] },
            { s: `NYSE:${adr}`, d: ["Profile ADR Corporation", "Electronic Technology", "Telecommunications Equipment", "dr", []] },
          ],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await refreshTickerProfiles(symbols)).toEqual([unlisted]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await loadTickerProfile(stock)).toEqual({ source: "tradingview", companyName: "Profile Stock, Inc.", exchange: "NASDAQ", sector: "Finance", industry: "Investment Banks/Brokers", kind: "stock" });
    expect(await loadTickerProfile(fund)).toMatchObject({ companyName: "Profile Memory ETF", kind: "etf" });
    expect(await loadTickerProfile(adr)).toMatchObject({ companyName: "Profile ADR Corporation", kind: "adr" });
    expect(await loadTickerProfile(unlisted)).toEqual({ source: "ibkr", companyName: "UNLISTED PROFILE INC", exchange: null, sector: "Technology", industry: null, kind: null });
  });

  it("throws when TradingView refuses, leaving the stored profile as it was", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    await expect(refreshTickerProfiles([stock])).rejects.toThrow(/HTTP 503/);
    expect(await loadTickerProfile(stock)).toMatchObject({ companyName: "Profile Stock, Inc." });
  });
});
