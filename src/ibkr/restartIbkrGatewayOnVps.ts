import { runForcedCommandSsh, type ForcedCommandSshResult } from "./runForcedCommandSsh.js";

export interface RestartIbkrGatewayOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
}

// Recovers the IBKR Gateway on the VPS over SSH. The key's forced command fixes the action and the
// environment (`gateway-control.sh recover paper|live`): a session-preserving restart first, and
// only on paper a cold restart as the fallback — live never gets one, since that needs a 2FA approval.
// Only invoked by checkIbkrHealthJob.ts after its own real IBKR API handshake already confirmed the
// Gateway is unreachable (or the historical-data probe failed twice).
export function restartIbkrGatewayOnVps(options: RestartIbkrGatewayOptions): Promise<ForcedCommandSshResult> {
  return runForcedCommandSsh({
    ...options,
    // The script waits up to 60s for the Gateway to go down and 240s for it to come back (the paper
    // cold-restart fallback adds up to 90s more); a normal session restart finishes in about 1-2 minutes.
    timeoutMs: 420_000,
    timeoutMessage: "Timed out running IBKR Gateway restart script on VPS.",
  });
}
