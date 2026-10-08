import { easternIsoDate, easternMinutesOfDay } from "./easternIsoDate.js";
import { fedRateDecisionTitle, fredMajorReleases, midtermElectionsTitle, presidentialElectionTitle } from "./majorMacroEventSources.js";
import { expirySpansMacroEvent } from "./volatilityEdge.js";

// When a major macro release falls inside a contract's life (Formula F1, approved 2026-10-08): which release weighs most,
// how many sessions until it moves prices, and how many sessions the contract is still open from then on. Pluto's
// prompt and its held-position review both read it.

export type MacroEventWeight = "heavy" | "medium" | "light";

const fredTitle = (eventKey: "cpi" | "gdp") => fredMajorReleases.find((release) => release.eventKey === eventKey)!.title;

// The weights Pluto's prompt has used since v3.x (Marcelo): heavy the Fed, CPI and the presidential election, medium the
// midterms, light GDP.
const weightByTitle: Record<string, MacroEventWeight> = {
  [fedRateDecisionTitle]: "heavy",
  [fredTitle("cpi")]: "heavy",
  [presidentialElectionTitle]: "heavy",
  [midtermElectionsTitle]: "medium",
  [fredTitle("gdp")]: "light",
};

const weightRank: Record<MacroEventWeight, number> = { heavy: 3, medium: 2, light: 1 };

/** The adverse move, in normal days of the stock, that a held position is stressed with for each weight (k, approved 2026-10-08). */
export const eventStressNormalDaysByWeight: Record<MacroEventWeight, number> = { heavy: 2, medium: 1, light: 0.5 };

/** A release the calendar holds but this table does not name counts as heavy: the cautious side. */
export function macroEventWeight(title: string): MacroEventWeight {
  return weightByTitle[title] ?? "heavy";
}

const regularCloseMinutes = 16 * 60;

/** The open session a release moves prices in: its own day when it comes before the 16:00 ET close, otherwise the next open day. Null beyond `openDaysIso`. */
export function reactionSessionIso(eventAtMs: number, openDaysIso: string[]): string | null {
  const at = new Date(eventAtMs);
  const dateIso = easternIsoDate(at);
  const beforeClose = easternMinutesOfDay(at) < regularCloseMinutes;
  return openDaysIso.find((day) => (beforeClose ? day >= dateIso : day > dateIso)) ?? null;
}

export interface MacroEventBeforeExpiry {
  title: string;
  weight: MacroEventWeight;
  /** The release's own Eastern date. */
  dateIso: string;
  /** The session it moves prices in (reactionSessionIso). */
  sessionIso: string;
  /** Open sessions after today up to and including that session: 0 for a release still ahead today. */
  sessionsUntil: number;
  /** Open sessions the contract is still open from that session through expiry, both included. */
  sessionsAfter: number;
}

/**
 * Pure F1: the heaviest release before the expiry's close (expirySpansMacroEvent), ties to the one with the fewest sessions
 * after it, then the earliest. `openDaysIso` is sorted and must reach the expiry.
 */
export function heaviestMacroEventBeforeExpiry(input: { events: { title: string; eventAtIso: string }[]; nowMs: number; todayIso: string; expiryIso: string; openDaysIso: string[] }): MacroEventBeforeExpiry | null {
  const described: (MacroEventBeforeExpiry & { eventAtMs: number })[] = [];
  for (const event of input.events) {
    const eventAtMs = Date.parse(event.eventAtIso);
    if (!expirySpansMacroEvent(input.nowMs, input.expiryIso, [{ eventAtMs }])) continue;
    const sessionIso = reactionSessionIso(eventAtMs, input.openDaysIso);
    // A release that spans the expiry always reacts on or before it, so only a calendar too short leaves it without a session.
    if (sessionIso === null) continue;
    described.push({
      title: event.title,
      weight: macroEventWeight(event.title),
      dateIso: easternIsoDate(new Date(eventAtMs)),
      sessionIso,
      sessionsUntil: input.openDaysIso.filter((day) => day > input.todayIso && day <= sessionIso).length,
      sessionsAfter: input.openDaysIso.filter((day) => day >= sessionIso && day <= input.expiryIso).length,
      eventAtMs,
    });
  }
  described.sort((a, b) => weightRank[b.weight] - weightRank[a.weight] || a.sessionsAfter - b.sessionsAfter || a.eventAtMs - b.eventAtMs);
  const heaviest = described[0];
  if (!heaviest) return null;
  return { title: heaviest.title, weight: heaviest.weight, dateIso: heaviest.dateIso, sessionIso: heaviest.sessionIso, sessionsUntil: heaviest.sessionsUntil, sessionsAfter: heaviest.sessionsAfter };
}
