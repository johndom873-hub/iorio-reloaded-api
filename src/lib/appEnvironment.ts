import { requireEnvironmentVariable } from "../config/env.js";

export type AppEnvironment = "development" | "staging" | "production";

// Read lazily (not folded into config/env.ts's eager validation): only the
// worker needs it today, and a var missing for some other consumer of that
// shared module must not crash it (see the shared-env.ts landmine, 2026-09-08).
export function readAppEnvironment(): AppEnvironment {
  const value = requireEnvironmentVariable("APP_ENVIRONMENT");
  if (value !== "development" && value !== "staging" && value !== "production") {
    throw new Error(`APP_ENVIRONMENT must be "development", "staging" or "production", got: ${value}`);
  }
  return value;
}
