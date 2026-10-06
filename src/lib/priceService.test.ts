import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const state = {
    inserts: [] as { table: string; rows: Record<string, unknown>[]; conflictColumn: string | null; merged: boolean }[],
    insertImplementation: null as null | (() => Promise<unknown>),
    knownRows: [] as { symbol: string; price: string | number; as_of: string | Date; source: string }[],
    barRows: [] as { symbol: string; price: number | string; date: string }[],
    knownRowsError: null as Error | null,
    whereInArguments: [] as unknown[][],
    rawArguments: [] as unknown[][],
  };
  const db = Object.assign(
    (table: string) => ({
      insert: (rows: Record<string, unknown>[]) => {
        const record = { table, rows, conflictColumn: null as string | null, merged: false };
        state.inserts.push(record);
        return {
          onConflict: (column: string) => {
            record.conflictColumn = column;
            return {
              merge: () => {
                record.merged = true;
                return state.insertImplementation ? state.insertImplementation() : Promise.resolve();
              },
            };
          },
        };
      },
      whereIn: (...args: unknown[]) => {
        state.whereInArguments.push(args);
        return {
          select: () => (state.knownRowsError ? Promise.reject(state.knownRowsError) : Promise.resolve(state.knownRows)),
        };
      },
    }),
    {
      raw: (...args: unknown[]) => {
        state.rawArguments.push(args);
        return Promise.resolve({ rows: state.barRows });
      },
    },
  );
  return { state, db };
});
vi.mock("../db/connection.js", () => ({ db: database.db }));

type PriceService = typeof import("./priceService.js");

