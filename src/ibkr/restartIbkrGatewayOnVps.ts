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
    // restart-gateway.sh polls for login completion (up to 60s) plus a
    // settle buffer and restart/log overhead — margin above that worst case.
    timeoutMs: 120_000,
    timeoutMessage: "Timed out running IBKR Gateway restart script on VPS.",
  });
}
