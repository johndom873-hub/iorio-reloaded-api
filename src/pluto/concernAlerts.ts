import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { clearDownState, notifyDownThrottled } from "../lib/throttledAlert.js";
import type { PlutoSystemConcern } from "./decisionSchema.js";

// Telegram for the model's data concerns (Marcelo, 2026-10-07). The first session sent one message per model call: 38
// abstentions in three hours on the same SMCI confusion, until Telegram was switched off. Now, per ticker (and one key for
// a problem with the whole message): one message when it is first flagged, a reminder at most hourly while it stays
// flagged, and one when a round looks at the ticker again without flagging it. Texts never change, so the throttle holds.

export const concernReminderMs = 60 * 60_000;
const wholeMessageKey = "pluto-concern:message";
const keyFor = (symbol: string) => `pluto-concern:${symbol}`;

const flaggedText = (symbol: string) => `🪐 Pluto sees a data problem on ${symbol} and will not trade it until it clears. The reason is on the Pluto screen.`;
const wholeMessageText = "🪐 Pluto sees a problem with the data it was given and is standing aside. The reason is on the Pluto screen.";
const reminderText = (message: string, downFor: string, interval: string) => `${message}\n\n(Still flagged after ~${downFor}. Reminders at most every ${interval}.)`;

export async function updatePlutoConcernAlerts(input: { roundSymbols: string[]; concerns: PlutoSystemConcern[] }): Promise<void> {
  const send = (text: string) => notifyPlutoTelegram(text);
  const flagged = new Set(input.concerns.map((entry) => entry.symbol).filter((symbol): symbol is string => symbol !== null));
  for (const symbol of flagged) await notifyDownThrottled(keyFor(symbol), flaggedText(symbol), concernReminderMs, { send, reminderText });
  for (const symbol of input.roundSymbols) {
    if (flagged.has(symbol)) continue;
    if ((await clearDownState(keyFor(symbol))) !== null) await send(`✅ Pluto's data concern on ${symbol} has cleared.`);
  }
  if (input.concerns.some((entry) => entry.symbol === null)) await notifyDownThrottled(wholeMessageKey, wholeMessageText, concernReminderMs, { send, reminderText });
  else if ((await clearDownState(wholeMessageKey)) !== null) await send("✅ Pluto's concern about the data it was given has cleared.");
}
