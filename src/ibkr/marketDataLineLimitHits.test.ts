import { describe, expect, it, vi } from "vitest";
import { createMarketDataLineLimitHitRecorder, type MarketDataLineLimitHitRecorderDependencies, type MarketDataLineLimitHitRow } from "./marketDataLineLimitHits.js";

vi.mock("../db/connection.js", () => ({ db: {} }));

function recorderWith(overrides: Partial<MarketDataLineLimitHitRecorderDependencies> = {}) {
  const rows: MarketDataLineLimitHitRow[] = [];
  let nowMs = 1_000_000;
  const record = createMarketDataLineLimitHitRecorder({
    processLabel: "web.1",
    tradingMode: "live",
    fetchLiveNetLiquidation: async () => 1_050_000,
    loadReservations: async () => [
      { holder: "marketQuoteLoop", lines: 10, priority: true },
      { holder: "marketDataPool", lines: 70, priority: false },
    ],
    loadBudget: async () => ({ budget: 108, estimatedIbkrCeiling: 118, netLiquidationUsed: 1_182_249 }),
    insertHit: async (row) => {
      rows.push(row);
    },
    now: () => nowMs,
    ...overrides,
  });
  return { record, rows, advanceMinutes: (minutes: number) => (nowMs += minutes * 60_000) };
}

const hit = { requestId: 4711, code: 101, message: "Max number of tickers has been reached" };

describe("createMarketDataLineLimitHitRecorder", () => {
  it("stores the ledger, the budget and the live net liquidation at the refusal", async () => {
    const { record, rows } = recorderWith();
    await record(hit);
    expect(rows).toEqual([
      {
        process: "web.1",
        trading_mode: "live",
        request_id: 4711,
        ibkr_code: 101,
        ibkr_message: "Max number of tickers has been reached",
        budget: 108,
        estimated_ibkr_ceiling: 118,
        ledger_lines_in_use: 80,
        ledger_reservations: JSON.stringify([
          { holder: "marketQuoteLoop", lines: 10, priority: true },
          { holder: "marketDataPool", lines: 70, priority: false },
        ]),
        live_net_liquidation: 1_050_000,
        refusals_not_recorded_before: 0,
      },
    ]);
  });

  it("stores one refusal every 5 minutes and counts the ones in between onto the next", async () => {
    const { record, rows, advanceMinutes } = recorderWith();
    await record(hit);
    advanceMinutes(1);
    await record(hit);
    await record(hit);
    advanceMinutes(3);
    await record(hit);
    expect(rows).toHaveLength(1);
    advanceMinutes(1);
    await record(hit);
    expect(rows.map((row) => row.refusals_not_recorded_before)).toEqual([0, 3]);
  });

  it("records a null net liquidation when IBKR does not answer in time, and still stores the row", async () => {
    vi.useFakeTimers();
    try {
      const { record, rows } = recorderWith({ fetchLiveNetLiquidation: () => new Promise(() => {}) });
      const recording = record(hit);
      await vi.advanceTimersByTimeAsync(3_000);
      await recording;
      expect(rows[0]!.live_net_liquidation).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws when the row cannot be stored", async () => {
    const { record } = recorderWith({
      insertHit: async () => {
        throw new Error("relation does not exist");
      },
    });
    await expect(record(hit)).resolves.toBeUndefined();
  });
});
