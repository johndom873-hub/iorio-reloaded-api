import { db } from "../db/connection.js";
import { readAppEnvironment } from "./appEnvironment.js";
import { resolveIsOpenDay } from "./marketSessionStatus.js";
import { notifyTelegramTracked } from "./undeliveredAlerts.js";
import { collectReadinessChecks, createDefaultReadinessDependencies, type ReadinessDependencies } from "./preOpenReadinessCollectors.js";
import { easternIsoDate } from "./easternIsoDate.js";
import {
  buildReadinessMessage,
  decideReadinessActions,
  emptyReadinessState,
  snapshotReadiness,
  summarizeReadiness,
  type ReadinessAction,
  type ReadinessMessageKind,
  type ReadinessSnapshot,
  type ReadinessState,
  type ReadinessStage,
  type ReadinessVerdict,
} from "./preOpenReadiness.js";

// Runs inside the ops monitor's minute tick (web dyno, no Scheduler entry). State lives in alert_state so a restart or a second dyno neither
// repeats nor loses a message: one row per stage per day holds the last run time and the problem signature, and a per-run claim row makes
// exactly one dyno do each run.

const stateKeyPrefix = "readiness:";
const claimKeyPrefix = "readiness-run:";
const greenSignature = "ok";

const stateKey = (stage: "pre_open" | "final" | "open", dateIso: string) => `${stateKeyPrefix}${stage}:${dateIso}`;
const lastSentKey = (dateIso: string) => `${stateKeyPrefix}last-sent:${dateIso}`;

export async function loadReadinessState(dateIso: string): Promise<ReadinessState> {
  const rows: { alert_key: string; last_alerted_at: Date; last_message: string | null }[] = await db("alert_state").where("alert_key", "like", `${stateKeyPrefix}%:${dateIso}`).select("alert_key", "last_alerted_at", "last_message");
  const byKey = new Map(rows.map((row) => [row.alert_key, row]));
  const signatureOf = (row: { last_message: string | null } | undefined) => (row === undefined ? null : row.last_message === greenSignature ? "" : (row.last_message ?? ""));
  const preOpen = byKey.get(stateKey("pre_open", dateIso));
  const open = byKey.get(stateKey("open", dateIso));
  return {
    preOpenLastRunAtMs: preOpen ? new Date(preOpen.last_alerted_at).getTime() : null,
    preOpenSignature: signatureOf(preOpen),
    finalSent: byKey.has(stateKey("final", dateIso)),
    openLastRunAtMs: open ? new Date(open.last_alerted_at).getTime() : null,
    openSignature: signatureOf(open),
  };
}

/** `ranAt` is the instant the run was evaluated (not the database clock), so the re-check spacing follows the same clock as the schedule. */
async function saveReadinessRun(stage: "pre_open" | "final" | "open", dateIso: string, signature: string, ranAt: Date): Promise<void> {
  await db("alert_state")
    .insert({ alert_key: stateKey(stage, dateIso), first_alerted_at: ranAt, last_alerted_at: ranAt, last_message: signature === "" ? greenSignature : signature })
    .onConflict("alert_key")
    .merge({ last_alerted_at: ranAt, last_message: signature === "" ? greenSignature : signature });
}

/** The last message sent today, or null when none was (or its row cannot be read): the next message is then the full report. */
export async function loadLastSentReadiness(dateIso: string): Promise<ReadinessSnapshot | null> {
  const row: { last_alerted_at: Date; last_message: string | null } | undefined = await db("alert_state").where("alert_key", lastSentKey(dateIso)).first("last_alerted_at", "last_message");
  if (!row?.last_message) return null;
  try {
    const stored = JSON.parse(row.last_message) as Pick<ReadinessSnapshot, "statuses" | "release">;
    return { sentAtMs: new Date(row.last_alerted_at).getTime(), statuses: stored.statuses, release: stored.release };
  } catch {
    return null;
  }
}

