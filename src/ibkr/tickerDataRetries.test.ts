import { describe, expect, it, vi } from "vitest";
import { IbkrLookupTimeoutError } from "./fetchOptionChain.js";
import {
  describeTickerDataGaveUp,
  describeTickerDataRetryPass,
  isIbkrTimeoutError,
  isWithinTickerDataRetryWindow,
  runTickerDataRetryPass,
  type TickerDataKind,
  type TickerDataNeed,
  type TickerDataRetryDependencies,
  type TickerDataRetryRow,
} from "./tickerDataRetries.js";

const need = (symbol: string) => ({ tickerId: `id-${symbol}`, symbol, contractId: 1 });

/** An in-memory retry table, with the pass's IBKR work recorded in order. */
function fakeDependencies(overrides: Partial<TickerDataRetryDependencies> & { startingAttempts?: Record<string, number> } = {}) {
  const rows = new Map<string, TickerDataRetryRow>();
  const tried: string[] = [];
  const alerts: string[] = [];
  const disconnect = vi.fn();
  const dependencies: TickerDataRetryDependencies = {
    now: () => new Date("2026-11-09T15:00:00Z"),
    isMarketClosedToday: async () => false,
    isStructureJobRunning: async () => false,
    loadPlutoTickerIds: async () => new Set(),
    loadOptionChainNeeds: async () => [],
    loadDailyBarsHistoryNeeds: async () => [],
    ensureRows: async (needs: TickerDataNeed[]) => {
      for (const entry of needs) {
        const key = `${entry.tickerId}:${entry.kind}`;
        if (!rows.has(key)) rows.set(key, { tickerId: entry.tickerId, kind: entry.kind, attempts: overrides.startingAttempts?.[key] ?? 0, lastError: null, lastAttemptAt: null, succeededAt: null, gaveUpAt: null });
      }
    },
    loadRows: async () => [...rows.values()],
    recordSuccess: async (tickerId: string, kind: TickerDataKind) => {
      const row = rows.get(`${tickerId}:${kind}`)!;
      row.attempts++;
      row.succeededAt = new Date();
    },
    recordFailure: async (tickerId: string, kind: TickerDataKind, _date: string, message: string) => {
      const row = rows.get(`${tickerId}:${kind}`)!;
      row.attempts++;
      row.lastError = message;
      const gaveUpNow = row.gaveUpAt === null && row.attempts >= 3;
      if (gaveUpNow) row.gaveUpAt = new Date();
      return { attempts: row.attempts, gaveUpNow };
    },
    loadSpotPrices: async () => new Map(),
    connect: async () => ({ ib: {} as never, disconnect }),
    refreshOptionChain: async (_connection, entry) => {
      tried.push(`${entry.symbol} chain`);
    },
    fetchDailyBarsHistory: async (_connection, entry) => {
      tried.push(`${entry.symbol} history`);
    },
    alert: async (message) => {
      alerts.push(message);
    },
    ...overrides,
  };
  return { dependencies, rows, tried, alerts, disconnect };
}

describe("isWithinTickerDataRetryWindow", () => {
  it("runs from 09:10 UTC to the 16:00 ET close", () => {
    expect(isWithinTickerDataRetryWindow(new Date("2026-11-09T09:05:00Z"))).toBe(false);
    expect(isWithinTickerDataRetryWindow(new Date("2026-11-09T09:10:00Z"))).toBe(true);
    expect(isWithinTickerDataRetryWindow(new Date("2026-11-09T20:59:00Z"))).toBe(true); // 15:59 ET (winter)
    expect(isWithinTickerDataRetryWindow(new Date("2026-11-09T21:00:00Z"))).toBe(false); // 16:00 ET
    expect(isWithinTickerDataRetryWindow(new Date("2026-07-09T20:30:00Z"))).toBe(false); // 16:30 ET (summer)
    expect(isWithinTickerDataRetryWindow(new Date("2026-11-10T02:00:00Z"))).toBe(false); // 21:00 ET the evening before
  });
});

describe("isIbkrTimeoutError", () => {
  it("knows the strike lookup, the expiry list, historical data and the connection timing out", () => {
    expect(isIbkrTimeoutError(new IbkrLookupTimeoutError("strike grid lookup for TLT 20261204 timed out after 30s"))).toBe(true);
    expect(isIbkrTimeoutError(new Error("Historical data timeout for AMD"))).toBe(true);
    expect(isIbkrTimeoutError(new Error("Timed out connecting to IBKR Gateway."))).toBe(true);
    expect(isIbkrTimeoutError(new Error("IBKR returned no option expirations"))).toBe(false);
  });
});

