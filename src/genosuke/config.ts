import { environment } from "../config/env.js";

// Genosuke's config is deliberately NOT part of src/config/env.ts's
// hard-required schema — that module throws at import time (crashing the
// whole server) if anything is missing, and this feature is unconfigured in
// prod today (blocked on Juan's OpenRouter key). Reads lazily instead, same
// pattern as notifyTelegram.ts, so the rest of the API keeps working
// untouched until setup is complete. Mirrors menaris-admin-api's Jack bot's
// own `enabled` boolean gate (telegram-bot-service.js).
export interface GenosukeConfig {
  telegramBotToken: string;
  telegramChatId: string;
  openRouterApiKey: string;
  openRouterModel: string;
  serviceUsername: string;
  serviceUserPassword: string;
  /** Always a same-dyno localhost self-call — Genosuke's tools are just another authenticated API client. */
  apiBaseUrl: string;
}

// TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are shared with the existing outbound
// notifyTelegram() sender (approved 2026-08-21: reuse the one bot rather
// than a second BotFather identity). GENOSUKE_POLLING_ENABLED is the
// dev/prod kill switch — both environments share one bot token, and two
// simultaneous getUpdates pollers on the same token race on the offset
// (each update goes to only one poller), causing dropped/duplicate
// handling. Must be explicitly "true" in exactly one environment.
export function loadGenosukeConfig(): GenosukeConfig | null {
  if (process.env.GENOSUKE_POLLING_ENABLED !== "true") return null;

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const telegramChatId = process.env.TELEGRAM_CHAT_ID;
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;
  const openRouterModel = process.env.GENOSUKE_MODEL;
  const serviceUsername = process.env.GENOSUKE_SERVICE_USERNAME;
  const serviceUserPassword = process.env.GENOSUKE_SERVICE_USER_PASSWORD;

  const missing = [
    ["TELEGRAM_BOT_TOKEN", telegramBotToken],
    ["TELEGRAM_CHAT_ID", telegramChatId],
    ["OPENROUTER_API_KEY", openRouterApiKey],
    ["GENOSUKE_MODEL", openRouterModel],
    ["GENOSUKE_SERVICE_USERNAME", serviceUsername],
    ["GENOSUKE_SERVICE_USER_PASSWORD", serviceUserPassword],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    console.warn(
      `Genosuke: GENOSUKE_POLLING_ENABLED=true but missing ${missing.map(([name]) => name).join(", ")} — staying disabled.`,
    );
    return null;
  }

  return {
    telegramBotToken: telegramBotToken!,
    telegramChatId: telegramChatId!,
    openRouterApiKey: openRouterApiKey!,
    openRouterModel: openRouterModel!,
    serviceUsername: serviceUsername!,
    serviceUserPassword: serviceUserPassword!,
    apiBaseUrl: `http://127.0.0.1:${environment.port}`,
  };
}
