import { describe, expect, it } from "vitest";
import { summarizeGatewayReadiness, type EnvironmentDetailsForReadiness, type GatewayHealthForReadiness, type JobRunForReadiness } from "./gatewayReadinessSummary.js";

const healthyEnvironment: EnvironmentDetailsForReadiness = {
  environment: "production",
  tradingMode: "live",
  trading: { state: "ok", reason: null },
  marketDataLinesEnabled: true,
  marketDataFeedRefusal: null,
  worker: { accountId: "U21518308", bindingStatus: "ok", heartbeatAgeSeconds: 20 },
};
const healthyGateway: GatewayHealthForReadiness = { connected: true, staleOrMissing: false, uptimeMs: 3 * 3_600_000 + 5 * 60_000, inFlightOrderCount: 0 };
const successfulHealthCheck: JobRunForReadiness = { jobName: "ibkr_health_check", startedAt: "2026-10-05T12:50:00Z", status: "success", errorMessage: null };

describe("summarizeGatewayReadiness", () => {
  it("reports ready with no problems when everything is up", () => {
    const summary = summarizeGatewayReadiness({ environmentDetails: healthyEnvironment, gatewayHealth: healthyGateway, latestJobRuns: [successfulHealthCheck] });
    expect(summary.readyToTrade).toBe(true);
    expect(summary.problems).toEqual([]);
    expect(summary.warnings).toEqual([]);
    expect(summary.workerAccountId).toBe("U21518308");
    expect(summary.gatewayUptime).toBe("3h 5m");
  });

  it("blocks and names the phone approval when the live Gateway link is down", () => {
    const summary = summarizeGatewayReadiness({
      environmentDetails: { ...healthyEnvironment, trading: { state: "blocked", reason: "Trading is blocked: Not connected to the IBKR Gateway." } },
      gatewayHealth: { ...healthyGateway, connected: false },
      latestJobRuns: [],
    });
    expect(summary.readyToTrade).toBe(false);
    expect(summary.problems.join(" ")).toContain("Not connected to the IBKR Gateway");
    expect(summary.problems.join(" ")).toContain("phone approval");
    expect(summary.gatewayUptime).toBeNull();
  });

  it("does not mention a phone approval on paper", () => {
    const summary = summarizeGatewayReadiness({ environmentDetails: { ...healthyEnvironment, tradingMode: "paper" }, gatewayHealth: { ...healthyGateway, connected: false }, latestJobRuns: [] });
    expect(summary.problems.join(" ")).not.toContain("phone approval");
  });

  it("treats a missing or stale worker row as not connected", () => {
    const summary = summarizeGatewayReadiness({ environmentDetails: healthyEnvironment, gatewayHealth: { connected: false, staleOrMissing: true, inFlightOrderCount: 0 }, latestJobRuns: [] });
    expect(summary.readyToTrade).toBe(false);
  });

  it("treats an old worker heartbeat as not connected even when the stored flag still says connected", () => {
    const summary = summarizeGatewayReadiness({
      environmentDetails: { ...healthyEnvironment, worker: { accountId: "U21518308", bindingStatus: "ok", heartbeatAgeSeconds: 10_206 } },
      gatewayHealth: healthyGateway,
      latestJobRuns: [],
    });
    expect(summary.readyToTrade).toBe(false);
    expect(summary.problems.join(" ")).toContain("not connected");
    expect(summary.gatewayUptime).toBeNull();
  });

  it("blocks when IBKR refuses live prices or real-time data is switched off", () => {
    const refused = summarizeGatewayReadiness({
      environmentDetails: { ...healthyEnvironment, marketDataFeedRefusal: { code: 10197, message: "No market data during competing live session", since: "2026-10-05T13:00:00Z" } },
      gatewayHealth: healthyGateway,
      latestJobRuns: [],
    });
    expect(refused.readyToTrade).toBe(false);
    expect(refused.problems[0]).toContain("10197");

    const switchedOff = summarizeGatewayReadiness({ environmentDetails: { ...healthyEnvironment, marketDataLinesEnabled: false }, gatewayHealth: healthyGateway, latestJobRuns: [] });
    expect(switchedOff.readyToTrade).toBe(false);
  });

  it("warns, without blocking, when the latest scheduled health check failed", () => {
    const summary = summarizeGatewayReadiness({
      environmentDetails: healthyEnvironment,
      gatewayHealth: healthyGateway,
      latestJobRuns: [{ ...successfulHealthCheck, status: "failure", errorMessage: "x".repeat(500) }],
    });
    expect(summary.readyToTrade).toBe(true);
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]?.length).toBeLessThan(450);
  });
});
