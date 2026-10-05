// Login throttle (approved 2026-09-24): 10 attempts per 15 minutes per client address, counted on failures only. Covers
// password and passkey sign-in alike. In-memory per dyno: a decoration against casual brute force, not a distributed
// rate limiter.
const loginThrottleWindowMs = 15 * 60 * 1000;
const loginThrottleMaxFailures = 10;
const loginFailuresByAddress = new Map<string, number[]>();

export function clientAddress(request: { ip?: string; headers: Record<string, unknown> }): string {
  const forwarded = request.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : typeof forwarded === "string" ? forwarded.split(",")[0] : undefined;
  return (first ?? request.ip ?? "unknown").trim();
}

function recentLoginFailures(address: string, now: number): number[] {
  const kept = (loginFailuresByAddress.get(address) ?? []).filter((at) => now - at < loginThrottleWindowMs);
  if (kept.length === 0) loginFailuresByAddress.delete(address);
  else loginFailuresByAddress.set(address, kept);
  return kept;
}

export function isLoginThrottled(address: string, now: number): boolean {
  return recentLoginFailures(address, now).length >= loginThrottleMaxFailures;
}

export function recordLoginFailure(address: string, now: number): void {
  loginFailuresByAddress.set(address, [...recentLoginFailures(address, now), now]);
}

export function clearLoginFailures(address: string): void {
  loginFailuresByAddress.delete(address);
}

export function resetLoginFailuresForTests(): void {
  loginFailuresByAddress.clear();
}
