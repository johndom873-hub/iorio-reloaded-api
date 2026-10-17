import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// findOrCreateTicker against the real test database, with the IBKR lookup mocked. Every assertion is narrowed to
// the symbols this file creates, since other test files share the database.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the findOrCreateTicker tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const fetchNewTickerDataMock = vi.hoisted(() => vi.fn());
vi.mock("./fetchNewTickerData.js", () => ({ fetchNewTickerData: fetchNewTickerDataMock }));

const { db } = await import("../db/connection.js");
const { findOrCreateTicker, UnknownSymbolError } = await import("./findOrCreateTicker.js");
const testDb: Knex = db;

const createdSymbols: string[] = [];
let counter = Date.now() % 100_000;
const nextSymbol = () => {
  const symbol = `FC${(counter += 1)}`;
  createdSymbols.push(symbol);
  return symbol;
};
const snapshotRowsFor = async (tickerId: string) => testDb("market_data_snapshots").where({ ticker_id: tickerId }).select("implied_volatility", "avg_option_volume");

beforeEach(() => {
  fetchNewTickerDataMock.mockReset();
  fetchNewTickerDataMock.mockImplementation(async (_symbol: string, options: { captureTodaysMarketData?: boolean } = {}) => ({
    companyName: "Find Or Create Test Co",
    sector: "Telecommunications",
    conId: 61813498,
    primaryExchange: "NYSE",
    impliedVolatility: options.captureTodaysMarketData === false ? null : 0.55,
    avgOptionVolume: options.captureTodaysMarketData === false ? null : 1_200,
  }));
});

afterAll(async () => {
  const tickerIds = await testDb("tickers").whereIn("symbol", createdSymbols).pluck("id");
  await testDb("market_data_snapshots").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb.destroy();
});

describe("findOrCreateTicker", () => {
  it("creates a new symbol's row and today's market data snapshot by default", async () => {
    const symbol = nextSymbol();
    const { ticker, created } = await findOrCreateTicker(` ${symbol.toLowerCase()} `);
    expect(created).toBe(true);
    expect(fetchNewTickerDataMock).toHaveBeenCalledWith(symbol, { captureTodaysMarketData: true });
    const stored = await testDb("tickers").where({ id: ticker.id }).first();
    expect([stored.symbol, stored.company_name, stored.sector, Number(stored.ibkr_contract_id), stored.primary_exchange]).toEqual([symbol, "Find Or Create Test Co", "Telecommunications", 61813498, "NYSE"]);
    const snapshots = await snapshotRowsFor(ticker.id);
    expect(snapshots).toHaveLength(1);
    expect(Number(snapshots[0].implied_volatility)).toBe(0.55);
  });

  it("with captureTodaysMarketData off, creates the row from the contract lookup alone and writes no snapshot", async () => {
    const symbol = nextSymbol();
    const { ticker, created } = await findOrCreateTicker(symbol, { captureTodaysMarketData: false });
    expect(created).toBe(true);
    expect(fetchNewTickerDataMock).toHaveBeenCalledWith(symbol, { captureTodaysMarketData: false });
    expect(Number((await testDb("tickers").where({ id: ticker.id }).first()).ibkr_contract_id)).toBe(61813498);
    expect(await snapshotRowsFor(ticker.id)).toEqual([]);
  });

  it("returns an existing row without asking IBKR", async () => {
    const symbol = nextSymbol();
    const first = await findOrCreateTicker(symbol, { captureTodaysMarketData: false });
    fetchNewTickerDataMock.mockClear();
    const second = await findOrCreateTicker(symbol);
    expect([second.created, second.ticker.id]).toEqual([false, first.ticker.id]);
    expect(fetchNewTickerDataMock).not.toHaveBeenCalled();
  });

  it("refuses a symbol IBKR has no contract for and stores nothing", async () => {
    const symbol = nextSymbol();
    fetchNewTickerDataMock.mockResolvedValue({ companyName: null, sector: null, conId: null, primaryExchange: null, impliedVolatility: null, avgOptionVolume: null });
    await expect(findOrCreateTicker(symbol, { captureTodaysMarketData: false })).rejects.toMatchObject({ name: "UnknownSymbolError", ibkrHasNoSuchContract: false });
    expect(await testDb("tickers").where({ symbol }).first()).toBeUndefined();
  });

  it("says when IBKR answered that it has no such stock (a delisted or misspelt symbol), not merely no answer", async () => {
    const symbol = nextSymbol();
    fetchNewTickerDataMock.mockResolvedValue({ companyName: null, sector: null, conId: null, primaryExchange: null, impliedVolatility: null, avgOptionVolume: null, ibkrHasNoSuchContract: true });
    const refusal = await findOrCreateTicker(symbol, { captureTodaysMarketData: false }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(UnknownSymbolError);
    expect((refusal as InstanceType<typeof UnknownSymbolError>).ibkrHasNoSuchContract).toBe(true);
    expect(await testDb("tickers").where({ symbol }).first()).toBeUndefined();
  });
});
