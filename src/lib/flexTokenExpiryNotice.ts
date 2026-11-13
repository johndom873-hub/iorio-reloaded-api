import { daysToExpiry } from "./optionContractLabel.js";
import { notifyTelegram } from "./notifyTelegram.js";
import { previousOpenSessionDate } from "./marketSessionStatus.js";

// IBKR's Flex API does not expose when a token expires, so the date is kept in IBKR_FLEX_TOKEN_EXPIRES_ON (YYYY-MM-DD)
// beside IBKR_FLEX_TOKEN. The nightly P&L snapshot job sends one Telegram notice when the token gets within 30 days of
// that date and another within 7 days (approved by Marcelo 2026-11-13); after the date, the Flex download's own
// "Token has expired" alert takes over. The job runs on trading days only, so a notice is due on the first run whose
// session is inside a threshold while the previous run's session was not, which needs no stored state.

export const flexTokenNoticeCalendarDays = [30, 7] as const;

/** Pure: the threshold (in calendar days) this run's notice is for, or null when none is due. The tighter threshold wins if one run crosses both. */
export function decideFlexTokenExpiryNotice(expiresOnIso: string, sessionDateIso: string, previousSessionDateIso: string): number | null {
  const daysLeftTonight = daysToExpiry(expiresOnIso, sessionDateIso);
  if (daysLeftTonight <= 0) return null;
  const daysLeftAtPreviousRun = daysToExpiry(expiresOnIso, previousSessionDateIso);
  const crossed = flexTokenNoticeCalendarDays.filter((threshold) => daysLeftTonight <= threshold && daysLeftAtPreviousRun > threshold);
  return crossed.length === 0 ? null : Math.min(...crossed);
}

/** Fixed wording, no changing numbers: the threshold is the same on every re-send. */
export function formatFlexTokenExpiryNotice(thresholdCalendarDays: number): string {
  return [`⚠️ The IBKR Flex token expires within ${thresholdCalendarDays} days.`, "Generate a new one in the Client Portal (Flex Web Service, longest expiry) and update both IBKR_FLEX_TOKEN and IBKR_FLEX_TOKEN_EXPIRES_ON."].join("\n");
}

export interface FlexTokenExpiryCheckResult {
  /** Why the check could not run or the notice was not delivered; null when fine (a notice was sent or none was due). */
  problem: string | null;
  noticeSent: boolean;
}

export async function checkFlexTokenExpiry(sessionDateIso: string): Promise<FlexTokenExpiryCheckResult> {
  const expiresOnIso = process.env.IBKR_FLEX_TOKEN_EXPIRES_ON;
  if (!expiresOnIso || !/^\d{4}-\d{2}-\d{2}$/.test(expiresOnIso) || Number.isNaN(Date.parse(`${expiresOnIso}T00:00:00Z`))) {
    return { problem: "IBKR_FLEX_TOKEN_EXPIRES_ON is missing or not a YYYY-MM-DD date, so the Flex token's expiry cannot be watched", noticeSent: false };
  }
  const threshold = decideFlexTokenExpiryNotice(expiresOnIso, sessionDateIso, await previousOpenSessionDate(sessionDateIso));
  if (threshold === null) return { problem: null, noticeSent: false };
  const delivered = await notifyTelegram(formatFlexTokenExpiryNotice(threshold));
  return delivered ? { problem: null, noticeSent: true } : { problem: `Flex token expiry notice (${threshold} days) not delivered on Telegram`, noticeSent: false };
}
