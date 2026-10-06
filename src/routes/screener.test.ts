import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real screenerRouter on a small express app against the test database (screener_universe, tickers and shortlist_entries are
// real). The IBKR-backed ticker lookup is mocked: the stand-in finds or inserts a ticker row and the shortlist insert is real, so the
// duplicate case runs against the real partial unique index, while the backfill that follows a real add never starts.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run screener route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const unknownSymbolsForLookup = new Set<string>();
const findOrCreateTickerMock = vi.fn();
const addTickerToShortlistMock = vi.fn();
vi.mock("../ibkr/findOrCreateTicker.js", async () => {
  const actual = await vi.importActual<typeof import("../ibkr/findOrCreateTicker.js")>("../ibkr/findOrCreateTicker.js");
  return {
    UnknownSymbolError: actual.UnknownSymbolError,
    findOrCreateTicker: (...args: unknown[]) => findOrCreateTickerMock(...args),
    addTickerToShortlist: (...args: unknown[]) => addTickerToShortlistMock(...args),
  };
});

const { db } = await import("../db/connection.js");
const { screenerRouter } = await import("./screener.js");
const { UnknownSymbolError } = await import("../ibkr/findOrCreateTicker.js");

const testDb: Knex = db;

const runTag = String(Date.now() % 100_000_000);
const symbolPrefix = `SRT${runTag}`;
const sectorTech = `SRT Tech ${runTag}`;
const sectorEnergy = `SRT Energy ${runTag}`;
const codeVolatility = `SRT_VOLATILITY_${runTag}`;
const codeOptionVolume = `SRT_OPTION_VOLUME_${runTag}`;

let server: Server;
let baseUrl: string;
let userId: string;

interface UniverseSeed {
  letter: string;
  companyName: string | null;
  sector: string | null;
  bestRank: number;
  impliedVolatility: number | null;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  matchedScanCodes: string[];
}

// Ranks are the stored 0-indexed ones: A and B are in the "1-10" bucket (0 and 9), C is the first of "11-20" (10), D the last of
// "41-50" (49), F is just past it (50), E is unmatched (999) and G to K sit in no bucket.
const seeds: UniverseSeed[] = [
  { letter: "A", companyName: `Alpha Corp ${runTag}`, sector: sectorTech, bestRank: 0, impliedVolatility: 0.5, callOpenInterest: 1000, putOpenInterest: 400, matchedScanCodes: [codeVolatility, codeOptionVolume] },
  { letter: "B", companyName: `Beta Corp ${runTag}`, sector: sectorEnergy, bestRank: 9, impliedVolatility: 0.3, callOpenInterest: 200, putOpenInterest: 900, matchedScanCodes: [codeOptionVolume] },
  { letter: "C", companyName: `Gamma Corp ${runTag}`, sector: sectorTech, bestRank: 10, impliedVolatility: 0.8, callOpenInterest: 5000, putOpenInterest: 5000, matchedScanCodes: [codeVolatility] },
  { letter: "D", companyName: `Delta Corp ${runTag}`, sector: null, bestRank: 49, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, matchedScanCodes: [] },
  { letter: "E", companyName: `Epsilon Corp ${runTag}`, sector: sectorEnergy, bestRank: 999, impliedVolatility: 0.1, callOpenInterest: 10, putOpenInterest: 10, matchedScanCodes: [] },
  { letter: "F", companyName: `Zeta Corp ${runTag}`, sector: sectorEnergy, bestRank: 50, impliedVolatility: 0.2, callOpenInterest: 20, putOpenInterest: 30, matchedScanCodes: [] },
  { letter: "G", companyName: `100% real ${runTag}`, sector: null, bestRank: 500, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, matchedScanCodes: [] },
  { letter: "H", companyName: `100X real ${runTag}`, sector: null, bestRank: 500, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, matchedScanCodes: [] },
  { letter: "I", companyName: `a_b ${runTag}`, sector: null, bestRank: 500, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, matchedScanCodes: [] },
  { letter: "J", companyName: `aXb ${runTag}`, sector: null, bestRank: 500, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, matchedScanCodes: [] },
  { letter: "K", companyName: null, sector: null, bestRank: 500, impliedVolatility: null, callOpenInterest: null, putOpenInterest: 3000, matchedScanCodes: [] },
];
const symbolOf = (letter: string) => `${symbolPrefix}${letter}`;
const letterOf = (symbol: string) => symbol.slice(symbolPrefix.length);

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `screener-route-${runTag}`, display_name: "Screener Route Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  await testDb("screener_universe").insert(
    seeds.map((seed) => ({
      symbol: symbolOf(seed.letter),
      company_name: seed.companyName,
      sector: seed.sector,
      best_rank: seed.bestRank,
      implied_volatility: seed.impliedVolatility,
      call_open_interest: seed.callOpenInterest,
      put_open_interest: seed.putOpenInterest,
      matched_scan_codes: seed.matchedScanCodes,
      last_price: seed.letter === "A" ? 12.5 : null,
      avg_share_volume: seed.letter === "A" ? 1500000 : null,
      avg_option_volume: seed.letter === "A" ? 4200 : null,
      bid_ask_spread_pct: seed.letter === "A" ? 0.0125 : null,
      last_matched_at: seed.letter === "A" ? new Date("2026-09-30T20:00:00Z") : null,
    })),
  );

  // A is on the shortlist, B was removed from it (so it is not).
  const tickerRows = await testDb("tickers").insert([{ symbol: symbolOf("A") }, { symbol: symbolOf("B") }]).returning(["id", "symbol"]);
  const tickerIdBySymbol = new Map<string, string>(tickerRows.map((row) => [row.symbol, row.id]));
  await testDb("shortlist_entries").insert([
    { ticker_id: tickerIdBySymbol.get(symbolOf("A")), added_by_user_id: userId },
    { ticker_id: tickerIdBySymbol.get(symbolOf("B")), added_by_user_id: userId, removed_at: new Date() },
  ]);

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/screener", screenerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  unknownSymbolsForLookup.clear();
  findOrCreateTickerMock.mockReset();
  addTickerToShortlistMock.mockReset();
  findOrCreateTickerMock.mockImplementation(async (symbol: string) => {
    if (unknownSymbolsForLookup.has(symbol)) throw new UnknownSymbolError(symbol);
    const existing = await testDb("tickers").where({ symbol }).first();
    if (existing) return { ticker: existing, created: false };
    const [inserted] = await testDb("tickers").insert({ symbol }).returning("*");
    return { ticker: inserted, created: true };
  });
  addTickerToShortlistMock.mockImplementation(async (tickerId: string, _symbol: string, addedByUserId: string | undefined, notes?: string | null) => {
    const [entry] = await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: addedByUserId, notes: notes ?? null }).returning("*");
    return { id: entry.id, addedAt: entry.added_at, notes: entry.notes, backfillRun: null };
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const tickerIds = (await testDb("tickers").where("symbol", "like", `${symbolPrefix}%`).select("id")).map((row) => row.id);
  await testDb("shortlist_entries").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb("screener_universe").where("symbol", "like", `${symbolPrefix}%`).del();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function call(method: "GET" | "POST", path: string, body?: unknown, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  return { status: response.status, json: text && isJson ? (JSON.parse(text) as any) : null };
}