async function saveLastSentReadiness(dateIso: string, snapshot: ReadinessSnapshot): Promise<void> {
  const sentAt = new Date(snapshot.sentAtMs);
  const message = JSON.stringify({ statuses: snapshot.statuses, release: snapshot.release });
  await db("alert_state")
    .insert({ alert_key: lastSentKey(dateIso), first_alerted_at: sentAt, last_alerted_at: sentAt, last_message: message })
    .onConflict("alert_key")
    .merge({ last_alerted_at: sentAt, last_message: message });
}

/** Two web dynos can both see a run as due: only the one whose insert wins the claim does it. */
async function claimRun(action: ReadinessAction, dateIso: string, now: Date): Promise<boolean> {
  const slotMinutes = action.kind === "final" ? 24 * 60 : action.kind === "pre_open" ? 10 : 2;
  const slot = Math.floor(now.getTime() / (slotMinutes * 60_000));
  const claimed = await db("alert_state")
    .insert({ alert_key: `${claimKeyPrefix}${action.kind}:${dateIso}:${slot}`, first_alerted_at: now, last_alerted_at: now, last_message: "readiness run" })
    .onConflict("alert_key")
    .ignore()
    .returning("alert_key");
  return claimed.length > 0;
}

async function runStage(stage: ReadinessStage, now: Date, dependencies: ReadinessDependencies): Promise<ReadinessVerdict> {
  return summarizeReadiness(await collectReadinessChecks(stage, now, dependencies));
}

/** Returns the snapshot of the message it sent, or `lastSent` unchanged when it sent none. */
async function performAction(action: ReadinessAction, dateIso: string, now: Date, state: ReadinessState, lastSent: ReadinessSnapshot | null, dependencies: ReadinessDependencies): Promise<ReadinessSnapshot | null> {
  if (!(await claimRun(action, dateIso, now))) return lastSent;
  const stage: ReadinessStage = action.kind === "open" ? "open" : "pre_open";
  const verdict = await runStage(stage, now, dependencies);
  const environment = dependencies.appEnvironment;
  let sent = lastSent;
  const send = async (kind: ReadinessMessageKind) => {
    await notifyTelegramTracked(buildReadinessMessage({ kind, dateIso, environment, verdict, previous: lastSent }));
    sent = snapshotReadiness(verdict, now);
    await saveLastSentReadiness(dateIso, sent);
  };

  if (action.kind === "final") {
    await send("final");
    await saveReadinessRun("final", dateIso, verdict.signature, now);
    return sent;
  }
  const previousSignature = action.kind === "pre_open" ? state.preOpenSignature : state.openSignature;
  if (action.announce === "always") await send(action.kind === "open" ? "open" : "first");
  else if (verdict.signature !== (previousSignature ?? "")) await send(action.kind === "open" ? "open" : "changed");
  await saveReadinessRun(action.kind, dateIso, verdict.signature, now);
  return sent;
}

/** The monitor's per-minute entry point. Only production and staging run it, and only on market-open days. Returns the actions it took. */
export async function runPreOpenReadinessIfDue(now: Date = new Date(), dependencies?: ReadinessDependencies): Promise<ReadinessAction[]> {
  const appEnvironment = readAppEnvironment();
  if (appEnvironment === "development") return [];
  const dateIso = easternIsoDate(now);
  if (!(await resolveIsOpenDay(dateIso))) return [];
  const state = await loadReadinessState(dateIso).catch(() => emptyReadinessState);
  const actions = decideReadinessActions(now, dateIso, state);
  if (actions.length === 0) return [];
  const resolvedDependencies = dependencies ?? createDefaultReadinessDependencies();
  let lastSent = await loadLastSentReadiness(dateIso).catch(() => null);
  for (const action of actions) lastSent = await performAction(action, dateIso, now, state, lastSent, resolvedDependencies);
  return actions;
}

export async function pruneOldReadinessState(now: Date): Promise<void> {
  await db("alert_state")
    .where((query) => query.where("alert_key", "like", `${stateKeyPrefix}%`).orWhere("alert_key", "like", `${claimKeyPrefix}%`))
    .andWhere("first_alerted_at", "<", new Date(now.getTime() - 3 * 24 * 60 * 60_000))
    .del();
}
