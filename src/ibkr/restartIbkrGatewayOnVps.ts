import { runForcedCommandSsh, type ForcedCommandSshResult } from "./runForcedCommandSsh.js";

export interface RestartIbkrGatewayOptions {
  sshHost: string;
  sshPort: number;
  sshUsername: string;
  sshPrivateKey: Buffer;
}

// Restarts the IBKR Gateway container on the VPS over SSH — see
// restart-gateway.sh's own header comment for why this always restarts
// unconditionally rather than checking first. Only invoked by
// checkIbkrHealthJob.ts after its own real IBKR API handshake already
// confirmed the Gateway is unreachable.
export function restartIbkrGatewayOnVps(options: RestartIbkrGatewayOptions): Promise<ForcedCommandSshResult> {
  return runForcedCommandSsh({
    ...options,
    // Normally finishes in well under a minute (25s sleep plus restart time).
    timeoutMs: 90_000,
    timeoutMessage: "Timed out running IBKR Gateway restart script on VPS.",
  });
}
