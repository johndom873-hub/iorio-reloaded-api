import { EventEmitter } from "node:events";
import { EventName, OptionType, SecType } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RecordedOperation = [string, ...unknown[]];
const database = vi.hoisted(() => {
  const state = {
    rowsByTable: {} as Record<string, unknown[]>,
    calls: [] as { table: string; operations: RecordedOperation[] }[],
  };
  const builderFor = (table: string) => {
    const call = { table, operations: [] as RecordedOperation[] };
    state.calls.push(call);
    const builder: Record<string, unknown> = {};
    for (const operation of ["where", "whereNotIn", "select", "insert", "onConflict", "merge", "delete"]) {
      builder[operation] = (...args: unknown[]) => {
        call.operations.push([operation, ...args]);
        return builder;
      };
    }
    builder.first = () => {
      call.operations.push(["first"]);
      return Promise.resolve((state.rowsByTable[table] ?? [])[0]);
    };
    builder.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(state.rowsByTable[table] ?? []).then(resolve, reject);
    return builder;
  };
  return { state, db: (table: string) => builderFor(table) };
});
vi.mock("../db/connection.js", () => ({ db: database.db }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: vi.fn() }));

import {
  canReuseStoredGrid,
  daysBetween,
  IbkrLookupTimeoutError,
  loadStoredOptionChain,
  lookupExpiryStrikes,
  lookupOptionParams,
  parseExpiry,
  prepareOptionChainStrikes,
  refreshStoredOptionChain,
} from "./fetchOptionChain.js";

class FakeIbApi extends EventEmitter {
  reqSecDefOptParams = vi.fn();
  reqContractDetails = vi.fn();
}

const asIb = (ib: FakeIbApi) => ib as unknown as Parameters<typeof lookupOptionParams>[0];
const writesTo = (table: string) => database.state.calls.filter((call) => call.table === table && call.operations.some(([operation]) => operation === "insert" || operation === "delete"));

beforeEach(() => {
  database.state.rowsByTable = {};
  database.state.calls.length = 0;
});

