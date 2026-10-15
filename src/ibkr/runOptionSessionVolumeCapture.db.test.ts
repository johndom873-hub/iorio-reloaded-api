import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import type { IBApi } from "@stoqey/ib";
import type { CapturedOptionQuote, CaptureQuoteWindow, OptionContractRequest } from "./captureOptionQuoteBatch.js";

// The after-close volume capture end to end on a private copy of the test tables, with IBKR replaced by a fake window: what
// it quotes the first night (no IV known: the whole universe), what it stores, how the next day reads it, and that the
// second night quotes only the band from the IVs the first one stored.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("../lib/riskFreeRate.js", () => ({ getRiskFreeRateForJob: async () => 0.04, getRiskFreeRate: async () => 0.04 }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { runOptionSessionVolumeCapture } = await import("./runOptionSessionVolumeCapture.js");
const { loadSessionVolumeByContract, loadLastSeenImpliedVolatilityByContract, saveOptionSessionVolumes } = await import("../lib/optionSessionVolumeStore.js");
const testDb: Knex = db;

const tickerId = randomUUID();
const userId = randomUUID();

beforeAll(async () => {
  await testDb("pluto_settings").insert({ id: 1 });
  await testDb("users").insert({ id: userId, username: "volume-capture", display_name: "Volume Capture", password_hash: "x" });
  await testDb("tickers").insert({ id: tickerId, symbol: "VOL", company_name: "Volume Co" });
  await testDb("shortlist_entries").insert({ ticker_id: tickerId, added_by_user_id: userId, signals_enabled: true, bot_enabled: true });
  await testDb("market_calendar").insert(["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-20"].map((calendar_date) => ({ calendar_date, is_open: true })));
  await testDb("option_chain_params").insert({ ticker_id: tickerId, expirations: ["20261016", "20261120"], fetched_at: new Date("2026-10-14T09:00:00Z") });
  await testDb("option_chain_expiry_strikes").insert([
    { ticker_id: tickerId, expiry: "20261016", strikes: [80, 95, 100, 105, 130], fetched_at: new Date("2026-10-14T09:00:00Z") },
    { ticker_id: tickerId, expiry: "20261120", strikes: [70, 85, 100, 115, 140], fetched_at: new Date("2026-10-14T09:00:00Z") },
  ]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

function fakeDependencies(nowIso: string, quoted: OptionContractRequest[][]) {
  const ib = Object.assign(new EventEmitter(), { reqMarketDataType: vi.fn() }) as unknown as IBApi;
  const window: CaptureQuoteWindow = {
    capture: async (_symbol: string, contracts: OptionContractRequest[]) => {
      quoted.push(contracts);
      return contracts.map((contract): CapturedOptionQuote => ({ ...contract, bid: 1, ask: 1.1, last: null, bidSize: null, askSize: null, impliedVolatility: 0.5, delta: null, gamma: null, vega: null, theta: null, modelOptionPrice: null, underlyingPrice: 100, openInterest: null, volume: contract.strike === 130 ? null : Math.round(contract.strike), receivedAnyTick: true, sawRealTimeTicks: false, sawDelayedTicks: true, errorCode: null }));
    },
    close: () => {},
  } as unknown as CaptureQuoteWindow;
  const released = vi.fn(async () => {});
  return {
    released,
    dependencies: {
      connect: async () => ({ ib, disconnect: () => {} }),
      openQuoteWindow: () => window,
      fetchStockPrices: async () => ({ VOL: 100 }),
      reserveLines: async (wanted: number) => wanted,
      renewLines: async () => {},
      releaseLines: released,
      save: (rows: Parameters<typeof saveOptionSessionVolumes>[0]) => saveOptionSessionVolumes([...rows]),
      now: () => new Date(nowIso),
    },
  };
}

describe("the after-close option volume capture", () => {
  it("the first night quotes the whole universe for the next session and stores every requested contract", async () => {
    const quoted: OptionContractRequest[][] = [];
    const { dependencies, released } = fakeDependencies("2026-10-14T21:30:00Z", quoted);
    const result = await runOptionSessionVolumeCapture(dependencies);
    expect(result).toMatchObject({ sessionDateIso: "2026-10-14", nextSessionIso: "2026-10-15", concurrency: 40 });
    // 16 Oct is 1 DTE and 20 Nov 36 DTE on 15 Oct: 5 strikes × 2 rights each; the fake gives no volume to the $130 Call and Put.
    expect(result.tickers).toEqual([expect.objectContaining({ symbol: "VOL", universe: 20, requested: 20, unknownIv: 20, withVolume: 18, withImpliedVolatility: 20, stockPrice: 100, error: null })]);
    expect(released).toHaveBeenCalled();

    const volumes = (await loadSessionVolumeByContract(tickerId, "2026-10-14"))!;
    expect(volumes.get("2026-10-16|95|P")).toBe(95);
    expect(volumes.has("2026-10-16|130|C")).toBe(false);
    expect(await loadSessionVolumeByContract(tickerId, "2026-10-13")).toBeNull();
    expect((await loadLastSeenImpliedVolatilityByContract(tickerId, "2026-10-15")).get("2026-11-20|85|P")).toBe(0.5);
  });

  it("the next night quotes only the band, from the IVs the first night stored", async () => {
    const quoted: OptionContractRequest[][] = [];
    const { dependencies } = fakeDependencies("2026-10-15T21:30:00Z", quoted);
    const result = await runOptionSessionVolumeCapture(dependencies);
    // For 16 Oct, 16 Oct itself is 0 DTE: only 20 Nov (35 DTE) is left, 10 contracts, all with an IV now.
    const [ticker] = result.tickers;
    expect(ticker).toMatchObject({ universe: 10, unknownIv: 0, error: null });
    expect(ticker!.requested).toBeGreaterThan(0);
    expect(ticker!.requested).toBeLessThan(10);
    // At 35 DTE and 50% IV, at the money (|delta| ~0.5) is outside 0.02–0.45: never quoted.
    expect(quoted.flat().some((contract) => contract.strike === 100)).toBe(false);
  });

  it("a ticker without a stored chain is an error of its own, the others still captured", async () => {
    const otherTickerId = randomUUID();
    await testDb("tickers").insert({ id: otherTickerId, symbol: "NOCH", company_name: "No Chain Co" });
    await testDb("shortlist_entries").insert({ ticker_id: otherTickerId, added_by_user_id: userId, signals_enabled: true, bot_enabled: true });
    const { dependencies } = fakeDependencies("2026-10-16T21:30:00Z", []);
    const result = await runOptionSessionVolumeCapture(dependencies);
    expect(result.tickers.map((ticker) => [ticker.symbol, ticker.error])).toEqual([["NOCH", "no stored option chain"], ["VOL", null]]);
  });
});