describe("runTickerDataRetryPass", () => {
  it("does nothing outside the window, on a closed day, or while the morning job runs", async () => {
    expect(await runTickerDataRetryPass(fakeDependencies({ now: () => new Date("2026-11-09T09:05:00Z") }).dependencies)).toEqual({ ran: false, reason: "outside_window" });
    expect(await runTickerDataRetryPass(fakeDependencies({ isMarketClosedToday: async () => true }).dependencies)).toEqual({ ran: false, reason: "market_closed" });
    expect(await runTickerDataRetryPass(fakeDependencies({ isStructureJobRunning: async () => true }).dependencies)).toEqual({ ran: false, reason: "structure_job_running" });
  });

  it("does not connect when nothing is missing", async () => {
    const connect = vi.fn();
    expect(await runTickerDataRetryPass(fakeDependencies({ connect }).dependencies)).toEqual({ ran: false, reason: "nothing_due" });
    expect(connect).not.toHaveBeenCalled();
  });

  it("tries the missing chains, Pluto's first, then the missing histories, and disconnects", async () => {
    const fake = fakeDependencies({
      loadPlutoTickerIds: async () => new Set(["id-SPCX"]),
      loadOptionChainNeeds: async () => [need("TLT"), need("SPCX"), need("XLE")],
      loadDailyBarsHistoryNeeds: async () => [need("XLE")],
    });
    const result = await runTickerDataRetryPass(fake.dependencies);
    expect(fake.tried).toEqual(["SPCX chain", "TLT chain", "XLE chain", "XLE history"]);
    expect(result).toMatchObject({ ran: true, stoppedAfterTimeout: null, notTried: [] });
    expect([...fake.rows.values()].every((row) => row.succeededAt !== null && row.attempts === 1)).toBe(true);
    expect(fake.disconnect).toHaveBeenCalledTimes(1);
  });

  it("stops at an IBKR timeout, counting the try, and leaves the rest for the next pass", async () => {
    const fake = fakeDependencies({
      loadOptionChainNeeds: async () => [need("KORU"), need("TLT"), need("XLE")],
      refreshOptionChain: async (_connection, entry) => {
        fake.tried.push(`${entry.symbol} chain`);
        if (entry.symbol === "TLT") throw new IbkrLookupTimeoutError("strike grid lookup for TLT 20261204 timed out after 30s");
      },
    });
    const result = await runTickerDataRetryPass(fake.dependencies);
    expect(fake.tried).toEqual(["KORU chain", "TLT chain"]);
    expect(result).toMatchObject({ ran: true, stoppedAfterTimeout: "TLT", notTried: ["XLE option chain"] });
    expect(fake.rows.get("id-TLT:option_chain")).toMatchObject({ attempts: 1, lastError: "strike grid lookup for TLT 20261204 timed out after 30s", gaveUpAt: null });
    expect(fake.rows.get("id-XLE:option_chain")).toMatchObject({ attempts: 0 });
    expect(fake.alerts).toEqual([]);
  });

  it("goes on after an error that is not a timeout", async () => {
    const fake = fakeDependencies({
      loadOptionChainNeeds: async () => [need("AAA"), need("BBB")],
      refreshOptionChain: async (_connection, entry) => {
        fake.tried.push(`${entry.symbol} chain`);
        if (entry.symbol === "AAA") throw new Error("IBKR returned no option expirations");
      },
    });
    await runTickerDataRetryPass(fake.dependencies);
    expect(fake.tried).toEqual(["AAA chain", "BBB chain"]);
  });

  it("gives up on the third failed try with one alert, and never tries that ticker again today", async () => {
    const fake = fakeDependencies({
      startingAttempts: { "id-TLT:option_chain": 2 },
      loadOptionChainNeeds: async () => [need("TLT")],
      refreshOptionChain: async (_connection, entry) => {
        fake.tried.push(`${entry.symbol} chain`);
        throw new IbkrLookupTimeoutError("strike grid lookup for TLT 20261204 timed out after 30s");
      },
    });
    const result = await runTickerDataRetryPass(fake.dependencies);
    expect(result).toMatchObject({ ran: true, outcomes: [{ attempt: 3, result: "failed", gaveUp: true }] });
    expect(fake.alerts).toEqual([describeTickerDataGaveUp("TLT", "option_chain", "strike grid lookup for TLT 20261204 timed out after 30s")]);
    expect(await runTickerDataRetryPass(fake.dependencies)).toEqual({ ran: false, reason: "nothing_due" });
    expect(fake.tried).toEqual(["TLT chain"]);
  });

  it("costs no ticker a try when the connection fails", async () => {
    const fake = fakeDependencies({
      loadOptionChainNeeds: async () => [need("TLT")],
      connect: async () => {
        throw new Error("Timed out connecting to IBKR Gateway.");
      },
    });
    expect(await runTickerDataRetryPass(fake.dependencies)).toEqual({ ran: false, reason: "connect_failed", message: "Timed out connecting to IBKR Gateway." });
    expect(fake.rows.get("id-TLT:option_chain")).toMatchObject({ attempts: 0 });
  });
});

describe("the texts", () => {
  it("names the ticker, what is missing, the last error and the Shortlist action", () => {
    expect(describeTickerDataGaveUp("XLE", "daily_bars_history", "Historical data timeout for XLE")).toBe(
      "⚠️ XLE: the daily history back to 2006 is still missing after 3 tries today (Historical data timeout for XLE). Shortlist → XLE → Actions → Populate Daily Bars.",
    );
  });

  it("logs each try and where the pass stopped", () => {
    const tlt = { ...need("TLT"), kind: "option_chain" as const };
    const xle = { ...need("XLE"), kind: "daily_bars_history" as const };
    expect(
      describeTickerDataRetryPass({ ran: true, outcomes: [{ need: xle, attempt: 1, result: "done" }, { need: tlt, attempt: 2, result: "failed", message: "timed out", gaveUp: false }], stoppedAfterTimeout: "TLT", notTried: ["KORU option chain"] }),
    ).toBe("Ticker data retry: XLE daily history back to 2006 (try 1 of 3): done; TLT option chain (try 2 of 3): failed — timed out; stopped after TLT's IBKR timeout; next pass in 10 minutes (not tried: KORU option chain).");
    expect(describeTickerDataRetryPass({ ran: false, reason: "nothing_due" })).toBeNull();
  });
});
