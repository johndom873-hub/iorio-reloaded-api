import { describe, expect, it } from "vitest";
import { nextLadderCycleMemory, type LadderCycleLook, type LadderCycleMemory } from "./ladderCycleMemory.js";

const look = (overrides: Partial<LadderCycleLook> = {}): LadderCycleLook => ({ cycleOpen: true, sharesHeld: 0, sharesAverageCost: null, stockPrice: 50, accountValue: 200_000, todayIso: "2026-10-20", shockPctIfStartingToday: 70, ...overrides });

describe("nextLadderCycleMemory", () => {
  it("while flat records the account value at every look and keeps nothing else", () => {
    const kept: LadderCycleMemory = { startedOn: "2026-09-01", accountValueAtStart: 180_000, peakPrice: 60, shock: 0.7 };
    expect(nextLadderCycleMemory(kept, look({ cycleOpen: false }))).toEqual({ startedOn: null, accountValueAtStart: 200_000, peakPrice: null, shock: null });
  });

  it("starts a cycle at its first open look with the flat account value and today's shock; the peak at the shares' average cost, then the live price", () => {
    const flat = nextLadderCycleMemory(null, look({ cycleOpen: false, accountValue: 190_000 }));
    // Bought 300 shares at $49.80 (average cost) with the stock at $50 at the look: the peak is the higher, $50.
    const started = nextLadderCycleMemory(flat, look({ sharesHeld: 300, sharesAverageCost: 49.8 }));
    expect(started).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 190_000, peakPrice: 50, shock: 0.7 });
    // The next day: the account and the shock setting moved; the start keeps its own. The stock at $55 raises the peak, $52 does not lower it.
    const raised = nextLadderCycleMemory(started, look({ sharesHeld: 300, sharesAverageCost: 49.8, stockPrice: 55, accountValue: 210_000, todayIso: "2026-10-21", shockPctIfStartingToday: 60 }));
    expect(raised).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 190_000, peakPrice: 55, shock: 0.7 });
    expect(nextLadderCycleMemory(raised, look({ sharesHeld: 300, sharesAverageCost: 49.8, stockPrice: 52 })).peakPrice).toBe(55);
  });

  it("a cycle taken over with shares (no memory: cleared by the switch) starts at the switch, its peak at the shares' average cost", () => {
    // 200 shares bought at $62 on average, the stock at $50 at the switch: the peak is $62, so the floor sits below what was paid.
    expect(nextLadderCycleMemory(null, look({ sharesHeld: 200, sharesAverageCost: 62 }))).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 200_000, peakPrice: 62, shock: 0.7 });
  });

  it("a cycle of Puts alone has no peak; the first shares (an assigned Put's strike as their cost) start it", () => {
    const putsOnly = nextLadderCycleMemory(null, look());
    expect(putsOnly).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 200_000, peakPrice: null, shock: 0.7 });
    expect(nextLadderCycleMemory(putsOnly, look({ stockPrice: 58 })).peakPrice).toBeNull();
    // The $48 Put is assigned with the stock at $45: the peak starts at $48.
    expect(nextLadderCycleMemory(putsOnly, look({ sharesHeld: 100, sharesAverageCost: 48, stockPrice: 45, todayIso: "2026-10-23" }))).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 200_000, peakPrice: 48, shock: 0.7 });
  });

  it("keeps the peak once set while the cycle stays open without shares (all called away, Puts still open)", () => {
    const kept: LadderCycleMemory = { startedOn: "2026-10-01", accountValueAtStart: 190_000, peakPrice: 60, shock: 0.7 };
    expect(nextLadderCycleMemory(kept, look({ stockPrice: 63 })).peakPrice).toBe(63);
  });
});