/** The letters of this file's rows that a filtered listing returns, in the order returned. */
async function listLetters(query: string): Promise<string[]> {
  const response = await call("GET", `/screener?search=${symbolPrefix}${query ? `&${query}` : ""}`);
  expect(response.status).toBe(200);
  return (response.json as { symbol: string }[]).map((row) => letterOf(row.symbol));
}

const sortedLetters = (letters: string[]) => [...letters].sort();

describe("auth", () => {
  it.each([
    ["GET", "/screener"],
    ["GET", "/screener/sectors"],
    ["POST", `/screener/${symbolOf("C")}/shortlist`],
  ] as const)("%s %s is refused without a session", async (method, path) => {
    expect(await call(method, path, method === "POST" ? {} : undefined, { asUser: null })).toEqual({ status: 401, json: { error: "Not logged in." } });
    expect(findOrCreateTickerMock).not.toHaveBeenCalled();
  });
});

describe("GET /screener: the row shape", () => {
  it("maps a stored row to camelCase fields, keeping numerics as strings and ranks 0-indexed", async () => {
    const response = await call("GET", `/screener?search=${symbolOf("A")}`);
    expect(response.status).toBe(200);
    expect(response.json).toEqual([
      {
        id: expect.any(String),
        symbol: symbolOf("A"),
        companyName: `Alpha Corp ${runTag}`,
        sector: sectorTech,
        bestRank: 0,
        matchedScanCodes: [codeVolatility, codeOptionVolume],
        lastPrice: "12.5000",
        avgShareVolume: "1500000.00",
        avgOptionVolume: "4200.00",
        callOpenInterest: "1000.00",
        putOpenInterest: "400.00",
        bidAskSpreadPct: "0.012500",
        impliedVolatility: "0.500000",
        firstSeenAt: expect.any(String),
        lastMatchedAt: "2026-09-30T20:00:00.000Z",
        lastRefreshedAt: expect.any(String),
        isShortlisted: true,
      },
    ]);
  });

  it("returns nulls for what was never captured", async () => {
    const [row] = (await call("GET", `/screener?search=${symbolOf("D")}`)).json;
    expect(row).toMatchObject({ companyName: `Delta Corp ${runTag}`, sector: null, lastPrice: null, impliedVolatility: null, callOpenInterest: null, putOpenInterest: null, lastMatchedAt: null, matchedScanCodes: [] });
  });

  it("flags isShortlisted only for a symbol with an active shortlist entry (a removed entry does not count, neither does no ticker at all)", async () => {
    const rows = (await call("GET", `/screener?search=${symbolPrefix}`)).json as { symbol: string; isShortlisted: boolean }[];
    const shortlistedLetters = rows.filter((row) => row.isShortlisted).map((row) => letterOf(row.symbol));
    expect(shortlistedLetters).toEqual(["A"]);
    expect(rows.find((row) => row.symbol === symbolOf("B"))!.isShortlisted).toBe(false);
    expect(rows.find((row) => row.symbol === symbolOf("C"))!.isShortlisted).toBe(false);
  });

  it("orders by best rank ascending, with the unmatched sentinel last", async () => {
    const letters = await listLetters("");
    expect(letters.slice(0, 5)).toEqual(["A", "B", "C", "D", "F"]);
    expect(sortedLetters(letters.slice(5, 10))).toEqual(["G", "H", "I", "J", "K"]);
    expect(letters[10]).toBe("E");
  });
});

