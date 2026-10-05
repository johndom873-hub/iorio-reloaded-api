// scripts/vps/gateway-control.sh always ends with GATEWAY_CONTROL_RESULT=<kind>; this is the caller's side of that contract.
export function parseGatewayControlResultKind(scriptOutput: string): string | null {
  const resultLines = [...scriptOutput.matchAll(/^GATEWAY_CONTROL_RESULT=(\S+)\s*$/gm)];
  return resultLines.at(-1)?.[1] ?? null;
}

const freshLoginMessageByResultKind: Record<string, string> = {
  waiting_for_2fa: "Fresh login started. IBKR has sent a new 2FA push: you have about 3 minutes to approve it on your phone.",
  login_completed: "Fresh login started and it completed without a 2FA prompt: the Gateway API is answering again.",
  refused_api_already_answering: "Nothing was restarted: the Gateway is already logged in and its API is answering, so a restart would only force a needless 2FA.",
  rate_limited: "Nothing was restarted: a fresh login was started less than 2 minutes ago. Check your phone for that 2FA push.",
  login_started_unknown: "The Gateway was restarted, but neither a 2FA prompt nor a completed login showed up within 60 seconds. Check the Gateway.",
  restart_failed: "The Gateway container could not be restarted. Check the VPS.",
};

// The only recover outcomes that mean "the live login is waiting for the owner": the API is down with no
// session to restart (needs_manual_login), or the restart landed on a 2FA prompt (waiting_for_2fa).
const recoverResultKindsNeedingPhoneApproval = new Set(["needs_manual_login", "waiting_for_2fa"]);

/**
 * Replaces the health check's generic "restart didn't recover it" headline on the LIVE Gateway when the fix is a
 * manual login; null otherwise. It is the headline, not an appended line, because runJob cuts a thrown message at
 * its first "): " for Telegram: it must stay before that marker, so it never contains one. Constant text per call, so
 * the hourly reminder stays stable between runs. No push has been sent at this point (recover never starts a login),
 * so the owner replies to the alert and Genosuke's resend_gateway_2fa sends it.
 */
export function describeLiveGatewayManualLoginHeadline(recoverResultKind: string | null, tradingMode: "paper" | "live"): string | null {
  if (tradingMode !== "live" || recoverResultKind === null || !recoverResultKindsNeedingPhoneApproval.has(recoverResultKind)) return null;
  return "IBKR live Gateway is not logged in and needs a manual login (most likely IBKR's weekly session expiry). No 2FA push has been sent yet: reply to this message when your phone is ready and Genosuke will send one (confirm with Yes), then approve it within about 3 minutes";
}

export function describeFreshLoginResult(resultKind: string): string {
  return freshLoginMessageByResultKind[resultKind] ?? `The VPS script returned an unexpected result: ${resultKind}.`;
}
