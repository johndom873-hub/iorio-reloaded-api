import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): free cash from a summary already read (Pluto) and the injectable summary fetch.

const harness = vi.hoisted(() => ({ cashLockedInCsps: 0, defaultFetches: 0 }));

vi.mock("../db/connection.js", () => ({ db: Object.assign(() => ({}), { raw: () => "" }) }));
vi.mock("./positionExposure.js", () => ({ computeCashLockedInCsps: async () => harness.cashLockedInCsps }));
vi.mock("../ibkr/fetchAccountSummary.js", () => ({
  fetchAccountSummary: async () => {
    harness.defaultFetches += 1;
    return { netLiquidationValue: 1, totalCashValue: 50_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null };
  },
}));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(), notifyPlutoTelegram: vi.fn() }));

const { accountContextFromTotalCash, loadAccountContext } = await import("./signalsStore.js");

beforeEach(() => {
  harness.cashLockedInCsps = 0;
  harness.defaultFetches = 0;
});

describe("accountContextFromTotalCash (audit A)", () => {
  it("is total cash minus cash locked in CSPs", async () => {
    harness.cashLockedInCsps = 30_000;
    expect(await accountContextFromTotalCash(100_000)).toEqual({ freeCash: 70_000 });
  });

  it("never goes negative, and treats unknown cash as none", async () => {
    harness.cashLockedInCsps = 30_000;
    expect(await accountContextFromTotalCash(10_000)).toEqual({ freeCash: 0 });
    expect(await accountContextFromTotalCash(null)).toEqual({ freeCash: 0 });
    harness.cashLockedInCsps = 0;
    expect(await accountContextFromTotalCash(-5_000)).toEqual({ freeCash: 0 });
  });
});

describe("loadAccountContext (audit A)", () => {
  it("uses the injected summary fetch instead of IBKR's", async () => {
    harness.cashLockedInCsps = 10_000;
    const fetchSummary = vi.fn(async () => ({ netLiquidationValue: 1, totalCashValue: 25_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null }));
    expect(await loadAccountContext(fetchSummary)).toEqual({ freeCash: 15_000 });
    expect(harness.defaultFetches).toBe(0);
  });

  it("defaults to the live fetch when called with no argument (every existing caller)", async () => {
    expect(await loadAccountContext()).toEqual({ freeCash: 50_000 });
    expect(harness.defaultFetches).toBe(1);
  });
});
