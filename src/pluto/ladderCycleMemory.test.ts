import { describe, expect, it } from "vitest";
import { nextLadderCycleMemory, type LadderCycleLook, type LadderCycleMemory } from "./ladderCycleMemory.js";

const look = (overrides: Partial<LadderCycleLook> = {}): LadderCycleLook => ({ cycleOpen: true, sharesHeld: true, accountValue: 200_000, todayIso: "2026-10-20", shockPctIfStartingToday: 70, ...overrides });

describe("nextLadderCycleMemory", () => {
  it("while flat records the account value at every look and keeps nothing else", () => {
    const kept: LadderCycleMemory = { startedOn: "2026-09-01", accountValueAtStart: 180_000, shock: 0.7 };
    expect(nextLadderCycleMemory(kept, look({ cycleOpen: false }))).toEqual({ startedOn: null, accountValueAtStart: 200_000, shock: null });
  });

  it("starts a cycle at its first open look with the last flat account value and today's shock, then keeps both", () => {
    const flat = nextLadderCycleMemory(null, look({ cycleOpen: false, accountValue: 190_000 }));
    const started = nextLadderCycleMemory(flat, look());
    expect(started).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 190_000, shock: 0.7 });
    // The next day the account and the shock setting moved; the cycle keeps its own start.
    expect(nextLadderCycleMemory(started, look({ accountValue: 210_000, todayIso: "2026-10-21", shockPctIfStartingToday: 60 }))).toEqual(started);
  });

  it("a cycle of Puts only (an entry Put not yet assigned) keeps recording the account value; it starts once shares are held", () => {
    const putsOnly = nextLadderCycleMemory(null, look({ sharesHeld: false, accountValue: 195_000 }));
    expect(putsOnly).toEqual({ startedOn: null, accountValueAtStart: 195_000, shock: null });
    expect(nextLadderCycleMemory(putsOnly, look({ todayIso: "2026-10-23", accountValue: 198_000 }))).toEqual({ startedOn: "2026-10-23", accountValueAtStart: 195_000, shock: 0.7 });
    // A started cycle whose shares were called away with a ladder Put still open keeps its start.
    const started: LadderCycleMemory = { startedOn: "2026-10-01", accountValueAtStart: 180_000, shock: 0.6 };
    expect(nextLadderCycleMemory(started, look({ sharesHeld: false }))).toEqual(started);
  });

  it("a cycle taken over at the switch (no memory: cleared by the switch) starts there, with the account value of the switch", () => {
    expect(nextLadderCycleMemory(null, look())).toEqual({ startedOn: "2026-10-20", accountValueAtStart: 200_000, shock: 0.7 });
  });
});
