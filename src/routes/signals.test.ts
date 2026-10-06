import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real signalsRouter on a small express app. The two stores behind it are mocked, so what is asserted here is the route's own
// work: the auth gate, parsing and validating the query parameters, route order, the 404s and what is handed to the stores.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run signals route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});

const loadSignalsScreenMock = vi.fn();
const loadSignalsUniverseTickerMock = vi.fn();
const loadAccountContextMock = vi.fn();
const loadTickerSignalsMock = vi.fn();
const loadRoadmapCountsMock = vi.fn();
vi.mock("../lib/signalsStore.js", () => ({
  loadSignalsScreen: (...args: unknown[]) => loadSignalsScreenMock(...args),
  loadSignalsUniverseTicker: (...args: unknown[]) => loadSignalsUniverseTickerMock(...args),
  loadAccountContext: (...args: unknown[]) => loadAccountContextMock(...args),
  loadTickerSignals: (...args: unknown[]) => loadTickerSignalsMock(...args),
  loadRoadmapCounts: (...args: unknown[]) => loadRoadmapCountsMock(...args),
}));

const loadTickerBySymbolMock = vi.fn();
const loadSignalsChainMock = vi.fn();
const loadSignalContractScoreMock = vi.fn();
vi.mock("../lib/signalsChainStore.js", () => ({
  loadTickerBySymbol: (...args: unknown[]) => loadTickerBySymbolMock(...args),
  loadSignalsChain: (...args: unknown[]) => loadSignalsChainMock(...args),
  loadSignalContractScore: (...args: unknown[]) => loadSignalContractScoreMock(...args),
}));

const { db } = await import("../db/connection.js");
const { signalsRouter } = await import("./signals.js");
const { buildSignalsRoadmap } = await import("../lib/signalsRoadmap.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/signals", signalsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb.destroy();
});

const knownTicker = { id: "ticker-id-1", symbol: "AAPL" };

beforeEach(() => {
  for (const mock of [loadSignalsScreenMock, loadSignalsUniverseTickerMock, loadAccountContextMock, loadTickerSignalsMock, loadRoadmapCountsMock, loadTickerBySymbolMock, loadSignalsChainMock, loadSignalContractScoreMock]) mock.mockReset();
  loadTickerBySymbolMock.mockResolvedValue(knownTicker);
  loadSignalsChainMock.mockResolvedValue({ chain: "stub" });
  loadSignalContractScoreMock.mockResolvedValue({ score: "stub" });
});

afterEach(() => {
  vi.useRealTimers();
});

async function call(path: string, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? "user-1" : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, { headers: asUser ? { "x-test-user-id": asUser } : {} });
  return { status: response.status, json: (await response.json()) as any };
}

describe("auth", () => {
  it.each(["/signals", "/signals/roadmap", "/signals/AAPL", "/signals/AAPL/chain", "/signals/AAPL/contract?expiry=2026-11-20&strike=100&right=C"])("%s is refused without a session and reaches no store", async (path) => {
    expect(await call(path, { asUser: null })).toEqual({ status: 401, json: { error: "Not logged in." } });
    expect(loadSignalsScreenMock).not.toHaveBeenCalled();
    expect(loadSignalsUniverseTickerMock).not.toHaveBeenCalled();
    expect(loadTickerBySymbolMock).not.toHaveBeenCalled();
    expect(loadRoadmapCountsMock).not.toHaveBeenCalled();
  });
});