describe("GET /screener: search", () => {
  it("matches the symbol, case-insensitively", async () => {
    expect(await listLetters("")).toHaveLength(seeds.length);
    const lower = await call("GET", `/screener?search=${symbolOf("A").toLowerCase()}`);
    expect(lower.json.map((row: { symbol: string }) => row.symbol)).toEqual([symbolOf("A")]);
  });

  it("matches the company name, case-insensitively, and a partial name", async () => {
    const response = await call("GET", `/screener?search=${encodeURIComponent(`alpha corp ${runTag}`)}`);
    expect(response.json.map((row: { symbol: string }) => row.symbol)).toEqual([symbolOf("A")]);
    const partial = await call("GET", `/screener?search=${encodeURIComponent(`eta corp ${runTag}`)}`);
    expect(sortedLetters(partial.json.map((row: { symbol: string }) => letterOf(row.symbol)))).toEqual(["B", "F"]);
  });

  it("trims surrounding spaces", async () => {
    const response = await call("GET", `/screener?search=${encodeURIComponent(`  ${symbolOf("A")}  `)}`);
    expect(response.json.map((row: { symbol: string }) => row.symbol)).toEqual([symbolOf("A")]);
  });

  it("treats a percent sign in the search as a literal character, not a wildcard", async () => {
    const response = await call("GET", `/screener?search=${encodeURIComponent(`100% real ${runTag}`)}`);
    expect(response.json.map((row: { symbol: string }) => letterOf(row.symbol))).toEqual(["G"]);
  });

  it("treats an underscore in the search as a literal character, not a one-character wildcard", async () => {
    const response = await call("GET", `/screener?search=${encodeURIComponent(`a_b ${runTag}`)}`);
    expect(response.json.map((row: { symbol: string }) => letterOf(row.symbol))).toEqual(["I"]);
  });

  it("a search that matches nothing is an empty list", async () => {
    expect(await call("GET", `/screener?search=${symbolPrefix}NOPE`)).toEqual({ status: 200, json: [] });
  });

  it("a blank search applies no filter at all", async () => {
    const unfiltered = (await call("GET", "/screener?search=%20%20")).json as { symbol: string }[];
    const mine = unfiltered.filter((row) => row.symbol.startsWith(symbolPrefix));
    expect(mine).toHaveLength(seeds.length);
  });
});

