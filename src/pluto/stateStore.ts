import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { isoDateFromDbDate } from "../lib/dbDate.js";
import type { PlutoReadinessRecord } from "./readiness.js";

// Pluto's runtime state: one row (pluto_state). Mode is off/on (Marcelo, 2026-09-28: no
// other modes). Pause is a separate flag that overrides everything: manual (either user),
// after a deploy or a crash loop (the agent itself on boot), or a tripped breaker. A
// breaker trip always needs a human reset; a manual/deploy/crash-loop pause is lifted by
// Resume. The order gate is: mode on AND not paused AND no breaker tripped.

export type PlutoMode = "off" | "on";
export type PlutoPauseKind = "manual" | "deploy" | "crash_loop" | "readiness" | "breaker";

export interface PlutoBreakerTrip {
  trippedAt: string;
  detail: string;
}

export interface PlutoState {
  mode: PlutoMode;
  paused: boolean;
  /** "manual" | "deploy" | "crash_loop" | "readiness" | "breaker:<name>" */
  pauseReason: string | null;
  pausedByUserId: string | null;
  pausedByDisplayName: string | null;
  pausedAt: string | null;
  lastSeenRelease: string | null;
  breakers: Record<string, PlutoBreakerTrip>;
  lastPassAt: string | null;
  /** Eastern date on which the SPY stress check is overridden (screen switch), else null. */
  stressOverrideDate: string | null;
  stressOverrideByDisplayName: string | null;
  /** The latest pre-open readiness run (readiness.ts); null until the first one. */
  readiness: PlutoReadinessRecord | null;
  updatedAt: string;
}

function rowToState(row: Record<string, unknown>): PlutoState {
  return {
    mode: row.mode as PlutoMode,
    paused: Boolean(row.paused),
    pauseReason: (row.pause_reason as string | null) ?? null,
    pausedByUserId: (row.paused_by_user_id as string | null) ?? null,
    pausedByDisplayName: (row.paused_by_display_name as string | null) ?? null,
    pausedAt: row.paused_at ? new Date(row.paused_at as string).toISOString() : null,
    lastSeenRelease: (row.last_seen_release as string | null) ?? null,
    breakers: (row.breakers as Record<string, PlutoBreakerTrip>) ?? {},
    lastPassAt: row.last_pass_at ? new Date(row.last_pass_at as string).toISOString() : null,
    stressOverrideDate: isoDateFromDbDate(row.stress_override_date),
    stressOverrideByDisplayName: (row.stress_override_by_display_name as string | null) ?? null,
    readiness: (row.readiness as PlutoReadinessRecord | null) ?? null,
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function loadPlutoState(connection: Knex = db): Promise<PlutoState> {
  const row = await connection("pluto_state as s")
    .leftJoin("users as u", "u.id", "s.paused_by_user_id")
    .leftJoin("users as su", "su.id", "s.stress_override_by_user_id")
    .where("s.id", 1)
    .select("s.*", "u.display_name as paused_by_display_name", "su.display_name as stress_override_by_display_name")
    .first();
  if (!row) throw new Error("No pluto_state row found.");
  return rowToState(row);
}

/** Pure: may Pluto act right now? The single answer every gate and the screen agree on. */
export function describePlutoBlock(state: PlutoState): string | null {
  if (state.mode !== "on") return "Pluto is off.";
  const tripped = Object.entries(state.breakers);
  if (tripped.length > 0) return `Circuit breaker tripped: ${tripped.map(([name, trip]) => `${name} (${trip.detail})`).join("; ")}. Needs a human reset.`;
  if (state.paused) return `Pluto is paused (${state.pauseReason ?? "manual"}${state.pausedByDisplayName ? ` by ${state.pausedByDisplayName}` : ""}).`;
  return null;
}

/** Same-day override of the SPY stress check; `dateIso` null clears it. */
export async function setPlutoStressOverride(dateIso: string | null, userId: string | null): Promise<PlutoState> {
  await db("pluto_state").where({ id: 1 }).update({ stress_override_date: dateIso, stress_override_by_user_id: dateIso ? userId : null, updated_at: db.fn.now() });
  return loadPlutoState();
}

export async function setPlutoMode(mode: PlutoMode): Promise<PlutoState> {
  await db("pluto_state").where({ id: 1 }).update({ mode, updated_at: db.fn.now() });
  return loadPlutoState();
}

export async function pausePluto(kind: PlutoPauseKind, options: { userId?: string; breakerName?: string } = {}): Promise<PlutoState> {
  const reason = kind === "breaker" ? `breaker:${options.breakerName ?? "unknown"}` : kind;
  await db("pluto_state").where({ id: 1 }).update({ paused: true, pause_reason: reason, paused_by_user_id: options.userId ?? null, paused_at: db.fn.now(), updated_at: db.fn.now() });
  return loadPlutoState();
}

/** Lifts a manual / deploy / crash-loop / readiness pause. Refuses while a breaker is tripped: reset the breaker first. */
export async function resumePluto(userId: string): Promise<PlutoState> {
  return db.transaction(async (trx) => {
    const current = await loadPlutoState(trx);
    if (Object.keys(current.breakers).length > 0) throw new PlutoStateError("A circuit breaker is tripped — reset it before resuming.");
    await trx("pluto_state").where({ id: 1 }).update({ paused: false, pause_reason: null, paused_by_user_id: userId, paused_at: trx.fn.now(), updated_at: trx.fn.now() });
    return loadPlutoState(trx);
  });
}

/** Trips a breaker (idempotent per name) and pauses. The agent calls this; the screen shows it. */
export async function tripPlutoBreaker(name: string, detail: string): Promise<PlutoState> {
  return db.transaction(async (trx) => {
    const current = await loadPlutoState(trx);
    if (current.breakers[name]) return current;
    const breakers = { ...current.breakers, [name]: { trippedAt: new Date().toISOString(), detail } };
    await trx("pluto_state").where({ id: 1 }).update({ breakers: JSON.stringify(breakers), paused: true, pause_reason: `breaker:${name}`, paused_by_user_id: null, paused_at: trx.fn.now(), updated_at: trx.fn.now() });
    return loadPlutoState(trx);
  });
}

/** Human reset of one breaker. Pluto stays paused until Resume is pressed explicitly. */
export async function resetPlutoBreaker(name: string): Promise<PlutoState> {
  return db.transaction(async (trx) => {
    const current = await loadPlutoState(trx);
    const { [name]: _removed, ...rest } = current.breakers;
    await trx("pluto_state").where({ id: 1 }).update({ breakers: JSON.stringify(rest), updated_at: trx.fn.now() });
    return loadPlutoState(trx);
  });
}

export async function recordPlutoRelease(release: string): Promise<void> {
  await db("pluto_state").where({ id: 1 }).update({ last_seen_release: release, updated_at: db.fn.now() });
}

export async function savePlutoReadiness(record: PlutoReadinessRecord): Promise<void> {
  await db("pluto_state").where({ id: 1 }).update({ readiness: JSON.stringify(record), updated_at: db.fn.now() });
}

export async function recordPlutoPass(): Promise<void> {
  await db("pluto_state").where({ id: 1 }).update({ last_pass_at: db.fn.now(), updated_at: db.fn.now() });
}

export class PlutoStateError extends Error {}
