import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Knex } from "knex";
import { db } from "../db/connection.js";

// Only one Pluto agent process may act at a time. Heroku can start a new agent dyno while the old one is still running (when
// it moves a dyno to a new server), so each process holds the one-row pluto_agent_lease: it takes the lease before doing
// anything at boot, renews it every 15 s and at the start of every round, and gives it up when it stops. A lease left
// unrenewed for 60 s (a crashed, killed or stalled process) is free for the next one (Marcelo, 2026-10-21). Every time is the
// database's clock, so the processes' own clocks never matter.
// A process can lose its lease without knowing it (a stalled event loop, a dropped connection), so the lease alone cannot stop
// two agents acting: the order confirm route refuses a Pluto order unless the request carries the holder's id
// (plutoAgentHolderHeader), read under a row lock inside the confirming transaction (agentLeaseRefusal). A takeover waits for
// a confirm in flight to commit, and every later confirm from the old holder is refused.

export const agentLeaseDurationMs = 60_000;
export const agentLeaseRenewIntervalMs = 15_000;
export const agentLeaseRetryIntervalMs = 5_000;
/** Sent by the agent on every API request. */
export const plutoAgentHolderHeader = "X-Pluto-Agent-Holder";

export interface AgentLeaseHolder {
  holder: string;
  leaseUntil: Date;
}

export type AgentLeaseTakeResult = { taken: true; tookOverFrom: string | null } | { taken: false; current: AgentLeaseHolder };

/** "agent.1:6f1c…": the dyno (or host) for people reading it, then a random id, so a restarted process on the same dyno is a new holder. */
export function newAgentHolderId(): string {
  return `${process.env.DYNO ?? hostname()}:${randomUUID()}`;
}

function leaseUntilFromNow(connection: Knex): Knex.Raw {
  return connection.raw("now() + make_interval(secs => ?)", [agentLeaseDurationMs / 1000]);
}

/** Takes the lease when it is free, expired or already this holder's; otherwise answers who holds it. tookOverFrom names an expired holder replaced. */
export async function tryTakeAgentLease(holderId: string, connection: Knex = db): Promise<AgentLeaseTakeResult> {
  return connection.transaction(async (transaction) => {
    const { rows } = await transaction.raw("SELECT holder, lease_until, COALESCE(lease_until < now(), true) AS expired FROM pluto_agent_lease WHERE id = 1 FOR UPDATE");
    const row = rows[0] as { holder: string | null; lease_until: Date | null; expired: boolean } | undefined;
    if (!row) throw new Error("No pluto_agent_lease row found.");
    if (row.holder !== null && row.holder !== holderId && !row.expired) return { taken: false, current: { holder: row.holder, leaseUntil: new Date(row.lease_until!) } };
    const newHolder = row.holder !== holderId;
    await transaction("pluto_agent_lease")
      .where({ id: 1 })
      .update({ holder: holderId, lease_until: leaseUntilFromNow(transaction), ...(newHolder ? { taken_at: transaction.fn.now() } : {}) });
    return { taken: true, tookOverFrom: newHolder ? row.holder : null };
  });
}

/** Extends this holder's lease by 60 s; false once another holder has it. An expired lease nobody took is still this holder's. */
export async function renewAgentLease(holderId: string, connection: Knex = db): Promise<boolean> {
  const rows = await connection("pluto_agent_lease").where({ id: 1, holder: holderId }).update({ lease_until: leaseUntilFromNow(connection) }).returning("id");
  return rows.length > 0;
}

/** Frees the lease for the next agent; does nothing once another holder has it. */
export async function releaseAgentLease(holderId: string, connection: Knex = db): Promise<void> {
  await connection("pluto_agent_lease").where({ id: 1, holder: holderId }).update({ holder: null, lease_until: null, taken_at: null });
}

/**
 * The confirm route's check on a Pluto order, inside its transaction: null when the request comes from the lease's holder.
 * FOR SHARE keeps the row until the confirm commits, so a takeover waits for it instead of slipping in between.
 */
export async function agentLeaseRefusal(transaction: Knex.Transaction, requestHolderId: string | undefined): Promise<string | null> {
  const { rows } = await transaction.raw("SELECT holder FROM pluto_agent_lease WHERE id = 1 FOR SHARE");
  const holder = (rows[0] as { holder: string | null } | undefined)?.holder ?? null;
  if (!requestHolderId) return "Only the running Pluto agent confirms Pluto's orders.";
  if (holder !== requestHolderId) return "This Pluto agent no longer holds Pluto's lease (another agent took over), so it cannot confirm orders.";
  return null;
}