describe("GET /screener: sector", () => {
  it("keeps the rows of one sector", async () => {
    expect(sortedLetters(await listLetters(`sector=${encodeURIComponent(sectorTech)}`))).toEqual(["A", "C"]);
  });

  it("keeps the rows of any of several comma-separated sectors", async () => {
    expect(sortedLetters(await listLetters(`sector=${encodeURIComponent(`${sectorTech},${sectorEnergy}`)}`))).toEqual(["A", "B", "C", "E", "F"]);
  });

  it("ignores empty items between commas, and a value of only commas applies no filter", async () => {
    expect(sortedLetters(await listLetters(`sector=${encodeURIComponent(`,${sectorTech},,`)}`))).toEqual(["A", "C"]);
    expect(await listLetters("sector=%2C%2C")).toHaveLength(seeds.length);
  });

  it("does not match a sector by part of its name", async () => {
    expect(await listLetters("sector=SRT%20Tech")).toEqual([]);
  });

  it("never matches rows with no sector", async () => {
    const letters = await listLetters(`sector=${encodeURIComponent(`${sectorTech},${sectorEnergy},Unknown`)}`);
    expect(letters).not.toContain("D");
  });
});

describe("GET /screener: minimum implied volatility", () => {
  it("is inclusive and drops rows with no implied volatility", async () => {
    expect(sortedLetters(await listLetters("minIv=0.5"))).toEqual(["A", "C"]);
  });

  it("a minimum of 0 still drops rows with no implied volatility", async () => {
    const letters = await listLetters("minIv=0");
    expect(sortedLetters(letters)).toEqual(["A", "B", "C", "E", "F"]);
  });

  it("a value that is not a number applies no filter", async () => {
    expect(await listLetters("minIv=abc")).toHaveLength(seeds.length);
  });

  it("a value above every row is an empty list", async () => {
    expect(await listLetters("minIv=5")).toEqual([]);
  });
});

describe("GET /screener: minimum open interest", () => {
  it("compares the smaller of the call and put open interest, inclusively", async () => {
    // A: min(1000, 400) = 400, B: min(200, 900) = 200, C: 5000. K has no call side, so it never passes.
    expect(sortedLetters(await listLetters("minOpenInterest=400"))).toEqual(["A", "C"]);
  });

  it("a side with no open interest cannot meet the minimum, so the row does not pass (K has only a put side of 3000)", async () => {
    expect(sortedLetters(await listLetters("minOpenInterest=2000"))).toEqual(["C"]);
  });

  it("rows with a side not captured never pass, even for a minimum of 0", async () => {
    const letters = await listLetters("minOpenInterest=0");
    expect(letters).not.toContain("D");
    expect(letters).not.toContain("K");
    expect(sortedLetters(letters)).toEqual(["A", "B", "C", "E", "F"]);
  });

  it("a value that is not a number applies no filter", async () => {
    expect(await listLetters("minOpenInterest=lots")).toHaveLength(seeds.length);
  });
});