describe("parseExpiry", () => {
  it("parses YYYYMMDD as UTC midnight", () => {
    expect(parseExpiry("20261016").toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(parseExpiry("20270101").toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("daysBetween", () => {
  const expiry = parseExpiry("20261016");

  it("counts calendar days from the Eastern date of `from`", () => {
    expect(daysBetween(new Date("2026-10-06T15:00:00Z"), expiry)).toBe(10);
  });

  it("does not run a day short in the Eastern evening, when the UTC date is already tomorrow", () => {
    // 2026-10-07T01:00Z is 21:00 ET on October 6th.
    expect(daysBetween(new Date("2026-10-07T01:00:00Z"), expiry)).toBe(10);
    expect(daysBetween(new Date("2026-10-07T03:59:59Z"), expiry)).toBe(10);
    expect(daysBetween(new Date("2026-10-07T04:00:00Z"), expiry)).toBe(9);
  });

  it("is 0 on the expiry date and negative afterwards", () => {
    expect(daysBetween(new Date("2026-10-16T14:00:00Z"), expiry)).toBe(0);
    expect(daysBetween(new Date("2026-10-17T14:00:00Z"), expiry)).toBe(-1);
  });

  it("is not thrown off by the daylight-saving change on 2026-11-01", () => {
    expect(daysBetween(new Date("2026-10-30T14:00:00Z"), parseExpiry("20261106"))).toBe(7);
  });
});

describe("canReuseStoredGrid", () => {
  const now = new Date("2026-10-06T14:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  const grid = (ageDays: number, strikes = [90, 100, 110]) => ({ strikes, fetchedAt: daysAgo(ageDays) });

  it("is false without a stored grid or with an empty one", () => {
    expect(canReuseStoredGrid(undefined, { maxAgeDays: 7, spotPrice: null }, now)).toBe(false);
    expect(canReuseStoredGrid(grid(0, []), { maxAgeDays: 7, spotPrice: null }, now)).toBe(false);
  });

  it("is true up to the maximum age and false one millisecond past it", () => {
    expect(canReuseStoredGrid(grid(7), { maxAgeDays: 7, spotPrice: null }, now)).toBe(true);
    expect(canReuseStoredGrid({ strikes: [100], fetchedAt: new Date(daysAgo(7).getTime() - 1) }, { maxAgeDays: 7, spotPrice: null }, now)).toBe(false);
  });

  it("with a spot, requires it inside the strike range, ends included", () => {
    const reuse = (spotPrice: number) => canReuseStoredGrid(grid(1), { maxAgeDays: 7, spotPrice }, now);
    expect(reuse(90)).toBe(true);
    expect(reuse(110)).toBe(true);
    expect(reuse(100)).toBe(true);
    expect(reuse(89.99)).toBe(false);
    expect(reuse(110.01)).toBe(false);
  });

  it("decides on age alone when the spot is null, however far outside the range spot would be", () => {
    expect(canReuseStoredGrid(grid(1), { maxAgeDays: 7, spotPrice: null }, now)).toBe(true);
  });

  it("does not look at a spot-range for a grid that is too old", () => {
    expect(canReuseStoredGrid(grid(30), { maxAgeDays: 7, spotPrice: 100 }, now)).toBe(false);
  });
});

describe("lookupOptionParams", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const requestedId = (ib: FakeIbApi) => ib.reqSecDefOptParams.mock.calls[0]![0] as number;

  it("requests the stock's option parameters and resolves with the SMART exchange's expirations", async () => {
    const ib = new FakeIbApi();
    const result = lookupOptionParams(asIb(ib), "AAPL", 265598);
    const reqId = requestedId(ib);
    expect(ib.reqSecDefOptParams).toHaveBeenCalledWith(reqId, "AAPL", "", "STK", 265598);
    ib.emit(EventName.securityDefinitionOptionParameter, reqId, "CBOE", 265598, "AAPL", "100", ["20261009"], [100]);
    ib.emit(EventName.securityDefinitionOptionParameter, reqId + 1, "SMART", 265598, "AAPL", "100", ["20269999"], [100]);
    ib.emit(EventName.securityDefinitionOptionParameter, reqId, "SMART", 265598, "AAPL", "100", ["20261016", "20261023"], [100]);
    expect(await result).toEqual({ expirations: ["20261016", "20261023"] });
  });

  it("copies a Set of expirations into an array", async () => {
    const ib = new FakeIbApi();
    const result = lookupOptionParams(asIb(ib), "AAPL", 1);
    ib.emit(EventName.securityDefinitionOptionParameter, requestedId(ib), "SMART", 1, "AAPL", "100", new Set(["20261016"]), []);
    expect(await result).toEqual({ expirations: ["20261016"] });
  });

  it("removes its listeners once answered", async () => {
    const ib = new FakeIbApi();
    const result = lookupOptionParams(asIb(ib), "AAPL", 1);
    ib.emit(EventName.securityDefinitionOptionParameter, requestedId(ib), "SMART", 1, "AAPL", "100", [], []);
    await result;
    expect(ib.listenerCount(EventName.securityDefinitionOptionParameter)).toBe(0);
    expect(ib.listenerCount(EventName.error)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out after 10 s with the generic message and an IbkrLookupTimeoutError", async () => {
    const ib = new FakeIbApi();
    const captured = lookupOptionParams(asIb(ib), "AAPL", 1).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ib.listenerCount(EventName.error)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await captured) as Error;
    expect(error).toBeInstanceOf(IbkrLookupTimeoutError);
    expect(error.message).toBe("secDefOptParams timeout for AAPL");
    expect(ib.listenerCount(EventName.error)).toBe(0);
  });

  it("reports the last IBKR error for its own request instead of the generic message, and ignores other requests' errors", async () => {
    const ib = new FakeIbApi();
    const captured = lookupOptionParams(asIb(ib), "AAPL", 1).catch((error: Error) => error);
    const reqId = requestedId(ib);
    ib.emit(EventName.error, new Error("not mine"), 321, reqId + 7);
    ib.emit(EventName.error, new Error("first"), 100, reqId);
    ib.emit(EventName.error, new Error("Max rate of messages per second has been exceeded"), 100, reqId);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = (await captured) as Error;
    expect(error).toBeInstanceOf(IbkrLookupTimeoutError);
    expect(error.message).toBe("secDefOptParams error for AAPL (code 100): Max rate of messages per second has been exceeded");
  });

  it("does not reject on an informational error while the request goes on to succeed", async () => {
    const ib = new FakeIbApi();
    const result = lookupOptionParams(asIb(ib), "AAPL", 1);
    const reqId = requestedId(ib);
    ib.emit(EventName.error, new Error("notice"), 2104, reqId);
    ib.emit(EventName.securityDefinitionOptionParameter, reqId, "SMART", 1, "AAPL", "100", ["20261016"], []);
    expect(await result).toEqual({ expirations: ["20261016"] });
  });

  it("uses a new request id for every lookup", () => {
    const ib = new FakeIbApi();
    void lookupOptionParams(asIb(ib), "AAPL", 1).catch(() => undefined);
    void lookupOptionParams(asIb(ib), "MSFT", 2).catch(() => undefined);
    const [first, second] = ib.reqSecDefOptParams.mock.calls.map((call) => call[0] as number);
    expect(second).toBe(first! + 1);
  });
});

describe("lookupExpiryStrikes", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const requestedReqId = (ib: FakeIbApi, callIndex = 0) => ib.reqContractDetails.mock.calls[callIndex]![0] as number;
  const detailsFor = (strike: number) => ({ contract: { strike } });

  it("asks for one wildcard of the expiry's calls on SMART in USD", async () => {
    const ib = new FakeIbApi();
    void lookupExpiryStrikes(asIb(ib), "AAPL", "20261016").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqContractDetails).toHaveBeenCalledWith(expect.any(Number), {
      symbol: "AAPL",
      secType: SecType.OPT,
      lastTradeDateOrContractMonth: "20261016",
      right: OptionType.Call,
      exchange: "SMART",
      currency: "USD",
    });
  });

  it("collects the distinct strikes sorted ascending, counting every contract and ignoring a zero strike", async () => {
    const ib = new FakeIbApi();
    const result = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016");
    await vi.advanceTimersByTimeAsync(0);
    const reqId = requestedReqId(ib);
    for (const strike of [110, 100, 105, 100, 0]) ib.emit(EventName.contractDetails, reqId, detailsFor(strike));
    ib.emit(EventName.contractDetails, reqId + 1, detailsFor(999));
    await vi.advanceTimersByTimeAsync(1_500);
    ib.emit(EventName.contractDetailsEnd, reqId);
    expect(await result).toEqual({ strikes: [100, 105, 110], contractCount: 5, elapsedMs: 1_500 });
  });

  it("resolves an empty grid on error 200 (no security definition), not a failure", async () => {
    const ib = new FakeIbApi();
    const result = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("No security definition has been found"), 200, requestedReqId(ib));
    expect(await result).toEqual({ strikes: [], contractCount: 0, elapsedMs: 0 });
  });

  it("rejects on any other error code, naming the symbol, expiry, code and message", async () => {
    const ib = new FakeIbApi();
    const captured = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("pacing violation"), 162, requestedReqId(ib));
    const error = (await captured) as Error;
    expect(error).not.toBeInstanceOf(IbkrLookupTimeoutError);
    expect(error.message).toBe("strike grid lookup for AAPL 20261016 failed (code 162): pacing violation");
  });

  it("ignores an error for another request", async () => {
    const ib = new FakeIbApi();
    const result = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016");
    await vi.advanceTimersByTimeAsync(0);
    const reqId = requestedReqId(ib);
    ib.emit(EventName.error, new Error("other"), 162, reqId + 5);
    ib.emit(EventName.contractDetailsEnd, reqId);
    expect(await result).toMatchObject({ strikes: [] });
  });

  it("times out after 30 s with an IbkrLookupTimeoutError and removes its listeners", async () => {
    const ib = new FakeIbApi();
    const captured = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016").catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(ib.listenerCount(EventName.contractDetails)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await captured) as Error;
    expect(error).toBeInstanceOf(IbkrLookupTimeoutError);
    expect(error.message).toBe("strike grid lookup for AAPL 20261016 timed out after 30s");
    for (const eventName of [EventName.contractDetails, EventName.contractDetailsEnd, EventName.error]) expect(ib.listenerCount(eventName)).toBe(0);
  });

  it("sends the second lookup on the same connection only after the first finished", async () => {
    const ib = new FakeIbApi();
    const first = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016");
    const second = lookupExpiryStrikes(asIb(ib), "AAPL", "20261023");
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(1);
    ib.emit(EventName.contractDetails, requestedReqId(ib, 0), detailsFor(100));
    ib.emit(EventName.contractDetailsEnd, requestedReqId(ib, 0));
    expect((await first).strikes).toEqual([100]);
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(2);
    expect(ib.reqContractDetails.mock.calls[1]![1]).toMatchObject({ lastTradeDateOrContractMonth: "20261023" });
    ib.emit(EventName.contractDetailsEnd, requestedReqId(ib, 1));
    expect((await second).strikes).toEqual([]);
  });

  it("still sends the next lookup after the previous one failed", async () => {
    const ib = new FakeIbApi();
    const first = lookupExpiryStrikes(asIb(ib), "AAPL", "20261016").catch((error: Error) => error);
    const second = lookupExpiryStrikes(asIb(ib), "AAPL", "20261023");
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.error, new Error("boom"), 162, requestedReqId(ib, 0));
    expect(((await first) as Error).message).toContain("failed (code 162)");
    await vi.advanceTimersByTimeAsync(0);
    expect(ib.reqContractDetails).toHaveBeenCalledTimes(2);
    ib.emit(EventName.contractDetailsEnd, requestedReqId(ib, 1));
    await second;
  });

  it("does not queue lookups of different connections behind each other", async () => {
    const ibOne = new FakeIbApi();
    const ibTwo = new FakeIbApi();
    void lookupExpiryStrikes(asIb(ibOne), "AAPL", "20261016").catch(() => undefined);
    void lookupExpiryStrikes(asIb(ibTwo), "AAPL", "20261016").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(ibOne.reqContractDetails).toHaveBeenCalledTimes(1);
    expect(ibTwo.reqContractDetails).toHaveBeenCalledTimes(1);
  });
});

describe("loadStoredOptionChain", () => {
  it("reads the expirations, the per-expiry strike grids (as numbers) and the fetch time", async () => {
    database.state.rowsByTable.option_chain_params = [{ expirations: ["20261016", "20261023"], fetched_at: "2026-10-06T10:00:00Z" }];
    database.state.rowsByTable.option_chain_expiry_strikes = [
      { expiry: "20261016", strikes: ["95.0000", "100.0000", 105], fetched_at: new Date() },
      { expiry: "20261023", strikes: ["100.5000"], fetched_at: new Date() },
    ];
    const chain = await loadStoredOptionChain("ticker-1");
    expect(chain.expirations).toEqual(["20261016", "20261023"]);
    expect(chain.strikesByExpiry).toEqual(new Map([["20261016", [95, 100, 105]], ["20261023", [100.5]]]));
    expect(chain.fetchedAt).toEqual(new Date("2026-10-06T10:00:00Z"));
  });

  it("is empty with a null fetch time when nothing is stored", async () => {
    expect(await loadStoredOptionChain("ticker-1")).toEqual({ expirations: [], strikesByExpiry: new Map(), fetchedAt: null });
  });

  it("filters both reads by the ticker", async () => {
    await loadStoredOptionChain("ticker-1");
    expect(database.state.calls.map((call) => [call.table, call.operations[0]])).toEqual([
      ["option_chain_params", ["where", { ticker_id: "ticker-1" }]],
      ["option_chain_expiry_strikes", ["where", { ticker_id: "ticker-1" }]],
    ]);
  });
});

describe("prepareOptionChainStrikes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const store = (expirations: string[], grids: Record<string, number[]>) => {
    database.state.rowsByTable.tickers = [{ id: "ticker-1" }];
    database.state.rowsByTable.option_chain_params = [{ expirations, fetched_at: new Date() }];
    database.state.rowsByTable.option_chain_expiry_strikes = Object.entries(grids).map(([expiry, strikes]) => ({ expiry, strikes, fetched_at: new Date() }));
  };

  it("throws, naming the symbol, when the ticker is unknown", async () => {
    await expect(prepareOptionChainStrikes("ZZZZ", 100)).rejects.toThrow("Option chain for ZZZZ is not prepared yet");
  });

  it("throws when the ticker has no stored strike grids", async () => {
    database.state.rowsByTable.tickers = [{ id: "ticker-1" }];
    database.state.rowsByTable.option_chain_params = [{ expirations: ["20261016"], fetched_at: new Date() }];
    await expect(prepareOptionChainStrikes("AAPL", 100)).rejects.toThrow("not prepared yet");
  });

  it("takes three strikes at or below spot and three above, ascending, from each expiry", async () => {
    store(["20261016"], { "20261016": [105, 90, 95, 100, 110, 115, 120, 85] });
    expect(await prepareOptionChainStrikes("AAPL", 100)).toEqual([{ expiry: "20261016", strikes: [90, 95, 100, 105, 110, 115] }]);
  });

  it("counts a strike equal to spot as at-or-below", async () => {
    store(["20261016"], { "20261016": [99, 100, 101] });
    expect(await prepareOptionChainStrikes("AAPL", 100)).toEqual([{ expiry: "20261016", strikes: [99, 100, 101] }]);
  });

  it("keeps the 4 nearest expiries inside 0-60 days, ascending, and drops the rest", async () => {
    const expirations = ["20261221", "20261016", "20261005", "20261009", "20261030", "20261023", "20261106", "20261204"];
    const grids = Object.fromEntries(expirations.map((expiry) => [expiry, [100]]));
    store(expirations, grids);
    // 2026-10-05 is in the past (-1 day); 20261204 is 59 days out but beyond the first four; 20261221 is 76 days out.
    expect((await prepareOptionChainStrikes("AAPL", 100)).map((entry) => entry.expiry)).toEqual(["20261009", "20261016", "20261023", "20261030"]);
  });

  it("includes an expiry on the 60th day and excludes the 61st", async () => {
    store(["20261205", "20261206"], { "20261205": [100], "20261206": [100] });
    // From 2026-10-06 to 2026-12-05 is 60 days.
    expect((await prepareOptionChainStrikes("AAPL", 100)).map((entry) => entry.expiry)).toEqual(["20261205"]);
  });

  it("includes an expiry that is today (0 days)", async () => {
    store(["20261006"], { "20261006": [100] });
    expect((await prepareOptionChainStrikes("AAPL", 100)).map((entry) => entry.expiry)).toEqual(["20261006"]);
  });

  it("drops an in-window expiry that has no stored grid or an empty one", async () => {
    store(["20261009", "20261016", "20261023"], { "20261009": [], "20261016": [100] });
    expect((await prepareOptionChainStrikes("AAPL", 100)).map((entry) => entry.expiry)).toEqual(["20261016"]);
  });
});