export interface AgentLeaseStore {
  tryTake(holderId: string): Promise<AgentLeaseTakeResult>;
  renew(holderId: string): Promise<boolean>;
  release(holderId: string): Promise<void>;
}

const databaseAgentLeaseStore: AgentLeaseStore = { tryTake: (holderId) => tryTakeAgentLease(holderId), renew: (holderId) => renewAgentLease(holderId), release: (holderId) => releaseAgentLease(holderId) };

export interface AgentLeaseTaken {
  /** How long this process waited for another agent's lease; 0 when it was free at the first try. */
  waitedMs: number;
  /** The expired holder this process replaced (a crashed, killed or stalled agent), else null. */
  tookOverFrom: string | null;
}

type RenewalOutcome = "held" | "lost" | "unknown";

/** One agent process's lease: waits for it at boot, keeps it renewed while the agent runs, gives it up at shutdown. */
export class PlutoAgentLease {
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private renewalInFlight: Promise<RenewalOutcome> | null = null;
  private lost = false;
  private onLost: (() => void) | null = null;
  private waitCancelled = false;
  private wakeWait: (() => void) | null = null;

  constructor(
    readonly holderId: string = newAgentHolderId(),
    private readonly store: AgentLeaseStore = databaseAgentLeaseStore,
  ) {}

  /** Resolves once this process holds the lease, trying every 5 s; null when cancelWait() ends the wait first. onWaiting runs once per holder seen. */
  async waitUntilTaken(onWaiting: (current: AgentLeaseHolder) => void): Promise<AgentLeaseTaken | null> {
    const startedAtMs = Date.now();
    let lastHolderSeen: string | null = null;
    for (let attempt = 0; !this.waitCancelled; attempt += 1) {
      try {
        const result = await this.store.tryTake(this.holderId);
        if (result.taken) {
          if (!this.waitCancelled) return { waitedMs: attempt === 0 ? 0 : Date.now() - startedAtMs, tookOverFrom: result.tookOverFrom };
          await this.store.release(this.holderId).catch(() => {});
          return null;
        }
        if (result.current.holder !== lastHolderSeen) {
          lastHolderSeen = result.current.holder;
          onWaiting(result.current);
        }
      } catch (error) {
        console.warn(`Pluto agent lease: could not take the lease — ${error instanceof Error ? error.message : error}`);
      }
      if (this.waitCancelled) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, agentLeaseRetryIntervalMs);
        this.wakeWait = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeWait = null;
    }
    return null;
  }

  /** Ends a wait in progress: a shutdown before the lease was taken. */
  cancelWait(): void {
    this.waitCancelled = true;
    this.wakeWait?.();
  }

  /** Renews every 15 s. onLost runs once, when another agent holds the lease; a renewal that fails (database unreachable) is not a loss. */
  startRenewing(onLost: () => void): void {
    this.onLost = onLost;
    this.renewTimer = setInterval(() => void this.renew(), agentLeaseRenewIntervalMs);
  }

  /** The check at the start of every round: renews now, true only when the renewal went through. */
  async confirmHeld(): Promise<boolean> {
    return (await this.renew()) === "held";
  }

  /** Gives the lease up for the next agent; a no-op once another holder has it. */
  async release(): Promise<void> {
    this.stopRenewing();
    await this.store.release(this.holderId);
  }

  private stopRenewing(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = null;
  }

  /** One renewal at a time: the 15 s tick and a round's check share one in flight. */
  private renew(): Promise<RenewalOutcome> {
    if (this.lost) return Promise.resolve("lost");
    this.renewalInFlight ??= this.renewOnce().finally(() => {
      this.renewalInFlight = null;
    });
    return this.renewalInFlight;
  }

  private async renewOnce(): Promise<RenewalOutcome> {
    try {
      if (await this.store.renew(this.holderId)) return "held";
    } catch (error) {
      console.warn(`Pluto agent lease: renewal failed — ${error instanceof Error ? error.message : error}`);
      return "unknown";
    }
    this.lost = true;
    this.stopRenewing();
    this.onLost?.();
    return "lost";
  }
}
