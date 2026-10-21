import { formatDurationToTheSecond } from "../lib/formatDurationHuman.js";
import type { AgentLeaseTaken } from "./agentLease.js";
import type { PlutoState } from "./stateStore.js";

// The Telegram lines Pluto's agent sends when it stops and when it starts (Marcelo, 2026-10-21: both, short, and only what the
// process knows for certain, never a likely cause). A SIGTERM looks the same for a deploy, Heroku's daily restart, a manual
// restart or a move to a new server, so the stop line says only that Heroku asked; the start line states the facts the new
// process can check: the release changed, the previous agent's lease ran out without being given up, or this one waited for it.

export type PlutoStopReason = "sigterm" | "sigint" | "lease_lost";

const stopTexts: Record<PlutoStopReason, string> = {
  sigterm: "⏹️ Pluto stopping: Heroku asked it to stop",
  sigint: "⏹️ Pluto stopping: interrupted by hand",
  lease_lost: "⏹️ Pluto stopping: another agent took over",
};

export function plutoStopMessage(reason: PlutoStopReason): string {
  return stopTexts[reason];
}

export interface PlutoStartFacts {
  /** This process's release (HEROKU_RELEASE_VERSION, or the git SHA locally); null when unknown. */
  release: string | null;
  /** The release the previous agent last recorded; null when none ever did. */
  previousRelease: string | null;
  lease: AgentLeaseTaken;
  /** Pluto's state once this agent has started (its boot guard may have paused it). */
  state: Pick<PlutoState, "mode" | "paused" | "pauseReason" | "breakers">;
}

const releaseLabel = (release: string) => release.slice(0, 7);

/** Pure: "▶️ Pluto started: new release v234", with "· paused (crash loop)" or "· off" when Pluto is not running normally. */
export function plutoStartMessage(facts: PlutoStartFacts): string {
  const reasons: string[] = [];
  if (facts.release !== null && facts.release !== facts.previousRelease) reasons.push(`new release ${releaseLabel(facts.release)}`);
  if (facts.lease.tookOverFrom !== null) reasons.push("previous agent stopped responding");
  else if (facts.lease.waitedMs > 0) reasons.push(`waited ${formatDurationToTheSecond(facts.lease.waitedMs)} for the previous agent to stop`);
  if (reasons.length === 0) reasons.push(facts.release === null ? "Heroku restart" : "Heroku restart, same release");
  const stateNote = describeStateNote(facts.state);
  return `▶️ Pluto started: ${reasons.join(" · ")}${stateNote ? ` · ${stateNote}` : ""}`;
}

function describeStateNote(state: PlutoStartFacts["state"]): string | null {
  if (state.mode !== "on") return "off";
  const tripped = Object.keys(state.breakers);
  if (tripped.length > 0) return `paused (breaker: ${tripped.join(", ").replace(/_/g, " ")})`;
  if (state.paused) return `paused (${(state.pauseReason ?? "manual").replace(/_/g, " ")})`;
  return null;
}
