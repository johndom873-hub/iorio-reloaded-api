import { requireEnvironmentVariable } from "../config/env.js";

// Pluto's existence layer: switches, never the environment (Marcelo 2026-10-05: staging and production work the same
// way). The agent only starts when its Procfile process is scaled up (implicit: this code is running) and PLUTO_ENABLED
// is exactly "true"; it then boots paused, and acts only once its mode is switched on (off by default) on the Pluto
// screen. It talks to the API as a service user over HTTP (the public origin on Heroku, loopback locally), so every
// order goes through the same routes and gates humans use; SERVICE_LOGIN_SECRET lets that routed login through while
// passkeys are required (serviceLoginSecret.ts).

export interface PlutoConfig {
  apiBaseUrl: string;
  serviceUsername: string;
  serviceUserPassword: string;
  serviceLoginSecret: string;
  openRouterApiKey: string;
  /** Pluto's own Telegram bot (one per environment); messages go to the shared alerts group. */
  telegramBotToken: string;
}

export type PlutoStartDecision = { start: true; config: PlutoConfig } | { start: false; reason: string };

export function decidePlutoStart(env: NodeJS.ProcessEnv = process.env): PlutoStartDecision {
  if (env.PLUTO_ENABLED !== "true") return { start: false, reason: 'PLUTO_ENABLED is not "true"' };
  return {
    start: true,
    config: {
      apiBaseUrl: requireEnvironmentVariable("PLUTO_API_BASE_URL"),
      serviceUsername: requireEnvironmentVariable("PLUTO_SERVICE_USERNAME"),
      serviceUserPassword: requireEnvironmentVariable("PLUTO_SERVICE_USER_PASSWORD"),
      serviceLoginSecret: requireEnvironmentVariable("SERVICE_LOGIN_SECRET"),
      openRouterApiKey: requireEnvironmentVariable("OPENROUTER_API_KEY"),
      telegramBotToken: requireEnvironmentVariable("PLUTO_TELEGRAM_BOT_TOKEN"),
    },
  };
}
