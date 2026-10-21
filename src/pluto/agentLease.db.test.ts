import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Knex } from "knex";

// The agent lease's SQL on a private copy of the test tables: take, refuse, renew, take over an expired lease, release, and the
// confirm route's check, including a takeover waiting for a confirm in flight to commit.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { agentLeaseRefusal, releaseAgentLease, renewAgentLease, tryTakeAgentLease } = await import("./agentLease.js");
const testDb: Knex = db;

const firstAgent = "agent.1:first";
const secondAgent = "agent.1:second";

async function leaseRow(): Promise<{ holder: string | null; secondsLeft: number | null; taken_at: Date | null }> {
  const { rows } = await testDb.raw("SELECT holder, EXTRACT(EPOCH FROM lease_until - now())::float AS seconds_left, taken_at FROM pluto_agent_lease WHERE id = 1");
  return { holder: rows[0].holder, secondsLeft: rows[0].seconds_left, taken_at: rows[0].taken_at };
}

async function expireLease(): Promise<void> {
  await testDb("pluto_agent_lease").where({ id: 1 }).update({ lease_until: testDb.raw("now() - interval '1 second'") });
}

beforeAll(async () => {
  await testDb("pluto_agent_lease").insert({ id: 1 });
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

beforeEach(async () => {
  await testDb("pluto_agent_lease").where({ id: 1 }).update({ holder: null, lease_until: null, taken_at: null });
});

describe("tryTakeAgentLease", () => {
  it("takes a free lease for 60 s; a second agent is refused and told who holds it until when", async () => {
    expect(await tryTakeAgentLease(firstAgent)).toEqual({ taken: true, tookOverFrom: null });
    const row = await leaseRow();
    expect(row.holder).toBe(firstAgent);
    expect(row.secondsLeft).toBeGreaterThan(58);
    expect(row.secondsLeft).toBeLessThanOrEqual(60);
    expect(row.taken_at).not.toBeNull();

    const refused = await tryTakeAgentLease(secondAgent);
    expect(refused.taken).toBe(false);
    if (refused.taken) return;
    expect(refused.current.holder).toBe(firstAgent);
    expect(refused.current.leaseUntil.getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect((await leaseRow()).holder).toBe(firstAgent);
  });

  it("lets the holder take its own lease again, keeping when it first took it", async () => {
    await tryTakeAgentLease(firstAgent);
    const takenAt = (await leaseRow()).taken_at;
    expect(await tryTakeAgentLease(firstAgent)).toEqual({ taken: true, tookOverFrom: null });
    expect((await leaseRow()).taken_at).toEqual(takenAt);
  });

  it("takes over a lease its holder stopped renewing, and names the holder it replaced", async () => {
    await tryTakeAgentLease(firstAgent);
    await expireLease();
    expect(await tryTakeAgentLease(secondAgent)).toEqual({ taken: true, tookOverFrom: firstAgent });
    expect((await leaseRow()).holder).toBe(secondAgent);
  });
});

describe("renewAgentLease and releaseAgentLease", () => {
  it("renews only for the holder; an expired lease nobody took is still the holder's", async () => {
    await tryTakeAgentLease(firstAgent);
    expect(await renewAgentLease(secondAgent)).toBe(false);
    await expireLease();
    expect(await renewAgentLease(firstAgent)).toBe(true);
    expect((await leaseRow()).secondsLeft).toBeGreaterThan(58);
  });

  it("answers false to the old holder once another agent took over", async () => {
    await tryTakeAgentLease(firstAgent);
    await expireLease();
    await tryTakeAgentLease(secondAgent);
    expect(await renewAgentLease(firstAgent)).toBe(false);
    expect((await leaseRow()).holder).toBe(secondAgent);
  });

  it("frees the lease for the holder only", async () => {
    await tryTakeAgentLease(firstAgent);
    await releaseAgentLease(secondAgent);
    expect((await leaseRow()).holder).toBe(firstAgent);
    await releaseAgentLease(firstAgent);
    expect(await leaseRow()).toEqual({ holder: null, secondsLeft: null, taken_at: null });
    expect(await tryTakeAgentLease(secondAgent)).toEqual({ taken: true, tookOverFrom: null });
  });
});

describe("agentLeaseRefusal", () => {
  it("passes the holder's request and refuses a request without a holder or from another agent", async () => {
    await tryTakeAgentLease(firstAgent);
    await testDb.transaction(async (transaction) => {
      expect(await agentLeaseRefusal(transaction, firstAgent)).toBeNull();
      expect(await agentLeaseRefusal(transaction, undefined)).toBe("Only the running Pluto agent confirms Pluto's orders.");
      expect(await agentLeaseRefusal(transaction, secondAgent)).toBe("This Pluto agent no longer holds Pluto's lease (another agent took over), so it cannot confirm orders.");
    });
  });

  it("refuses every agent while nobody holds the lease", async () => {
    await testDb.transaction(async (transaction) => {
      expect(await agentLeaseRefusal(transaction, firstAgent)).not.toBeNull();
    });
  });

  it("a takeover waits for a confirm in flight to commit; after it, the old holder is refused", async () => {
    await tryTakeAgentLease(firstAgent);
    await expireLease();

    let confirmCommitted = false;
    let releaseConfirm: () => void = () => {};
    const confirmHolding = new Promise<void>((resolve) => {
      releaseConfirm = resolve;
    });
    let checkedInsideConfirm: string | null = "not checked";
    const confirm = testDb.transaction(async (transaction) => {
      checkedInsideConfirm = await agentLeaseRefusal(transaction, firstAgent);
      await confirmHolding;
      confirmCommitted = true;
    });
    // Let the confirm take its row lock first.
    while (checkedInsideConfirm === "not checked") await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checkedInsideConfirm).toBeNull();

    let takeoverResolvedBeforeCommit = false;
    const takeover = tryTakeAgentLease(secondAgent).then((result) => {
      takeoverResolvedBeforeCommit = !confirmCommitted;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await leaseRow()).holder).toBe(firstAgent);

    releaseConfirm();
    await confirm;
    expect(await takeover).toEqual({ taken: true, tookOverFrom: firstAgent });
    expect(takeoverResolvedBeforeCommit).toBe(false);

    await testDb.transaction(async (transaction) => {
      expect(await agentLeaseRefusal(transaction, firstAgent)).not.toBeNull();
      expect(await agentLeaseRefusal(transaction, secondAgent)).toBeNull();
    });
  });
});
