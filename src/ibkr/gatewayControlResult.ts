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

export function describeFreshLoginResult(resultKind: string): string {
  return freshLoginMessageByResultKind[resultKind] ?? `The VPS script returned an unexpected result: ${resultKind}.`;
}
