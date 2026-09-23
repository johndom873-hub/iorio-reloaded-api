import { describe, expect, it, vi } from "vitest";

const loadStoredOptionChain = vi.fn();
vi.mock("./fetchOptionChain.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetchOptionChain.js")>()),
  loadStoredOptionChain,
}));

const { ticksOnlyPrepareDependencies } = await import("./runOptionChainCapture.js");

const fakeIb = {} as never;
const ticker = { tickerId: "id-AAA", symbol: "AAA", contractId: 1 };

describe("ticksOnlyPrepareDependencies.refreshStoredOptionChain", () => {
  it("reads structure from the DB (no IBKR call) when fetched today", async () => {
    const strikesByExpiry = new Map([["20261016", [95, 100, 105]]]);
    loadStoredOptionChain.mockResolvedValueOnce({ expirations: ["20261016"], strikesByExpiry, fetchedAt: new Date("2026-09-23T12:00:00Z") });
    const result = await ticksOnlyPrepareDependencies.refreshStoredOptionChain(fakeIb, ticker, "2026-09-23");
    expect(loadStoredOptionChain).toHaveBeenCalledWith("id-AAA");
    expect(result.expirations).toEqual(["20261016"]);
    expect(result.strikesByExpiry).toBe(strikesByExpiry);
    expect(result.timings).toEqual({ optionParamsMs: 0, expiries: [], totalMs: 0 });
  });

  it("fails clearly when nothing has been fetched yet", async () => {
    loadStoredOptionChain.mockResolvedValueOnce({ expirations: [], strikesByExpiry: new Map(), fetchedAt: null });
    await expect(ticksOnlyPrepareDependencies.refreshStoredOptionChain(fakeIb, ticker, "2026-09-23")).rejects.toThrow("no chain structure captured for today yet");
  });

  it("fails clearly when the stored structure is from a previous day (Eastern date, not UTC)", async () => {
    // 2026-09-23T02:00Z is still 2026-09-22 in US Eastern (EDT, UTC-4) — must compare by Eastern date, not raw UTC date.
    loadStoredOptionChain.mockResolvedValueOnce({ expirations: ["20261016"], strikesByExpiry: new Map(), fetchedAt: new Date("2026-09-23T02:00:00Z") });
    await expect(ticksOnlyPrepareDependencies.refreshStoredOptionChain(fakeIb, ticker, "2026-09-23")).rejects.toThrow("no chain structure captured for today yet");
  });
});
