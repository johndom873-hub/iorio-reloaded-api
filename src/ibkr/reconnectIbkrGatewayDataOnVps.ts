import { runForcedCommandSsh, type ForcedCommandSshResult } from "./runForcedCommandSsh.js";
import type { RestartIbkrGatewayOptions } from "./restartIbkrGatewayOnVps.js";

// Reconnects the Gateway's data farms on the VPS over SSH: the key's forced command fixes the action and the environment
// (`gateway-control.sh reconnect-data paper|live`), IBC's RECONNECTDATA. No restart, no API disconnect, and the daily
// restart time is left alone. Invoked by checkIbkrHealthJob.ts when the historical-data probe failed twice, before any
// session restart.
export function reconnectIbkrGatewayDataOnVps(options: RestartIbkrGatewayOptions): Promise<ForcedCommandSshResult> {
  return runForcedCommandSsh({
    ...options,
    // The command itself takes about a second, then the script waits 5 s for the farms to settle.
    timeoutMs: 60_000,
    timeoutMessage: "Timed out running the IBKR Gateway data reconnect on VPS.",
  });
}