describe("GET /screener: matched scan codes", () => {
  it("keeps rows that matched the selected scan", async () => {
    expect(sortedLetters(await listLetters(`matchedScanCodes=${codeVolatility}`))).toEqual(["A", "C"]);
  });

  it("with several scans keeps rows that matched any of them, not all of them", async () => {
    expect(sortedLetters(await listLetters(`matchedScanCodes=${codeVolatility},${codeOptionVolume}`))).toEqual(["A", "B", "C"]);
  });

  it("a scan no row matched is an empty list, and a value of only commas applies no filter", async () => {
    expect(await listLetters("matchedScanCodes=SRT_NOBODY_MATCHES")).toEqual([]);
    expect(await listLetters("matchedScanCodes=%2C")).toHaveLength(seeds.length);
  });
});

describe("GET /screener: best rank bucket", () => {
  it.each([
    ["1-10", ["A", "B"]],
    ["11-20", ["C"]],
    ["21-30", []],
    ["31-40", []],
    ["41-50", ["D"]],
    ["unmatched", ["E"]],
  ])("bucket %s covers the stored ranks that read as 1-indexed ones to the user", async (bucket, expectedLetters) => {
    expect(sortedLetters(await listLetters(`bestRankBucket=${bucket}`))).toEqual(expectedLetters);
  });

  it("an unknown bucket name applies no filter", async () => {
    expect(await listLetters("bestRankBucket=51-60")).toHaveLength(seeds.length);
  });
});

describe("GET /screener: combined filters", () => {
  it("applies every filter together", async () => {
    const letters = await listLetters(`sector=${encodeURIComponent(sectorTech)}&minIv=0.6&minOpenInterest=1000&matchedScanCodes=${codeVolatility}&bestRankBucket=11-20`);
    expect(letters).toEqual(["C"]);
  });

  it("filters that cannot all hold at once give an empty list", async () => {
    expect(await listLetters(`sector=${encodeURIComponent(sectorEnergy)}&bestRankBucket=41-50`)).toEqual([]);
  });
});

describe("GET /screener/sectors", () => {
  it("lists each sector of the whole universe once, in ascending order, without nulls", async () => {
    const response = await call("GET", "/screener/sectors");
    expect(response.status).toBe(200);
    const sectors = response.json as (string | null)[];
    expect(sectors).not.toContain(null);
    expect(new Set(sectors).size).toBe(sectors.length);
    expect(sectors.filter((sector) => sector !== null && sector.endsWith(runTag))).toEqual([sectorEnergy, sectorTech]);
  });
});

