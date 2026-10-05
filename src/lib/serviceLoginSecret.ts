import { createHash, timingSafeEqual } from "node:crypto";

// A service account (Genosuke, Pluto) signing in while passkeys are required: Genosuke calls over the web dyno's own
// loopback, but Pluto runs on its own dyno and reaches the API through the Heroku router. Such a routed login must carry
// SERVICE_LOGIN_SECRET in this header besides the account's password (Marcelo, 2026-10-05). Unset secret = no routed
// service login at all (fail closed).
export const serviceLoginSecretHeader = "x-service-login-secret";

/** The secret is at least this long, so a short or placeholder value never opens the routed login. */
const minimumServiceLoginSecretLength = 32;

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time check of the header against the configured secret; false when either is missing or the secret is too short. */
export function isValidServiceLoginSecret(provided: string | string[] | undefined, configured: string | undefined): boolean {
  if (typeof provided !== "string" || !configured || configured.length < minimumServiceLoginSecretLength) return false;
  return timingSafeEqual(digest(provided), digest(configured));
}
