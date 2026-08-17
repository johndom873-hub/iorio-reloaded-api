// Sends a message to the ops Telegram channel via the Bot API's sendMessage
// endpoint. Ported from menaris-admin-api's utils/telegram-notifier.js
// (HTML escaping + message-length truncation), simplified to one channel —
// PROGRESS.md's Telegram notification rules for this project use a single
// channel for everything, not menaris's separate business/tech split.
//
// Never throws — a Telegram outage (or the bot/chat simply not being
// configured yet) must never mask or crash the underlying job this is
// reporting on. Silently no-ops with a console warning if the bot token or
// chat ID isn't set, so callers can start using this before Telegram setup
// is finished without breaking anything.
//
// Reads process.env inside the function, not as module-level constants —
// this module can be imported before src/config/env.ts's `import
// "dotenv/config"` side effect has run (import order in the file doing the
// importing determines evaluation order), which would otherwise read
// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID as undefined even when they're
// genuinely set in .env. Reading lazily at call time sidesteps that
// entirely. In prod this doesn't matter (Heroku injects config vars
// directly into process.env at boot, no dotenv involved) but it broke a
// local test run of scripts/check-ibkr-health.ts.
//
// Deliberately not "alert on every failure" logic here — see PROGRESS.md's
// Telegram notification rules: system-health-style checks should only alert
// on state transition (healthy->failing, failing->healthy), which needs the
// job_runs table (not yet built) to compare against. Callers without that
// available yet (e.g. scripts/check-ibkr-health.ts) alert on every failure
// for now — noisier than the eventual design, but simple and correct until
// job_runs exists.
const TELEGRAM_MESSAGE_LIMIT = 4096;
const TELEGRAM_TRUNCATED_SUFFIX = "... (message truncated)";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncateForTelegram(message: string): string {
  if (message.length <= TELEGRAM_MESSAGE_LIMIT) return message;
  const maxLength = TELEGRAM_MESSAGE_LIMIT - TELEGRAM_TRUNCATED_SUFFIX.length;
  return `${message.slice(0, maxLength)}${TELEGRAM_TRUNCATED_SUFFIX}`;
}

export async function notifyTelegram(message: string): Promise<void> {
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  if (!telegramBotToken || !telegramChatId) {
    console.warn("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — skipping Telegram notification:", message);
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: escapeHtml(truncateForTelegram(message)),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!response.ok) {
      console.error(`Telegram notification failed (${response.status}): ${await response.text()}`);
    }
  } catch (error) {
    console.error("Telegram notification failed:", error instanceof Error ? error.message : error);
  }
}