describe("refreshStoredOptionChain", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  const ticker = { tickerId: "ticker-1", symbol: "AAPL", contractId: 265598 };
  const today = "2026-10-06";

  /** Answers every IBKR request of the refresh immediately: the option params, then each expiry's strikes in turn. */
  function connectedIb(expirations: string[], strikesByExpiry: Record<string, number[] | "error200">): FakeIbApi {
    const ib = new FakeIbApi();
    ib.reqSecDefOptParams.mockImplementation((reqId: number) => {
      queueMicrotask(() => ib.emit(EventName.securityDefinitionOptionParameter, reqId, "SMART", 265598, "AAPL", "100", expirations, [100]));
    });
    ib.reqContractDetails.mockImplementation((reqId: number, contract: { lastTradeDateOrContractMonth: string }) => {
      const answer = strikesByExpiry[contract.lastTradeDateOrContractMonth];
      queueMicrotask(() => {
        if (answer === "error200" || answer === undefined) ib.emit(EventName.error, new Error("No security definition has been found"), 200, reqId);
        else {
          for (const strike of answer) ib.emit(EventName.contractDetails, reqId, { contract: { strike } });
          ib.emit(EventName.contractDetailsEnd, reqId);
        }
      });
    });
    return ib;
  }

  const gridInsertFor = (expiry: string) =>
    database.state.calls.find((call) => call.table === "option_chain_expiry_strikes" && call.operations.some(([operation, row]) => operation === "insert" && (row as { expiry: string }).expiry === expiry));

  it("looks up every expiry inside 0-90 days, ascending and one at a time, and returns them with the full expiry list", async () => {
    const expirations = ["20261030", "20261009", "20261005", "20270105", "20261016"];
    const ib = connectedIb(expirations, { "20261009": [100], "20261016": [95, 100], "20261030": [90] });
    const result = await refreshStoredOptionChain(asIb(ib), ticker, today);
    expect(ib.reqContractDetails.mock.calls.map((call) => call[1].lastTradeDateOrContractMonth)).toEqual(["20261009", "20261016", "20261030"]);
    expect(result.expirations).toEqual(expirations);
    expect([...result.strikesByExpiry.entries()]).toEqual([["20261009", [100]], ["20261016", [95, 100]], ["20261030", [90]]]);
    expect(result.timings.expiries.map((timing) => [timing.expiry, timing.strikeCount])).toEqual([["20261009", 1], ["20261016", 2], ["20261030", 1]]);
  });

  it("treats day 0 and day 90 as inside the window and day 91 and yesterday as outside", async () => {
    // 2026-10-06 + 90 days = 2027-01-04.
    const ib = connectedIb(["20261005", "20261006", "20270104", "20270105"], { "20261006": [100], "20270104": [100] });
    const result = await refreshStoredOptionChain(asIb(ib), ticker, today);
    expect([...result.strikesByExpiry.keys()]).toEqual(["20261006", "20270104"]);
  });

  it("stores each looked-up grid with an upsert on (ticker_id, expiry)", async () => {
    const ib = connectedIb(["20261016"], { "20261016": [95, 100] });
    await refreshStoredOptionChain(asIb(ib), ticker, today);
    const insertCall = gridInsertFor("20261016")!;
    const insertOperation = insertCall.operations.find(([operation]) => operation === "insert")!;
    expect(insertOperation[1]).toEqual({ ticker_id: "ticker-1", expiry: "20261016", strikes: [95, 100], fetched_at: new Date("2026-10-06T15:00:00Z") });
    expect(insertCall.operations).toContainEqual(["onConflict", ["ticker_id", "expiry"]]);
    expect(insertCall.operations).toContainEqual(["merge"]);
  });

  it("writes the params last, with every listed expiry, after the grids and the stale-grid cleanup", async () => {
    const ib = connectedIb(["20261016", "20270301"], { "20261016": [100] });
    await refreshStoredOptionChain(asIb(ib), ticker, today);
    const writes = database.state.calls.filter((call) => call.operations.some(([operation]) => ["insert", "delete"].includes(operation)));
    expect(writes.map((call) => [call.table, call.operations.some(([operation]) => operation === "delete") ? "delete" : "insert"])).toEqual([
      ["option_chain_expiry_strikes", "insert"],
      ["option_chain_expiry_strikes", "delete"],
      ["option_chain_params", "insert"],
    ]);
    const paramsInsert = writes[2]!.operations.find(([operation]) => operation === "insert")![1];
    expect(paramsInsert).toEqual({ ticker_id: "ticker-1", expirations: ["20261016", "20270301"], fetched_at: new Date("2026-10-06T15:00:00Z") });
    expect(writes[2]!.operations).toContainEqual(["onConflict", "ticker_id"]);
  });

  it("deletes the stored grids of expiries outside the window for this ticker only", async () => {
    const ib = connectedIb(["20261016"], { "20261016": [100] });
    await refreshStoredOptionChain(asIb(ib), ticker, today);
    const deleteCall = database.state.calls.find((call) => call.operations.some(([operation]) => operation === "delete"))!;
    expect(deleteCall.operations).toEqual([["where", { ticker_id: "ticker-1" }], ["whereNotIn", "expiry", ["20261016"]], ["delete"]]);
  });

  it("never issues the cleanup delete when no expiry is inside the window (an empty NOT IN would wipe the ticker)", async () => {
    const ib = connectedIb(["20250101", "20280101"], {});
    const result = await refreshStoredOptionChain(asIb(ib), ticker, today);
    expect(result.strikesByExpiry.size).toBe(0);
    expect(database.state.calls.some((call) => call.operations.some(([operation]) => operation === "delete"))).toBe(false);
    expect(writesTo("option_chain_params")).toHaveLength(1);
  });

  describe("an empty lookup", () => {
    beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => undefined));

    it("keeps the stored grid, writes nothing for that expiry and warns", async () => {
      database.state.rowsByTable.option_chain_expiry_strikes = [{ expiry: "20261016", strikes: ["95.0000", "100.0000"], fetched_at: new Date("2026-10-01T00:00:00Z") }];
      const ib = connectedIb(["20261016"], { "20261016": "error200" });
      const result = await refreshStoredOptionChain(asIb(ib), ticker, today);
      expect(result.strikesByExpiry.get("20261016")).toEqual([95, 100]);
      expect(gridInsertFor("20261016")).toBeUndefined();
      expect(console.warn).toHaveBeenCalledWith("AAPL 20261016: strike lookup came back empty — keeping the stored grid (2 strikes).");
      expect(result.timings.expiries[0]).toMatchObject({ expiry: "20261016", strikeCount: 2 });
      expect(result.timings.expiries[0]!.reused).toBeUndefined();
    });

    it("stores the empty grid when nothing was stored before", async () => {
      const ib = connectedIb(["20261016"], { "20261016": "error200" });
      const result = await refreshStoredOptionChain(asIb(ib), ticker, today);
      expect(result.strikesByExpiry.get("20261016")).toEqual([]);
      expect(gridInsertFor("20261016")!.operations.find(([operation]) => operation === "insert")![1]).toMatchObject({ strikes: [] });
    });
  });

  describe("with a stored-grid reuse policy", () => {
    const storedRow = (expiry: string, strikes: number[], fetchedAt: string) => ({ expiry, strikes: strikes.map(String), fetched_at: new Date(fetchedAt) });

    it("reuses a fresh grid that contains spot: no IBKR lookup, no write for it, timing marked reused", async () => {
      database.state.rowsByTable.option_chain_expiry_strikes = [storedRow("20261016", [90, 100, 110], "2026-10-05T00:00:00Z")];
      const ib = connectedIb(["20261016"], {});
      const result = await refreshStoredOptionChain(asIb(ib), ticker, today, { maxAgeDays: 7, spotPrice: 100 });
      expect(ib.reqContractDetails).not.toHaveBeenCalled();
      expect(result.strikesByExpiry.get("20261016")).toEqual([90, 100, 110]);
      expect(result.timings.expiries).toEqual([{ expiry: "20261016", strikeCount: 3, elapsedMs: 0, reused: true }]);
      expect(gridInsertFor("20261016")).toBeUndefined();
    });

    it("looks an expiry up again when its stored grid is too old, or spot has left its range", async () => {
      database.state.rowsByTable.option_chain_expiry_strikes = [storedRow("20261016", [90, 100, 110], "2026-09-01T00:00:00Z"), storedRow("20261023", [90, 100, 110], "2026-10-05T00:00:00Z")];
      const ib = connectedIb(["20261016", "20261023"], { "20261016": [100], "20261023": [150] });
      const result = await refreshStoredOptionChain(asIb(ib), ticker, today, { maxAgeDays: 7, spotPrice: 150 });
      expect(ib.reqContractDetails).toHaveBeenCalledTimes(2);
      expect(result.strikesByExpiry.get("20261016")).toEqual([100]);
      expect(result.strikesByExpiry.get("20261023")).toEqual([150]);
    });

    it("never reuses without a policy, even for a brand-new grid", async () => {
      database.state.rowsByTable.option_chain_expiry_strikes = [storedRow("20261016", [90, 100, 110], new Date().toISOString())];
      const ib = connectedIb(["20261016"], { "20261016": [100] });
      await refreshStoredOptionChain(asIb(ib), ticker, today);
      expect(ib.reqContractDetails).toHaveBeenCalledTimes(1);
    });

    it("reads stored grids keyed by YYYYMMDD even when the stored expiry carries dashes", async () => {
      database.state.rowsByTable.option_chain_expiry_strikes = [storedRow("2026-10-16", [90, 100, 110], "2026-10-05T00:00:00Z")];
      const ib = connectedIb(["20261016"], {});
      await refreshStoredOptionChain(asIb(ib), ticker, today, { maxAgeDays: 7, spotPrice: null });
      expect(ib.reqContractDetails).not.toHaveBeenCalled();
    });
  });

  it("propagates an IBKR failure after keeping the expiries already stored, and never writes the params", async () => {
    const ib = connectedIb(["20261009", "20261016"], { "20261009": [100] });
    ib.reqContractDetails.mockImplementation((reqId: number, contract: { lastTradeDateOrContractMonth: string }) => {
      queueMicrotask(() => {
        if (contract.lastTradeDateOrContractMonth === "20261009") {
          ib.emit(EventName.contractDetails, reqId, { contract: { strike: 100 } });
          ib.emit(EventName.contractDetailsEnd, reqId);
        } else {
          ib.emit(EventName.error, new Error("pacing violation"), 162, reqId);
        }
      });
    });
    await expect(refreshStoredOptionChain(asIb(ib), ticker, today)).rejects.toThrow("strike grid lookup for AAPL 20261016 failed (code 162): pacing violation");
    expect(gridInsertFor("20261009")).toBeDefined();
    expect(gridInsertFor("20261016")).toBeUndefined();
    expect(writesTo("option_chain_params")).toHaveLength(0);
  });
});
