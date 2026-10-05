import { formatDurationHuman } from "../lib/formatDurationHuman.js";
import { workerHeartbeatStaleAfterSeconds } from "../lib/tradingGate.js";

// Genosuke's get_gateway_readiness tool: one plain answer to "can Iorio trade right now?", built from
// three existing routes (GET /environment/details, /system-health/gateway, /system-health/status) so the
// model reports named problems instead of interpreting raw payloads.

export interface EnvironmentDetailsForReadiness {
  environment: string;
  tradingMode: "paper" | "live";
  trading: { state: "ok" | "blocked" | "offline"; reason: string | null };
  marketDataLinesEnabled: boolean;
  marketDataFeedRefusal: { code: number; message: string; since: string } | null;
  worker: { accountId: string | null; bindingStatus: string | null; heartbeatAgeSeconds: number } | null;
}

export interface GatewayHealthForReadiness {
  connected: boolean;
  staleOrMissing?: boolean;
  uptimeMs?: number | null;
  inFlightOrderCount: number;
}

export interface JobRunForReadiness {
  jobName: string;
  startedAt: string;
  status: string;
  errorMessage: string | null;
}

const maxHealthCheckErrorCharacters = 300;

export function summarizeGatewayReadiness(params: {
  environmentDetails: EnvironmentDetailsForReadiness;
  gatewayHealth: GatewayHealthForReadiness;
  latestJobRuns: JobRunForReadiness[];
}) {
  const { environmentDetails, gatewayHealth, latestJobRuns } = params;
  const problems: string[] = [];
  const warnings: string[] = [];

  if (environmentDetails.trading.state !== "ok") problems.push(environmentDetails.trading.reason ?? `Trading state is ${environmentDetails.trading.state}.`);

  // /system-health/gateway reports the last stored "connected" flag even when the heartbeat is hours old, so the
  // heartbeat age from /environment/details has the final say.
  const heartbeatFresh = environmentDetails.worker !== null && environmentDetails.worker.heartbeatAgeSeconds <= workerHeartbeatStaleAfterSeconds;
  const gatewayLinkUp = gatewayHealth.connected && !gatewayHealth.staleOrMissing && heartbeatFresh;
  if (!gatewayLinkUp) {
    problems.push("The trading worker is not connected to the IBKR Gateway.");
    if (environmentDetails.tradingMode === "live") {
      problems.push("On live this is usually a login waiting for a phone approval: approve the pending IBKR 2FA push, or use resend_gateway_2fa to get a new one.");
    }
  }

  if (!environmentDetails.marketDataLinesEnabled) problems.push("Real-time market data is switched off (IBKR_MARKET_DATA_LINES_ENABLED=false).");
  const refusal = environmentDetails.marketDataFeedRefusal;
  if (refusal) problems.push(`IBKR is refusing live prices (code ${refusal.code}: ${refusal.message}) since ${refusal.since}.`);

  const latestHealthCheck = latestJobRuns.find((run) => run.jobName === "ibkr_health_check") ?? null;
  if (latestHealthCheck?.status === "failure") {
    warnings.push(`The latest scheduled Gateway health check (${latestHealthCheck.startedAt}) failed: ${(latestHealthCheck.errorMessage ?? "no error message").slice(0, maxHealthCheckErrorCharacters)}`);
  }

  return {
    readyToTrade: problems.length === 0,
    environment: environmentDetails.environment,
    tradingMode: environmentDetails.tradingMode,
    problems,
    warnings,
    workerAccountId: environmentDetails.worker?.accountId ?? null,
    workerHeartbeatAgeSeconds: environmentDetails.worker?.heartbeatAgeSeconds ?? null,
    gatewayUptime: gatewayLinkUp && gatewayHealth.uptimeMs ? formatDurationHuman(gatewayHealth.uptimeMs) : null,
    inFlightOrderCount: gatewayHealth.inFlightOrderCount,
    latestHealthCheck: latestHealthCheck ? { status: latestHealthCheck.status, startedAt: latestHealthCheck.startedAt } : null,
  };
}
