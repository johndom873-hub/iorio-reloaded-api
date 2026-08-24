import { requireEnvironmentVariable } from "../config/env.js";

// Genosuke's config is read lazily (not folded into src/config/env.ts's
// hard-required schema) because GENOSUKE_ENABLED is a deliberate on/off
// switch, same shape as menaris-admin-api's Jack bot (`enabled` in
// telegram-bot-service.js) — Telegram delivers webhook updates to only one
// registered URL per bot token, so at most one environment may have this
// bot's webhook active at a time. When the switch is on, every other var
// below is mandatory and missing ones throw, same as src/config/env.ts's
// own requireEnvironmentVariable.
export interface GenosukeConfig {
  telegramBotToken: string;
  telegramChatId: string;
  openRouterApiKey: string;
  openRouterModel: string;
  serviceUsername: string;
  serviceUserPassword: string;
  webhookUrl: string;
  webhookSecret: string;
  /** Always a same-dyno localhost self-call — Genosuke's tools are just another authenticated API client. */
  apiBaseUrl: string;
}

// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are shared with the existing outbound
// notifyTelegram() sender (approved 2026-08-21: reuse the one bot rather
// than a second BotFather identity).
export function loadGenosukeConfig(): GenosukeConfig | null {
  if (process.env.GENOSUKE_ENABLED !== "true") return null;

  return {
    telegramBotToken: requireEnvironmentVariable("TELEGRAM_BOT_TOKEN"),
    telegramChatId: requireEnvironmentVariable("TELEGRAM_CHAT_ID"),
    openRouterApiKey: requireEnvironmentVariable("OPENROUTER_API_KEY"),
    openRouterModel: requireEnvironmentVariable("GENOSUKE_MODEL"),
    serviceUsername: requireEnvironmentVariable("GENOSUKE_SERVICE_USERNAME"),
    serviceUserPassword: requireEnvironmentVariable("GENOSUKE_SERVICE_USER_PASSWORD"),
    webhookUrl: requireEnvironmentVariable("GENOSUKE_WEBHOOK_URL"),
    webhookSecret: requireEnvironmentVariable("GENOSUKE_WEBHOOK_SECRET"),
    // Read directly rather than via environment.ts's `port` field — that
    // field was removed so importing environment.ts (needed by the worker
    // process for IBKR config) doesn't require a $PORT that only the web
    // dyno gets. Safe here since this only ever runs inside the web
    // process, after app.listen has already bound $PORT.
    apiBaseUrl: `http://127.0.0.1:${process.env.PORT}`,
  };
}
