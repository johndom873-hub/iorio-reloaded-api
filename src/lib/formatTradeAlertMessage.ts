// Compact per-trade formatting for the trade-alert Telegram notification
// (scripts/run-trade-alert-generation-job.ts). Deliberately separate from
// the DB-stored `rationale` text (runTradeAlertGeneration.ts's rationaleFor/
// rationaleForRoll) — that one is a single verbose sentence meant for the
// alert review UI, this one is a multi-line block meant for a chat message.
//
// Dates are parsed from the "YYYY-MM-DD" string directly rather than via
// `new Date(...)`, to sidestep the local-timezone-shift issue documented for
// pg `date` columns on this dev machine (WITA, UTC+8) — a Date-object
// round-trip isn't needed for a fixed calendar string anyway.
const monthAbbreviations = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatShortDate(isoDate: string): string {
  const parts = isoDate.split("-");
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  return `${monthAbbreviations[month - 1]} ${day}`;
}

const strategyLabels = {
  covered_call: "Covered Call",
  cash_secured_put: "Cash-Secured Put",
} as const;

export function formatNewTradeAlertLine(
  symbol: string,
  strategyKey: keyof typeof strategyLabels,
  candidate: { strike: number; expiry: string; dte: number; delta: number; premium: number; annualizedYield: number; spotPrice: number },
): string {
  const annualizedYieldPct = (candidate.annualizedYield * 100).toFixed(1);
  return [
    `🟢 ${symbol} — ${strategyLabels[strategyKey]}`,
    `$${candidate.strike.toFixed(2)} strike · exp ${formatShortDate(candidate.expiry)} (${candidate.dte} DTE)`,
    `Premium $${candidate.premium.toFixed(2)} · ${annualizedYieldPct}% ann. yield`,
    `Delta ${candidate.delta.toFixed(2)} · Spot $${candidate.spotPrice.toFixed(2)}`,
  ].join("\n");
}

export function formatRollAlertLine(
  symbol: string,
  leg: { strike: number; expiryIso: string; right: "call" | "put"; entryPrice: number },
  suggestion: {
    trigger: "decay" | "dte";
    currentPrice: number;
    dte: number;
    replacement: { strike: number; expiry: string; premium: number; annualizedYield: number };
    netCredit: number;
  },
): string {
  const rightAbbrev = leg.right === "call" ? "C" : "P";
  const triggerLabel =
    suggestion.trigger === "decay"
      ? `${Math.round((suggestion.currentPrice / leg.entryPrice) * 100)}% premium remaining`
      : `${suggestion.dte} DTE remaining`;
  const replacement = suggestion.replacement;
  const annualizedYieldPct = (replacement.annualizedYield * 100).toFixed(1);
  return [
    `🔄 ${symbol} — Roll suggested (${triggerLabel})`,
    `Current: $${leg.strike.toFixed(2)}${rightAbbrev} exp ${formatShortDate(leg.expiryIso)} → New: $${replacement.strike.toFixed(2)}${rightAbbrev} exp ${formatShortDate(replacement.expiry)}`,
    `Entry $${leg.entryPrice.toFixed(2)} → New premium $${replacement.premium.toFixed(2)} (${annualizedYieldPct}% ann.) · $${suggestion.netCredit.toFixed(2)} net credit`,
  ].join("\n");
}
