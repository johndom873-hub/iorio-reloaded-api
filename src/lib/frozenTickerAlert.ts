import type { AppEnvironment } from "./appEnvironment.js";
import { describeOptionContract } from "./optionContractLabel.js";

// The Telegram alert for a frozen ticker (Marcelo 2026-10-15): loud, repeated each day while the ticker stays frozen, with a
// prompt to paste into a Claude session that previews the split's record rewrite and applies it only on his OK. The text
// stays the same from one reminder to the next (notifyDownThrottled sends again whenever it changes): only the list of
// options expiring within 3 days can change it, at most once a day.

export const frozenTickerReminderIntervalMs = 24 * 60 * 60_000;
export const expiringSoonDays = 3;

export function frozenTickerAlertKey(tickerId: string): string {
  return `ticker_frozen:${tickerId}`;
}

const herokuAppByEnvironment: Record<AppEnvironment, string | null> = { development: null, staging: "iorio-staging-api", production: "iorio-reloaded-api" };

export interface FrozenTickerAlertInput {
  environment: AppEnvironment;
  symbol: string;
  reason: string;
  split: { id: string; description: string; effectiveDateIso: string } | null;
  expiringSoon: { optionType: "call" | "put"; strike: number; expiryDateIso: string; contracts: number; daysToExpiry: number }[];
}

export function describeFrozenTickerAlert(input: FrozenTickerAlertInput): string {
  const app = herokuAppByEnvironment[input.environment];
  const database = app === null ? "the local database (.env)" : `${input.environment}'s database: DATABASE_URL from \`heroku config:get DATABASE_URL --app ${app}\` and DATABASE_SSL=true`;
  const environmentFlag = `--env ${input.environment}`;
  const expiring =
    input.expiringSoon.length === 0
      ? `No ${input.symbol} options expire within ${expiringSoonDays} days.`
      : [
          `⏰ Expiring within ${expiringSoonDays} days, NOT managed by the platform while frozen (act in IBKR if needed):`,
          ...input.expiringSoon.map((leg) => `• ${leg.contracts}× ${describeOptionContract({ symbol: input.symbol, right: leg.optionType, strike: leg.strike, expiry: leg.expiryDateIso, dte: leg.daysToExpiry })}`),
        ].join("\n");
  const prompt = input.split
    ? [
        `${input.symbol} had a ${input.split.description} effective ${input.split.effectiveDateIso} and is frozen on ${input.environment}.`,
        `In the iorio-reloaded-api repo, against ${database}:`,
        `1. Run \`npm run split:rewrite -- ${environmentFlag} --split ${input.split.id}\`. It is a preview and changes nothing. Show me every record it would change (before → after), IBKR's ${input.symbol} holdings against what the split should leave, and the checks.`,
        `2. Don't apply anything until I say so. On my OK, apply it by adding --apply${input.environment === "production" ? " (production: hand me the command, don't run it yourself)" : ""}, then show me the result.`,
        `3. I decide when to unfreeze: \`npm run ticker:unfreeze -- ${environmentFlag} --ticker ${input.symbol}\`.`,
      ].join("\n")
    : `${input.symbol} is frozen on ${input.environment} (${input.reason}), with no split recorded. Find out why before unfreezing: \`npm run ticker:unfreeze -- ${environmentFlag} --ticker ${input.symbol}\`.`;
  return [
    `🚨🚨🚨 ${input.symbol} FROZEN: ${input.reason} 🚨🚨🚨`,
    `Nobody trades ${input.symbol} on ${input.environment} until its records are rewritten to the new basis and it is unfrozen: its orders were cancelled, Pluto skips it, the order screens refuse it, and the position sync leaves it alone.`,
    expiring,
    "Paste this into a Claude session:",
    prompt,
  ].join("\n\n");
}