describe("POST /screener/:symbol/shortlist", () => {
  const readEntries = async (symbol: string) => {
    const ticker = await testDb("tickers").where({ symbol }).first();
    return ticker ? testDb("shortlist_entries").where({ ticker_id: ticker.id, removed_at: null }) : [];
  };

  it("adds a candidate: creates the ticker, stores the entry with the user and the notes, answers 204 with no body", async () => {
    const symbol = symbolOf("C");
    const response = await call("POST", `/screener/${symbol}/shortlist`, { notes: "looks liquid" });
    expect(response).toEqual({ status: 204, json: null });
    expect(findOrCreateTickerMock).toHaveBeenCalledWith(symbol);
    const tickerRow = await testDb("tickers").where({ symbol }).first();
    expect(addTickerToShortlistMock).toHaveBeenCalledWith(tickerRow.id, symbol, userId, "looks liquid");
    expect(await readEntries(symbol)).toEqual([expect.objectContaining({ added_by_user_id: userId, notes: "looks liquid" })]);
    expect((await call("GET", `/screener?search=${symbol}`)).json[0].isShortlisted).toBe(true);
  });

  it("trims and upper-cases the symbol from the path before looking the candidate up", async () => {
    const symbol = symbolOf("E");
    const response = await call("POST", `/screener/${symbol.toLowerCase()}/shortlist`, {});
    expect(response.status).toBe(204);
    expect(findOrCreateTickerMock).toHaveBeenCalledWith(symbol);
    expect(await readEntries(symbol)).toHaveLength(1);
  });

  it("stores no notes as null when none are sent", async () => {
    const symbol = symbolOf("F");
    expect((await call("POST", `/screener/${symbol}/shortlist`, {})).status).toBe(204);
    expect(addTickerToShortlistMock.mock.calls[0]![3]).toBeUndefined();
    expect(await readEntries(symbol)).toEqual([expect.objectContaining({ notes: null })]);
  });

  it("a request with no body at all adds the candidate without notes instead of failing", async () => {
    const symbol = symbolOf("J");
    const response = await call("POST", `/screener/${symbol}/shortlist`);
    expect(response.status).toBe(204);
    expect(await readEntries(symbol)).toEqual([expect.objectContaining({ notes: null })]);
  });

  it("a symbol that is not in the screener universe is a 404, and nothing is looked up or stored", async () => {
    const response = await call("POST", `/screener/${symbolPrefix}ZZ/shortlist`, {});
    expect(response).toEqual({ status: 404, json: { error: `${symbolPrefix}ZZ is not a current screener candidate.` } });
    expect(findOrCreateTickerMock).not.toHaveBeenCalled();
    expect(addTickerToShortlistMock).not.toHaveBeenCalled();
  });

  it("a symbol IBKR does not recognise is a 422 with its message, and no entry is stored", async () => {
    const symbol = symbolOf("G");
    unknownSymbolsForLookup.add(symbol);
    const response = await call("POST", `/screener/${symbol}/shortlist`, {});
    expect(response.status).toBe(422);
    expect(response.json.error).toContain(`${symbol} is not a symbol IBKR recognises`);
    expect(addTickerToShortlistMock).not.toHaveBeenCalled();
    expect(await readEntries(symbol)).toEqual([]);
  });

  it("a symbol that is already on the shortlist is a 409, and the first entry is left alone", async () => {
    const symbol = symbolOf("A");
    const response = await call("POST", `/screener/${symbol}/shortlist`, { notes: "second try" });
    expect(response).toEqual({ status: 409, json: { error: `${symbol} is already being monitored.` } });
    const entries = await readEntries(symbol);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.notes).toBeNull();
  });

  it("re-adds a symbol whose earlier entry was removed", async () => {
    const symbol = symbolOf("B");
    expect((await call("POST", `/screener/${symbol}/shortlist`, {})).status).toBe(204);
    expect(await readEntries(symbol)).toHaveLength(1);
  });

  it("an unexpected failure while adding is a 500, not a 409", async () => {
    const symbol = symbolOf("H");
    addTickerToShortlistMock.mockRejectedValue(new Error("database exploded"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call("POST", `/screener/${symbol}/shortlist`, {})).status).toBe(500);
    } finally {
      consoleErrorSpy.mockRestore();
    }
    expect(await readEntries(symbol)).toEqual([]);
  });

  it("an unexpected failure in the ticker lookup is a 500, not a 422", async () => {
    findOrCreateTickerMock.mockRejectedValue(new Error("IBKR gateway down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await call("POST", `/screener/${symbolOf("I")}/shortlist`, {})).status).toBe(500);
    } finally {
      consoleErrorSpy.mockRestore();
    }
    expect(addTickerToShortlistMock).not.toHaveBeenCalled();
  });
});
