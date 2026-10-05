import { requireEnvironmentVariable } from "./env.js";

export type PasskeyLoginMode = "off" | "required";

// Read at call time (the same way ibkrMarketDataLinesEnabled is): requireAuth consults it on every request, and the web
// dyno additionally validates it at startup (server.ts) so a missing or misspelt value fails the boot, not a login.
export function readPasskeyLoginMode(): PasskeyLoginMode {
  const value = requireEnvironmentVariable("PASSKEY_LOGIN");
  if (value !== "off" && value !== "required") {
    throw new Error(`PASSKEY_LOGIN must be "off" or "required", got: ${value}`);
  }
  return value;
}

// The registrable domain the browser binds every passkey to (ioriore.com for staging and production, localhost in
// development). Changing it later invalidates every registered passkey.
export function readPasskeyRelyingPartyId(): string {
  return requireEnvironmentVariable("PASSKEY_RP_ID");
}

export function validatePasskeyConfiguration(): void {
  if (readPasskeyLoginMode() === "required") readPasskeyRelyingPartyId();
}
