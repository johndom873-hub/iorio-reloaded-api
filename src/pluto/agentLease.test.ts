import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlutoAgentLease, type AgentLeaseStore, type AgentLeaseTakeResult } from "./agentLease.js";

// PlutoAgentLease's timing on a scripted store: the 5 s retries while another agent holds the lease, the 15 s renewals, a loss
// to another holder (stop once) versus a renewal that cannot reach the database (keep going), and a shutdown during the wait.

vi.mock("../db/connection.js", () => ({ db: {} }));

function scriptedStore(takeResults: (AgentLeaseTakeResult | Error)[], renewResults: (boolean | Error)[] = []) {
  const calls = { tryTake: 0, renew: 0, release: 0 };
  const store: AgentLeaseStore = {
    tryTake: async () => {
      calls.tryTake += 1;
      const next = takeResults.length > 1 ? takeResults.shift()! : takeResults[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    renew: async () => {
      calls.renew += 1;
      const next = renewResults.length > 1 ? renewResults.shift()! : (renewResults[0] ?? true);
      if (next instanceof Error) throw next;
      return next;
    },
    release: async () => {
      calls.release += 1;
    },
  };
  return { store, calls };
}

const heldBy = (holder: string): AgentLeaseTakeResult => ({ taken: false, current: { holder, leaseUntil: new Date("2026-10-21T09:37:00Z") } });
const takenFree: AgentLeaseTakeResult = { taken: true, tookOverFrom: null };

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-21T09:36:40Z") });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PlutoAgentLease.waitUntilTaken", () => {
  it("takes a free lease at once: no wait, nobody announced", async () => {
    const { store } = scriptedStore([takenFree]);
    const onWaiting = vi.fn();
    expect(await new PlutoAgentLease("me", store).waitUntilTaken(onWaiting)).toEqual({ waitedMs: 0, tookOverFrom: null });
    expect(onWaiting).not.toHaveBeenCalled();
  });

  it("while another agent holds it, tries every 5 s, announces that holder once, and reports the wait", async () => {
    const { store, calls } = scriptedStore([heldBy("agent.1:old"), heldBy("agent.1:old"), heldBy("agent.1:old"), takenFree]);
    const onWaiting = vi.fn();
    const waiting = new PlutoAgentLease("me", store).waitUntilTaken(onWaiting);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.tryTake).toBe(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls.tryTake).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.tryTake).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toEqual({ waitedMs: 15_000, tookOverFrom: null });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    expect(onWaiting.mock.calls[0]![0].holder).toBe("agent.1:old");
  });

  it("announces each new holder it sees, and names the expired holder it took over from", async () => {
    const { store } = scriptedStore([heldBy("agent.1:old"), heldBy("agent.1:newer"), { taken: true, tookOverFrom: "agent.1:newer" }]);
    const onWaiting = vi.fn();
    const waiting = new PlutoAgentLease("me", store).waitUntilTaken(onWaiting);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await waiting).toEqual({ waitedMs: 10_000, tookOverFrom: "agent.1:newer" });
    expect(onWaiting.mock.calls.map((call) => call[0].holder)).toEqual(["agent.1:old", "agent.1:newer"]);
  });

  it("keeps trying when the database cannot be reached", async () => {
    const { store, calls } = scriptedStore([new Error("connection refused"), takenFree]);
    const waiting = new PlutoAgentLease("me", store).waitUntilTaken(() => {});
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await waiting).toEqual({ waitedMs: 5_000, tookOverFrom: null });
    expect(calls.tryTake).toBe(2);
  });

  it("a shutdown during the wait ends it at once with null, and tries no more", async () => {
    const { store, calls } = scriptedStore([heldBy("agent.1:old")]);
    const lease = new PlutoAgentLease("me", store);
    const waiting = lease.waitUntilTaken(() => {});
    await vi.advanceTimersByTimeAsync(2_000);
    lease.cancelWait();
    expect(await waiting).toBeNull();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls.tryTake).toBe(1);
  });

  it("a lease taken just as the shutdown came is given back, and the wait answers null", async () => {
    let finishTake: (result: AgentLeaseTakeResult) => void = () => {};
    const calls = { release: 0 };
    const store: AgentLeaseStore = {
      tryTake: () => new Promise((resolve) => (finishTake = resolve)),
      renew: async () => true,
      release: async () => {
        calls.release += 1;
      },
    };
    const lease = new PlutoAgentLease("me", store);
    const waiting = lease.waitUntilTaken(() => {});
    lease.cancelWait();
    finishTake(takenFree);
    expect(await waiting).toBeNull();
    expect(calls.release).toBe(1);
  });
});

describe("PlutoAgentLease renewals", () => {
  it("renews every 15 s while it holds the lease", async () => {
    const { store, calls } = scriptedStore([takenFree], [true]);
    const lease = new PlutoAgentLease("me", store);
    lease.startRenewing(() => {});
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls.renew).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.renew).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(calls.renew).toBe(4);
    await lease.release();
  });

  it("losing the lease to another agent calls onLost once and stops renewing; every later round check is false", async () => {
    const { store, calls } = scriptedStore([takenFree], [true, false]);
    const lease = new PlutoAgentLease("me", store);
    const onLost = vi.fn();
    lease.startRenewing(onLost);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(calls.renew).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.renew).toBe(2);
    expect(await lease.confirmHeld()).toBe(false);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("a renewal that cannot reach the database is no loss: that round is skipped, the next renewal holds again", async () => {
    const { store } = scriptedStore([takenFree], [new Error("connection terminated"), true]);
    const lease = new PlutoAgentLease("me", store);
    const onLost = vi.fn();
    lease.startRenewing(onLost);
    expect(await lease.confirmHeld()).toBe(false);
    expect(await lease.confirmHeld()).toBe(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onLost).not.toHaveBeenCalled();
    await lease.release();
  });

  it("a round check and the 15 s tick at the same moment share one renewal", async () => {
    let finishRenewal: (held: boolean) => void = () => {};
    const calls = { renew: 0 };
    const store: AgentLeaseStore = {
      tryTake: async () => takenFree,
      renew: () => {
        calls.renew += 1;
        return new Promise((resolve) => (finishRenewal = resolve));
      },
      release: async () => {},
    };
    const lease = new PlutoAgentLease("me", store);
    lease.startRenewing(() => {});
    await vi.advanceTimersByTimeAsync(15_000);
    const roundCheck = lease.confirmHeld();
    expect(calls.renew).toBe(1);
    finishRenewal(true);
    expect(await roundCheck).toBe(true);
    await lease.release();
  });

  it("release stops the renewals and frees the lease", async () => {
    const { store, calls } = scriptedStore([takenFree], [true]);
    const lease = new PlutoAgentLease("me", store);
    lease.startRenewing(() => {});
    await lease.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls.renew).toBe(0);
    expect(calls.release).toBe(1);
  });
});