describe("GET /signals", () => {
  it("answers with the screen rows as the store loaded them", async () => {
    loadSignalsScreenMock.mockResolvedValue([{ symbol: "AAPL" }, { symbol: "MSFT" }]);
    expect(await call("/signals")).toEqual({ status: 200, json: [{ symbol: "AAPL" }, { symbol: "MSFT" }] });
    expect(loadSignalsScreenMock).toHaveBeenCalledTimes(1);
  });

  it("answers with an empty list when the store has no rows", async () => {
    loadSignalsScreenMock.mockResolvedValue([]);
    expect(await call("/signals")).toEqual({ status: 200, json: [] });
  });

  it("a store failure is a 500, not a hang", async () => {
    loadSignalsScreenMock.mockRejectedValue(new Error("store down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await fetch(`${baseUrl}/signals`, { headers: { "x-test-user-id": "user-1" } });
      expect(response.status).toBe(500);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("GET /signals/roadmap", () => {
  const counts = { snapshotNights: 7, fittedNights: 3, minimumPastEarningsPerTicker: 2, signalsOrderFills: 5 };

  it("is not read as a ticker named roadmap", async () => {
    loadRoadmapCountsMock.mockResolvedValue(counts);
    await call("/signals/roadmap");
    expect(loadSignalsUniverseTickerMock).not.toHaveBeenCalled();
  });

  it("dates the roadmap by the Eastern calendar day, not the UTC one, and builds the items from the store's counts", async () => {
    // 03:00 UTC on 10 March is 23:00 (daylight time) on 9 March in New York.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T03:00:00Z"));
    loadRoadmapCountsMock.mockResolvedValue(counts);

    const response = await call("/signals/roadmap");

    expect(response.status).toBe(200);
    expect(response.json.asOfDateIso).toBe("2026-03-09");
    expect(response.json.items).toEqual(JSON.parse(JSON.stringify(buildSignalsRoadmap(counts, "2026-03-09"))));
    expect(response.json.items.length).toBeGreaterThan(0);
    expect(loadRoadmapCountsMock).toHaveBeenCalledTimes(1);
    expect(loadRoadmapCountsMock.mock.calls[0]![0]).toEqual(new Date("2026-03-10T03:00:00Z"));
  });

  it("the Eastern date moves on at Eastern midnight", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T04:30:00Z"));
    loadRoadmapCountsMock.mockResolvedValue(counts);
    expect((await call("/signals/roadmap")).json.asOfDateIso).toBe("2026-03-10");
  });
});

describe("GET /signals/:symbol", () => {
  it("looks the symbol up as given, loads the account context and answers with the detail for that ticker", async () => {
    const universeTicker = { id: "t-1", symbol: "AAPL" };
    const accountContext = { netLiquidation: 1000 };
    loadSignalsUniverseTickerMock.mockResolvedValue(universeTicker);
    loadAccountContextMock.mockResolvedValue(accountContext);
    loadTickerSignalsMock.mockResolvedValue({ symbol: "AAPL", candidates: [] });

    expect(await call("/signals/aapl")).toEqual({ status: 200, json: { symbol: "AAPL", candidates: [] } });

    expect(loadSignalsUniverseTickerMock).toHaveBeenCalledWith("aapl");
    expect(loadTickerSignalsMock).toHaveBeenCalledWith(universeTicker, accountContext, { withUncompensatedShare: true });
  });

  it("a symbol that is neither on the shortlist nor held short is a 404 naming it in upper case, and loads nothing else", async () => {
    loadSignalsUniverseTickerMock.mockResolvedValue(null);
    expect(await call("/signals/zzz")).toEqual({ status: 404, json: { error: "ZZZ is not on the shortlist and has no open short option leg" } });
    expect(loadAccountContextMock).not.toHaveBeenCalled();
    expect(loadTickerSignalsMock).not.toHaveBeenCalled();
  });
});

describe("GET /signals/:symbol/chain", () => {
  it("with no query parameters asks for the store's default expiry and the snapshot spot", async () => {
    expect(await call("/signals/AAPL/chain")).toEqual({ status: 200, json: { chain: "stub" } });
    expect(loadTickerBySymbolMock).toHaveBeenCalledWith("AAPL");
    expect(loadSignalsChainMock).toHaveBeenCalledWith(knownTicker, null, null);
  });

  it.each([
    ["a dashed date", "2026-11-20", "2026-11-20"],
    ["a compact date", "20261120", "2026-11-20"],
  ])("accepts %s as the expiry and hands it over dashed", async (_label, given, expected) => {
    await call(`/signals/AAPL/chain?expiry=${given}`);
    expect(loadSignalsChainMock).toHaveBeenCalledWith(knownTicker, expected, null);
  });

  it("does not check that the expiry is a real calendar date, only its shape", async () => {
    await call("/signals/AAPL/chain?expiry=2026-13-45");
    expect(loadSignalsChainMock).toHaveBeenCalledWith(knownTicker, "2026-13-45", null);
  });

  it.each([
    ["US slashes", "11/20/2026"],
    ["a two-digit year", "26-11-20"],
    ["a compact date with a dash missing", "2026-1120"],
    ["seven digits", "2026112"],
    ["nine digits", "202611200"],
    ["text", "tomorrow"],
    ["an empty value", ""],
    ["a date with a trailing space", "2026-11-20%20"],
    ["a date with a time", "2026-11-20T00:00:00"],
  ])("refuses %s as the expiry with a 400 and loads nothing", async (_label, given) => {
    expect(await call(`/signals/AAPL/chain?expiry=${given}`)).toEqual({ status: 400, json: { error: "expiry must be a YYYY-MM-DD or YYYYMMDD date." } });
    expect(loadTickerBySymbolMock).not.toHaveBeenCalled();
    expect(loadSignalsChainMock).not.toHaveBeenCalled();
  });

  it("refuses a repeated expiry parameter (an array) as malformed", async () => {
    expect((await call("/signals/AAPL/chain?expiry=2026-11-20&expiry=2026-12-18")).status).toBe(400);
  });

  it("turns a positive spotPrice into a live spot", async () => {
    await call("/signals/AAPL/chain?spotPrice=187.35");
    expect(loadSignalsChainMock).toHaveBeenCalledWith(knownTicker, null, { spotPrice: 187.35, priceSource: "live" });
  });

  it("combines the expiry and the live spot", async () => {
    await call("/signals/AAPL/chain?expiry=20261120&spotPrice=0.5");
    expect(loadSignalsChainMock).toHaveBeenCalledWith(knownTicker, "2026-11-20", { spotPrice: 0.5, priceSource: "live" });
  });

  it.each([
    ["zero", "0"],
    ["negative", "-3"],
    ["text", "abc"],
    ["empty", ""],
    ["infinite", "Infinity"],
    ["not a number", "NaN"],
    ["repeated", "5&spotPrice=6"],
  ])("refuses a spotPrice that is %s with a 400 and loads nothing", async (_label, given) => {
    expect(await call(`/signals/AAPL/chain?spotPrice=${given}`)).toEqual({ status: 400, json: { error: "spotPrice must be a positive number." } });
    expect(loadTickerBySymbolMock).not.toHaveBeenCalled();
    expect(loadSignalsChainMock).not.toHaveBeenCalled();
  });

  it("reports the expiry problem first when both parameters are bad", async () => {
    expect((await call("/signals/AAPL/chain?expiry=x&spotPrice=-1")).json.error).toBe("expiry must be a YYYY-MM-DD or YYYYMMDD date.");
  });

  it("an unknown ticker is a 404 naming it in upper case, after the parameters passed validation", async () => {
    loadTickerBySymbolMock.mockResolvedValue(null);
    expect(await call("/signals/nope/chain?expiry=2026-11-20")).toEqual({ status: 404, json: { error: "NOPE is not a known ticker." } });
    expect(loadSignalsChainMock).not.toHaveBeenCalled();
  });

  it("validates before it looks the ticker up: a bad expiry on an unknown ticker is still a 400", async () => {
    loadTickerBySymbolMock.mockResolvedValue(null);
    expect((await call("/signals/nope/chain?expiry=bad")).status).toBe(400);
  });
});

describe("GET /signals/:symbol/contract", () => {
  const validQuery = "expiry=2026-11-20&strike=187.5&right=C";

  it("scores the contract with no live spot when spotPrice is absent", async () => {
    expect(await call(`/signals/AAPL/contract?${validQuery}`)).toEqual({ status: 200, json: { score: "stub" } });
    expect(loadSignalContractScoreMock).toHaveBeenCalledWith(knownTicker, { expiry: "2026-11-20", strike: 187.5, right: "C" }, null);
  });

  it("accepts a compact expiry, a put and a live spot", async () => {
    await call("/signals/AAPL/contract?expiry=20261120&strike=90&right=P&spotPrice=101.25");
    expect(loadSignalContractScoreMock).toHaveBeenCalledWith(knownTicker, { expiry: "2026-11-20", strike: 90, right: "P" }, { spotPrice: 101.25, priceSource: "live" });
  });

  it.each([
    ["missing", ""],
    ["malformed", "&expiry=11/20/2026"],
  ])("an expiry that is %s is a 400 saying it is required", async (_label, expiryPart) => {
    const response = await call(`/signals/AAPL/contract?strike=100&right=C${expiryPart}`);
    expect(response).toEqual({ status: 400, json: { error: "expiry is required as a YYYY-MM-DD or YYYYMMDD date." } });
    expect(loadSignalContractScoreMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", ""],
    ["zero", "&strike=0"],
    ["negative", "&strike=-5"],
    ["text", "&strike=abc"],
    ["empty", "&strike="],
    ["infinite", "&strike=Infinity"],
  ])("a strike that is %s is a 400", async (_label, strikePart) => {
    const response = await call(`/signals/AAPL/contract?expiry=2026-11-20&right=C${strikePart}`);
    expect(response).toEqual({ status: 400, json: { error: "strike must be a positive number." } });
    expect(loadSignalContractScoreMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", ""],
    ["lower case", "&right=c"],
    ["the word call", "&right=CALL"],
    ["empty", "&right="],
    ["repeated", "&right=C&right=P"],
  ])("a right that is %s is a 400", async (_label, rightPart) => {
    const response = await call(`/signals/AAPL/contract?expiry=2026-11-20&strike=100${rightPart}`);
    expect(response).toEqual({ status: 400, json: { error: "right must be C or P." } });
    expect(loadSignalContractScoreMock).not.toHaveBeenCalled();
  });

  it("a spotPrice that is not a positive number is a 400", async () => {
    expect(await call(`/signals/AAPL/contract?${validQuery}&spotPrice=0`)).toEqual({ status: 400, json: { error: "spotPrice must be a positive number." } });
    expect(loadSignalContractScoreMock).not.toHaveBeenCalled();
  });

  it("checks the expiry, then the strike, then the right, then the spot, reporting the first failure", async () => {
    expect((await call("/signals/AAPL/contract?strike=-1&right=X&spotPrice=0")).json.error).toBe("expiry is required as a YYYY-MM-DD or YYYYMMDD date.");
    expect((await call("/signals/AAPL/contract?expiry=2026-11-20&strike=-1&right=X&spotPrice=0")).json.error).toBe("strike must be a positive number.");
    expect((await call("/signals/AAPL/contract?expiry=2026-11-20&strike=1&right=X&spotPrice=0")).json.error).toBe("right must be C or P.");
    expect((await call("/signals/AAPL/contract?expiry=2026-11-20&strike=1&right=P&spotPrice=0")).json.error).toBe("spotPrice must be a positive number.");
  });

  it("an unknown ticker is a 404 naming it in upper case, only after the parameters passed", async () => {
    loadTickerBySymbolMock.mockResolvedValue(null);
    expect(await call(`/signals/nope/contract?${validQuery}`)).toEqual({ status: 404, json: { error: "NOPE is not a known ticker." } });
    expect(loadSignalContractScoreMock).not.toHaveBeenCalled();
    expect((await call("/signals/nope/contract?strike=1&right=C")).status).toBe(400);
  });
});
