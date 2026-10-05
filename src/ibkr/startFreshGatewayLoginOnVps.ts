import { environment, requireEnvironmentVariable } from "../config/env.js";
import { runForcedCommandSsh } from "./runForcedCommandSsh.js";
import { parseGatewayControlResultKind } from "./gatewayControlResult.js";

export interface FreshGatewayLoginResult {
  resultKind: string | null;
  output: string;
}

// The key's forced command fixes both the action and the environment (`fresh-login paper|live` in
// scripts/vps/gateway-control.sh), so a staging deployment's key can only ever touch the paper Gateway.
export async function startFreshGatewayLoginOnVps(): Promise<FreshGatewayLoginResult> {
  const result = await runForcedCommandSsh({
    sshHost: environment.ibkrTunnelSshHost,
    sshPort: environment.ibkrTunnelSshPort,
    sshUsername: environment.ibkrTunnelSshUsername,
    sshPrivateKey: Buffer.from(requireEnvironmentVariable("IBKR_GATEWAY_LOGIN_SSH_PRIVATE_KEY_BASE64"), "base64"),
    // The script waits up to about 60s for the login to show a 2FA prompt or complete.
    timeoutMs: 120_000,
    timeoutMessage: "Timed out waiting for the Gateway login script on the VPS.",
  });
  return { resultKind: parseGatewayControlResultKind(result.output), output: result.output };
}