describe("priceService", () => {
  let service: PriceService;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T15:00:00Z"));
    Object.assign(database.state, { inserts: [], insertImplementation: null, knownRows: [], barRows: [], knownRowsError: null, whereInArguments: [], rawArguments: [] });
    vi.resetModules();
    service = await import("./priceService.js");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => vi.useRealTimers());

  describe("recordStockPrices and the debounced flush", () => {
    it("writes nothing until the 250 ms debounce window ends, then upserts every symbol in one statement", async () => {
      await service.recordStockPrices([
        { symbol: "AAPL", price: 190.5, source: "live" },
        { symbol: "MSFT", price: 410.25, source: "frozen" },
      ]);
      expect(database.state.inserts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(249);
      expect(database.state.inserts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(database.state.inserts).toHaveLength(1);
      const [write] = database.state.inserts;
      expect(write).toMatchObject({ table: "last_known_prices", conflictColumn: "symbol", merged: true });
      expect(write!.rows).toEqual([
        { symbol: "AAPL", price: 190.5, as_of: new Date("2026-10-06T15:00:00.250Z"), source: "live" },
        { symbol: "MSFT", price: 410.25, as_of: new Date("2026-10-06T15:00:00.250Z"), source: "frozen" },
      ]);
    });

    it("collapses concurrent callers into one flush and keeps the last price per symbol", async () => {
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await service.recordStockPrices([{ symbol: "AAPL", price: 191, source: "frozen" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(1);
      expect(database.state.inserts[0]!.rows).toMatchObject([{ symbol: "AAPL", price: 191, source: "frozen" }]);
    });

    it("skips zero, negative and NaN prices", async () => {
      await service.recordStockPrices([
        { symbol: "A", price: 0, source: "live" },
        { symbol: "B", price: -1, source: "live" },
        { symbol: "C", price: Number.NaN, source: "live" },
      ]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(database.state.inserts).toHaveLength(0);
    });

    it("does not rewrite an unchanged price, even after the 5 s interval", async () => {
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(database.state.inserts).toHaveLength(1);
    });

    it("rate-limits a changed price to one write per symbol every 5 s", async () => {
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(1);

      // 250 ms after the write: too soon.
      await service.recordStockPrices([{ symbol: "AAPL", price: 191, source: "live" }]);
      await vi.advanceTimersByTimeAsync(1000);
      expect(database.state.inserts).toHaveLength(1);

      // 5 s after the write (written at 250 ms): allowed again.
      await vi.advanceTimersByTimeAsync(4_000);
      await service.recordStockPrices([{ symbol: "AAPL", price: 191, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(2);
      expect(database.state.inserts[1]!.rows).toMatchObject([{ symbol: "AAPL", price: 191 }]);
    });

    it("does not record the throttle time of a failed write, so the same price is retried", async () => {
      database.state.insertImplementation = () => Promise.reject(new Error("deadlock detected"));
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(console.warn).toHaveBeenCalledWith("priceService: could not record prices — deadlock detected");

      database.state.insertImplementation = null;
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(2);
    });

    it("serializes a second burst that arrives during an in-flight flush and flushes it afterwards", async () => {
      let releaseFirstWrite: () => void = () => undefined;
      database.state.insertImplementation = () => new Promise<void>((resolve) => (releaseFirstWrite = resolve));
      await service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }]);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(1);

      // While the first insert is unresolved, a different symbol arrives: no overlapping insert starts.
      await service.recordStockPrices([{ symbol: "MSFT", price: 410, source: "live" }]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(database.state.inserts).toHaveLength(1);

      database.state.insertImplementation = null;
      releaseFirstWrite();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(250);
      expect(database.state.inserts).toHaveLength(2);
      expect(database.state.inserts[1]!.rows).toMatchObject([{ symbol: "MSFT", price: 410 }]);
    });

    it("never throws into the caller when the write fails", async () => {
      database.state.insertImplementation = () => Promise.reject("not an Error");
      await expect(service.recordStockPrices([{ symbol: "AAPL", price: 190, source: "live" }])).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(250);
      expect(console.warn).toHaveBeenCalledWith("priceService: could not record prices — not an Error");
    });
  });

  describe("loadFallbackStockPrices", () => {
    it("returns an empty map and queries nothing for no symbols", async () => {
      expect((await service.loadFallbackStockPrices([])).size).toBe(0);
      expect(database.state.whereInArguments).toHaveLength(0);
      expect(database.state.rawArguments).toHaveLength(0);
    });

    it("de-duplicates the requested symbols", async () => {
      await service.loadFallbackStockPrices(["AAPL", "AAPL", "MSFT"]);
      expect(database.state.whereInArguments[0]).toEqual(["symbol", ["AAPL", "MSFT"]]);
      expect(database.state.rawArguments[0]![1]).toEqual([["AAPL", "MSFT"]]);
    });

    it("returns a persisted known price as a number with its as-of time", async () => {
      database.state.knownRows = [{ symbol: "AAPL", price: "190.25", as_of: "2026-10-05T20:00:00Z", source: "live" }];
      const prices = await service.loadFallbackStockPrices(["AAPL"]);
      expect(prices.get("AAPL")).toEqual({ price: 190.25, asOf: new Date("2026-10-05T20:00:00Z"), source: "known" });
    });

    it("drops a persisted price older than 14 days and keeps one exactly 14 days old", async () => {
      database.state.knownRows = [
        { symbol: "OLD", price: 1, as_of: new Date("2026-10-06T15:00:00Z").getTime() - 14 * 86_400_000 - 1, source: "live" } as never,
        { symbol: "EDGE", price: 2, as_of: new Date(new Date("2026-10-06T15:00:00Z").getTime() - 14 * 86_400_000), source: "live" },
      ];
      const prices = await service.loadFallbackStockPrices(["OLD", "EDGE"]);
      expect(prices.has("OLD")).toBe(false);
      expect(prices.get("EDGE")?.price).toBe(2);
    });

    it("uses a daily bar close as of 21:00 UTC of its session when there is no persisted price", async () => {
      database.state.barRows = [{ symbol: "AAPL", price: "188.1", date: "2026-10-05" }];
      const prices = await service.loadFallbackStockPrices(["AAPL"]);
      expect(prices.get("AAPL")).toEqual({ price: 188.1, asOf: new Date("2026-10-05T21:00:00Z"), source: "bar" });
    });

    it("prefers a bar only when it is strictly newer than the persisted price", async () => {
      database.state.knownRows = [
        { symbol: "NEWERKNOWN", price: 10, as_of: "2026-10-05T22:00:00Z", source: "live" },
        { symbol: "NEWERBAR", price: 20, as_of: "2026-10-05T20:00:00Z", source: "live" },
        { symbol: "TIE", price: 30, as_of: "2026-10-05T21:00:00Z", source: "frozen" },
      ];
      database.state.barRows = [
        { symbol: "NEWERKNOWN", price: 11, date: "2026-10-05" },
        { symbol: "NEWERBAR", price: 21, date: "2026-10-05" },
        { symbol: "TIE", price: 31, date: "2026-10-05" },
      ];
      const prices = await service.loadFallbackStockPrices(["NEWERKNOWN", "NEWERBAR", "TIE"]);
      expect(prices.get("NEWERKNOWN")).toMatchObject({ price: 10, source: "known" });
      expect(prices.get("NEWERBAR")).toMatchObject({ price: 21, source: "bar" });
      expect(prices.get("TIE")).toMatchObject({ price: 30, source: "known" });
    });

    it("lets a fresh bar replace a stale (older than 14 days) persisted price", async () => {
      database.state.knownRows = [{ symbol: "AAPL", price: 1, as_of: "2026-09-01T00:00:00Z", source: "live" }];
      database.state.barRows = [{ symbol: "AAPL", price: 188, date: "2026-10-05" }];
      expect((await service.loadFallbackStockPrices(["AAPL"])).get("AAPL")).toMatchObject({ price: 188, source: "bar" });
    });

    it("omits symbols with no stored price", async () => {
      database.state.knownRows = [{ symbol: "AAPL", price: 190, as_of: "2026-10-05T20:00:00Z", source: "live" }];
      const prices = await service.loadFallbackStockPrices(["AAPL", "ZZZZ"]);
      expect([...prices.keys()]).toEqual(["AAPL"]);
    });

    it("returns an empty map and warns when a query fails", async () => {
      database.state.knownRowsError = new Error("connection refused");
      expect((await service.loadFallbackStockPrices(["AAPL"])).size).toBe(0);
      expect(console.warn).toHaveBeenCalledWith("priceService: could not load fallback prices — connection refused");
    });
  });

  describe("getBestKnownStockPrice", () => {
    it("returns the best stored price for the symbol", async () => {
      database.state.barRows = [{ symbol: "AAPL", price: 188.1, date: "2026-10-05" }];
      expect(await service.getBestKnownStockPrice("AAPL")).toBe(188.1);
    });

    it("returns null when nothing is stored", async () => {
      expect(await service.getBestKnownStockPrice("AAPL")).toBeNull();
    });
  });
});
