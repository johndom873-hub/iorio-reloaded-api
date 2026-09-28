import { readAppEnvironment } from "../lib/appEnvironment.js";
import { requireEnvironmentVariable } from "../config/env.js";

// Pluto's existence layer (design round 2, 2026-09-28): the agent only starts when all three hold —
// its Procfile process is scaled up (implicit: this code is running), PLUTO_ENABLED is exactly "true",
// and the environment is not production. Prod cannot run Pluto by accident even if the config vars
// are copied over. The agent talks to the API as a service user over HTTP (the public origin on
// Heroku, loopback locally), so every order goes through the same routes and gates humans use.

export interface PlutoConfig {
  apiBaseUrl: string;
  serviceUsername: string;
  serviceUserPassword: string;
  openRouterApiKey: string;
}

export type PlutoStartDecision = { start: true; config: PlutoConfig } | { start: false; reason: string };

export function decidePlutoStart(env: NodeJS.ProcessEnv = process.env): PlutoStartDecision {
  if (env.PLUTO_ENABLED !== "true") return { start: false, reason: 'PLUTO_ENABLED is not "true"' };
  const appEnvironment = readAppEnvironment();
  if (appEnvironment === "production") return { start: false, reason: "Pluto never runs in production (staging paper account only, 2026-09-28)" };
  return {
    start: true,
    config: {
      apiBaseUrl: requireEnvironmentVariable("PLUTO_API_BASE_URL"),
      serviceUsername: requireEnvironmentVariable("PLUTO_SERVICE_USERNAME"),
      serviceUserPassword: requireEnvironmentVariable("PLUTO_SERVICE_USER_PASSWORD"),
      openRouterApiKey: requireEnvironmentVariable("OPENROUTER_API_KEY"),
    },
  };
}
