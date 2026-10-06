// Login throttle (approved 2026-09-24): 10 attempts per 15 minutes per connecting address, counted on failures only. Covers
// password and passkey sign-in alike. In-memory per dyno: a decoration against casual brute force, not a distributed
// rate limiter.
const loginThrottleWindowMs = 15 * 60 * 1000;
const loginThrottleMaxFailures = 10;
const loginFailuresByAddress = new Map<string, number[]>();

// The address the router itself saw connecting (Express "trust proxy" is 1: the Heroku router's appended entry). Anything a
// client puts in X-Forwarded-For sits to its left and never reaches this value. Behind Cloudflare that address is the
// Cloudflare edge, shared by every visitor served from it.
export function clientAddress(request: { ip?: string }): string {
  return (request.ip ?? "unknown").trim();
}

// For a message a person reads: the throttle address plus the client address Cloudflare reports. The reported one is
// informative but a client can set it when it reaches the API directly, so it is labelled as reported.
export function describeClientAddress(request: { ip?: string; headers: Record<string, unknown> }): string {
  const reported = request.headers["cf-connecting-ip"];
  const reportedAddress = typeof reported === "string" ? reported.trim() : "";
  return reportedAddress ? `${clientAddress(request)} (reported client ${reportedAddress})` : clientAddress(request);
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
