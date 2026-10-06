import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const mocks = vi.hoisted(() => {
  const jobRunsDatabaseState = {
    otherRunningJobRow: undefined as { job_name: string } | undefined,
    previousRunRow: undefined as { details: unknown; error_message: string | null } | undefined,
    whereCalls: [] as unknown[][],
    whereNotCalls: [] as unknown[][],
    queriedTables: [] as string[],
  };
  return {
    jobRunsDatabaseState,
    environment: { ibkrTunnelSshHost: "vps.example", ibkrTunnelSshPort: 2222, ibkrTunnelSshUsername: "healthcheck", ibkrTradingMode: "paper" as "paper" | "live" },
    restartIbkrGatewayOnVps: vi.fn(),
    checkWorkerOnVps: vi.fn(),
    connectToIbkrGateway: vi.fn(),
    checkPositionReconciliation: vi.fn(),
    lookupLatestDailyBar: vi.fn(),
    probeCompetingLiveSession: vi.fn(),
    competingLiveSessionSurvivedRestart: vi.fn(),
    reportCompetingLiveSession: vi.fn(),
    reportDaySignalsLoopLiveness: vi.fn(),
    reportOpsMonitorLiveness: vi.fn(),
    reportWorkerHeartbeat: vi.fn(),
    runJobCalls: [] as Array<{ jobName: string; options: unknown }>,
    runJobOutcome: { result: undefined as unknown },
  };
});

vi.mock("../config/env.js", () => ({ environment: mocks.environment }));
vi.mock("./restartIbkrGatewayOnVps.js", () => ({ restartIbkrGatewayOnVps: mocks.restartIbkrGatewayOnVps }));
vi.mock("./checkWorkerOnVps.js", () => ({ checkWorkerOnVps: mocks.checkWorkerOnVps }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: mocks.connectToIbkrGateway }));
vi.mock("./checkPositionReconciliation.js", () => ({ checkPositionReconciliation: mocks.checkPositionReconciliation }));
vi.mock("./fetchTickerOverview.js", () => ({ lookupLatestDailyBar: mocks.lookupLatestDailyBar }));
vi.mock("./probeCompetingLiveSession.js", () => ({ liveDataProbeSymbol: "SPY", probeCompetingLiveSession: mocks.probeCompetingLiveSession }));
vi.mock("../lib/competingLiveSessionAlert.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/competingLiveSessionAlert.js")>("../lib/competingLiveSessionAlert.js");
  return {
    ...actual,
    competingLiveSessionSurvivedRestart: mocks.competingLiveSessionSurvivedRestart,
    reportCompetingLiveSession: mocks.reportCompetingLiveSession,
  };
});
vi.mock("../lib/daySignalsLiveness.js", () => ({ reportDaySignalsLoopLiveness: mocks.reportDaySignalsLoopLiveness }));
vi.mock("../lib/opsMonitorLiveness.js", () => ({ reportOpsMonitorLiveness: mocks.reportOpsMonitorLiveness }));
vi.mock("../lib/workerHeartbeatLiveness.js", () => ({ reportWorkerHeartbeat: mocks.reportWorkerHeartbeat }));
vi.mock("../lib/runJob.js", () => ({
  runJob: async (jobName: string, jobFunction: () => Promise<unknown>, options: unknown) => {
    mocks.runJobCalls.push({ jobName, options });
    mocks.runJobOutcome.result = await jobFunction();
  },
}));
vi.mock("../db/connection.js", () => ({
  db: (tableName: string) => {
    mocks.jobRunsDatabaseState.queriedTables.push(tableName);
    const queryBuilder = {
      where: (...whereArguments: unknown[]) => {
        mocks.jobRunsDatabaseState.whereCalls.push(whereArguments);
        return queryBuilder;
      },
      whereNot: (...whereNotArguments: unknown[]) => {
        mocks.jobRunsDatabaseState.whereNotCalls.push(whereNotArguments);
        return queryBuilder;
      },
      orderBy: () => queryBuilder,
      first: async (...columns: string[]) => (columns[0] === "job_name" ? mocks.jobRunsDatabaseState.otherRunningJobRow : mocks.jobRunsDatabaseState.previousRunRow),
    };
    return queryBuilder;
  },
}));

const {
  captureFarmStatusMessages,
  checkHistoricalData,
  findOtherRunningJobName,
  isCompetingSessionHistoricalDataError,
  previousHealthCheckProbeFailed,
  reconciliationNotifyMessage,
  runIbkrHealthCheckJob,
  runReconciliationSafely,
  tryConnect,
} = await import("./checkIbkrHealthJob.js");
const { blockedAfterReloginMessage, blockedRestartDeferredMessage } = await import("../lib/competingLiveSessionAlert.js");

import type { IbkrConnection } from "./connectIbkr.js";

const competingSessionHistoricalError = "Historical data error for SPY (code 162): Trading TWS session is connected from a different IP address";
const historicalTimeoutError = "Historical data timeout for SPY";
const fixedNow = new Date("2026-10-06T12:00:00.000Z");

interface FakeConnection extends IbkrConnection {
  emitter: EventEmitter;
  disconnect: Mock<() => void>;
}

function createFakeConnection(): FakeConnection {
  const emitter = new EventEmitter();
  return { emitter, ib: emitter as unknown as IbkrConnection["ib"], disconnect: vi.fn() };
}

function successfulRestartResult(output = "GATEWAY_CONTROL_RESULT=recovered\n") {
  return { exitCode: 0, output };
}

interface JobOutput {
  details: {
    output: string;
    probe: { failed: boolean; reason: string | null; restarted: boolean };
    worker: { active: boolean; restarted: boolean };
    reconciliationProblems: string[];
    competingLiveSession: string;
    daySignalsProblem: string | null;
    opsMonitorProblem: string | null;
    workerHeartbeatProblem: string | null;
    farmStatusMessages: Array<{ at: string; code: number; message: string }>;
  };
  notify: string | undefined;
}

function lastJobOutput(): JobOutput {
  return mocks.runJobOutcome.result as JobOutput;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(fixedNow);
  vi.clearAllMocks();
  mocks.environment.ibkrTradingMode = "paper";
  mocks.jobRunsDatabaseState.otherRunningJobRow = undefined;
  mocks.jobRunsDatabaseState.previousRunRow = undefined;
  mocks.jobRunsDatabaseState.whereCalls = [];
  mocks.jobRunsDatabaseState.whereNotCalls = [];
  mocks.jobRunsDatabaseState.queriedTables = [];
  mocks.runJobCalls.length = 0;
  mocks.runJobOutcome.result = undefined;
  vi.stubEnv("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64", Buffer.from("gateway-key").toString("base64"));
  vi.stubEnv("IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64", Buffer.from("worker-key").toString("base64"));
  mocks.lookupLatestDailyBar.mockResolvedValue(null);
  mocks.checkWorkerOnVps.mockResolvedValue({ active: true, restarted: false, output: "active" });
  mocks.probeCompetingLiveSession.mockResolvedValue("flowing");
  mocks.competingLiveSessionSurvivedRestart.mockResolvedValue(false);
  mocks.reportCompetingLiveSession.mockResolvedValue(false);
  mocks.checkPositionReconciliation.mockResolvedValue([]);
  mocks.reportDaySignalsLoopLiveness.mockResolvedValue(null);
  mocks.reportOpsMonitorLiveness.mockResolvedValue(null);
  mocks.reportWorkerHeartbeat.mockResolvedValue(null);
  mocks.restartIbkrGatewayOnVps.mockResolvedValue(successfulRestartResult());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("isCompetingSessionHistoricalDataError", () => {
  it("matches only the code-162 text that mentions a different IP address", () => {
    expect(isCompetingSessionHistoricalDataError(competingSessionHistoricalError)).toBe(true);
    expect(isCompetingSessionHistoricalDataError("Historical data error for SPY (code 162): API scanner subscription cancelled")).toBe(false);
    expect(isCompetingSessionHistoricalDataError("Historical data error for SPY (code 321): connected from a different IP address")).toBe(false);
    expect(isCompetingSessionHistoricalDataError(historicalTimeoutError)).toBe(false);
  });
});

describe("checkHistoricalData", () => {
  it("is healthy when the probe bar request resolves, even with no bar returned", async () => {
    const connection = createFakeConnection();
    await expect(checkHistoricalData(connection)).resolves.toEqual({ healthy: true, errorMessage: null });
    expect(mocks.lookupLatestDailyBar).toHaveBeenCalledWith(connection, "SPY", 999_001);
  });

  it("surfaces the real error message of a failed probe", async () => {
    mocks.lookupLatestDailyBar.mockRejectedValue(new Error(historicalTimeoutError));
    await expect(checkHistoricalData(createFakeConnection())).resolves.toEqual({ healthy: false, errorMessage: historicalTimeoutError });
  });

  it("stringifies a non-Error rejection", async () => {
    mocks.lookupLatestDailyBar.mockRejectedValue("plain text failure");
    await expect(checkHistoricalData(createFakeConnection())).resolves.toEqual({ healthy: false, errorMessage: "plain text failure" });
  });
});

describe("findOtherRunningJobName", () => {
  it("returns the newest other running job and looks back two hours excluding the health check itself", async () => {
    mocks.jobRunsDatabaseState.otherRunningJobRow = { job_name: "option_chain_capture" };
    await expect(findOtherRunningJobName()).resolves.toBe("option_chain_capture");
    expect(mocks.jobRunsDatabaseState.queriedTables).toEqual(["job_runs"]);
    expect(mocks.jobRunsDatabaseState.whereCalls[0]).toEqual([{ status: "running" }]);
    expect(mocks.jobRunsDatabaseState.whereNotCalls[0]).toEqual([{ job_name: "ibkr_health_check" }]);
    const lookbackCall = mocks.jobRunsDatabaseState.whereCalls[1]!;
    expect(lookbackCall[0]).toBe("started_at");
    expect(lookbackCall[1]).toBe(">");
    expect((lookbackCall[2] as Date).toISOString()).toBe(new Date(fixedNow.getTime() - 2 * 60 * 60 * 1000).toISOString());
  });

  it("returns null when nothing else is running", async () => {
    await expect(findOtherRunningJobName()).resolves.toBeNull();
  });
});

describe("previousHealthCheckProbeFailed", () => {
  it("skips the run that is currently in progress when looking for the previous run", async () => {
    await previousHealthCheckProbeFailed();
    expect(mocks.jobRunsDatabaseState.whereCalls[0]).toEqual([{ job_name: "ibkr_health_check" }]);
    expect(mocks.jobRunsDatabaseState.whereNotCalls[0]).toEqual([{ status: "running" }]);
  });

  it("is false when there is no previous run", async () => {
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(false);
  });

  it("is true when the previous run recorded probe.failed", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(true);
  });

  it("is true when the previous run failed with a reqHistoricalData error message and left no details", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: null, error_message: "IBKR Gateway x and restart didn't recover reqHistoricalData failed" };
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(true);
  });

  it("is false when the previous run was clean, its probe flag was false, or its error was unrelated", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: false } }, error_message: null };
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(false);
    mocks.jobRunsDatabaseState.previousRunRow = { details: {}, error_message: "iorio-worker.service was inactive" };
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(false);
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: "yes" } }, error_message: null };
    await expect(previousHealthCheckProbeFailed()).resolves.toBe(false);
  });
});

describe("captureFarmStatusMessages and tryConnect", () => {
  it("records only reqId -1 broadcast errors, stamped with the current time", () => {
    const connection = createFakeConnection();
    const captured: Array<{ at: string; code: number; message: string }> = [];
    captureFarmStatusMessages(connection, captured);
    connection.emitter.emit(EventName.error, new Error("HMDS data farm connection is broken:ushmds"), 2105, -1);
    connection.emitter.emit(EventName.error, new Error("real request error"), 200, 42);
    expect(captured).toEqual([{ at: fixedNow.toISOString(), code: 2105, message: "HMDS data farm connection is broken:ushmds" }]);
  });

  it("returns null instead of throwing when the connection cannot be opened", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("tunnel refused"));
    await expect(tryConnect([])).resolves.toBeNull();
  });

  it("returns the connection with farm capture attached to the caller's buffer", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    const buffer: Array<{ at: string; code: number; message: string }> = [];
    await expect(tryConnect(buffer)).resolves.toBe(connection);
    connection.emitter.emit(EventName.error, new Error("farm ok"), 2106, -1);
    expect(buffer).toHaveLength(1);
  });
});

describe("reconciliation helpers", () => {
  it("formats every discrepancy as a bullet under a counted headline", () => {
    expect(reconciliationNotifyMessage(["AAPL missing leg", "MSFT extra leg"])).toBe(
      "⚠️ Position reconciliation: 2 discrepancy(ies) between IBKR and local data —\n• AAPL missing leg\n• MSFT extra leg",
    );
  });

  it("passes the connection's ib to the check and returns its problems", async () => {
    const connection = createFakeConnection();
    mocks.checkPositionReconciliation.mockResolvedValue(["a"]);
    await expect(runReconciliationSafely(connection)).resolves.toEqual(["a"]);
    expect(mocks.checkPositionReconciliation).toHaveBeenCalledWith(connection.ib);
  });

  it("turns a thrown Error or a non-Error value into a finding instead of throwing", async () => {
    mocks.checkPositionReconciliation.mockRejectedValueOnce(new Error("query exploded"));
    await expect(runReconciliationSafely(createFakeConnection())).resolves.toEqual(["Reconciliation check itself failed: query exploded"]);
    mocks.checkPositionReconciliation.mockRejectedValueOnce("string failure");
    await expect(runReconciliationSafely(createFakeConnection())).resolves.toEqual(["Reconciliation check itself failed: string failure"]);
  });
});

describe("runIbkrHealthCheckJob: healthy path", () => {
  it("runs everything once, sends nothing, and records details", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);

    await runIbkrHealthCheckJob({ triggeredBy: "scheduler" });

    expect(mocks.runJobCalls).toEqual([
      { jobName: "ibkr_health_check", options: { failureAlertReminderIntervalMs: 3_600_000, triggeredBy: "scheduler", triggeredByUserId: undefined } },
    ]);
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    const output = lastJobOutput();
    expect(output.notify).toBeUndefined();
    expect(output.details).toEqual({
      output: "healthy",
      probe: { failed: false, reason: null, restarted: false },
      worker: { active: true, restarted: false },
      reconciliationProblems: [],
      competingLiveSession: "flowing",
      daySignalsProblem: null,
      opsMonitorProblem: null,
      workerHeartbeatProblem: null,
      farmStatusMessages: [],
    });
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: true, restartedJustNow: false });
  });

  it("passes the manual trigger and user id through to runJob", async () => {
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
    await runIbkrHealthCheckJob({ triggeredBy: "manual", triggeredByUserId: "user-1", allowGatewayRestart: false });
    expect(mocks.runJobCalls[0]!.options).toMatchObject({ triggeredBy: "manual", triggeredByUserId: "user-1" });
  });

  it("probes the worker with the worker key decoded from base64 and the tunnel ssh settings", async () => {
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
    await runIbkrHealthCheckJob();
    const workerCallOptions = mocks.checkWorkerOnVps.mock.calls[0]![0];
    expect(workerCallOptions).toMatchObject({ sshHost: "vps.example", sshPort: 2222, sshUsername: "healthcheck" });
    expect(workerCallOptions.sshPrivateKey.toString()).toBe("worker-key");
  });

  it("probes live data with SPY on request ids 999001 (historical) and 999002 (live session)", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    await runIbkrHealthCheckJob();
    expect(mocks.lookupLatestDailyBar).toHaveBeenCalledWith(connection, "SPY", 999_001);
    expect(mocks.probeCompetingLiveSession).toHaveBeenCalledWith(connection.ib, 999_002, "SPY");
  });

  it("fails with a clear message when the worker ssh key variable is missing, and still checks the heartbeat as unknown", async () => {
    vi.stubEnv("IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64", "");
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("Missing required environment variable: IORIO_WORKER_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64");
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: null, restartedJustNow: false });
  });
});

describe("runIbkrHealthCheckJob: handshake failure", () => {
  it("restarts the Gateway with the healthcheck key, reconnects, re-probes and announces the recovery", async () => {
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockRejectedValueOnce(new Error("handshake timeout")).mockResolvedValueOnce(reconnected);
    mocks.restartIbkrGatewayOnVps.mockResolvedValue(successfulRestartResult("GATEWAY_CONTROL_RESULT=recovered\n"));

    await runIbkrHealthCheckJob();

    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
    const restartOptions = mocks.restartIbkrGatewayOnVps.mock.calls[0]![0];
    expect(restartOptions).toMatchObject({ sshHost: "vps.example", sshPort: 2222, sshUsername: "healthcheck" });
    expect(restartOptions.sshPrivateKey.toString()).toBe("gateway-key");
    expect(mocks.lookupLatestDailyBar).toHaveBeenCalledWith(reconnected, "SPY", 999_001);
    const output = lastJobOutput();
    expect(output.notify).toBe("⚠️ IBKR Gateway was unreachable — restarted, recovery confirmed via a real handshake and a reqHistoricalData probe.");
    expect(output.details.output).toBe("unhealthy (was unreachable), restarted, recovered — restart script output: GATEWAY_CONTROL_RESULT=recovered");
    expect(mocks.checkPositionReconciliation).toHaveBeenCalledWith(reconnected.ib);
    expect(reconnected.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not restart from the manual check while the market is open, and reports it as a failure", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("handshake timeout"));
    await expect(runIbkrHealthCheckJob({ allowGatewayRestart: false })).rejects.toThrow(
      "IBKR Gateway was unreachable — not restarted: restarts are not allowed from the manual check while the market is open (the scheduled check will handle it).",
    );
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.checkWorkerOnVps).not.toHaveBeenCalled();
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: null, restartedJustNow: false });
  });

  it("fails when the restart does not bring the handshake back and includes the exit code and trimmed script output", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("still down"));
    mocks.restartIbkrGatewayOnVps.mockResolvedValue({ exitCode: 3, output: "  GATEWAY_CONTROL_RESULT=restart_failed\n" });
    await expect(runIbkrHealthCheckJob()).rejects.toThrow(
      "IBKR Gateway was unreachable and restart didn't recover it (script exit 3): GATEWAY_CONTROL_RESULT=restart_failed",
    );
    expect(mocks.checkWorkerOnVps).not.toHaveBeenCalled();
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: null, restartedJustNow: false });
  });

  it("uses the manual-login headline on the live Gateway when the script reports needs_manual_login", async () => {
    mocks.environment.ibkrTradingMode = "live";
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("down"));
    mocks.restartIbkrGatewayOnVps.mockResolvedValue({ exitCode: 1, output: "GATEWAY_CONTROL_RESULT=needs_manual_login\n" });
    const error = await runIbkrHealthCheckJob().catch((caught: Error) => caught);
    expect((error as Error).message).toContain("IBKR live Gateway is not logged in and needs a manual login");
    expect((error as Error).message).not.toContain("restart didn't recover it");
    expect((error as Error).message).toContain("(script exit 1): GATEWAY_CONTROL_RESULT=needs_manual_login");
  });

  it("keeps the generic diagnosis on paper even when the script reports needs_manual_login", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("down"));
    mocks.restartIbkrGatewayOnVps.mockResolvedValue({ exitCode: 1, output: "GATEWAY_CONTROL_RESULT=needs_manual_login\n" });
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("restart didn't recover it");
  });

  it("propagates a failure of the restart script itself", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("down"));
    mocks.restartIbkrGatewayOnVps.mockRejectedValue(new Error("Timed out running IBKR Gateway restart script on VPS."));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("Timed out running IBKR Gateway restart script on VPS.");
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
  });

  it("refuses to restart when the gateway ssh key variable is missing", async () => {
    vi.stubEnv("IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64", "");
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("down"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("Missing required environment variable: IBKR_HEALTHCHECK_SSH_PRIVATE_KEY_BASE64");
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
  });

  it("fails and disconnects when the restart recovers the handshake but historical data is still broken", async () => {
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(reconnected);
    mocks.lookupLatestDailyBar.mockRejectedValue(new Error(historicalTimeoutError));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow(
      `IBKR Gateway was unreachable and restart didn't recover reqHistoricalData either (${historicalTimeoutError}) (script exit 0): GATEWAY_CONTROL_RESULT=recovered`,
    );
    expect(reconnected.disconnect).toHaveBeenCalledTimes(1);
  });

  it("notifies instead of failing when the post-restart historical-data failure is a competing session", async () => {
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(reconnected);
    mocks.lookupLatestDailyBar.mockRejectedValue(new Error(competingSessionHistoricalError));

    await runIbkrHealthCheckJob();

    const output = lastJobOutput();
    expect(output.notify).toContain("IBKR Gateway was unreachable — restarted, handshake recovered, but reqHistoricalData is still blocked");
    expect(output.notify).toContain("a restart won't fix it");
    expect(output.details.output).toBe(
      "unhealthy (was unreachable), restarted — handshake recovered, but historical data is still blocked by a competing session (unrelated to the restart)",
    );
    expect(reconnected.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.checkWorkerOnVps).toHaveBeenCalledTimes(1);
  });

  it("captures farm status broadcasts from both the first and the post-restart connection", async () => {
    const firstConnection = createFakeConnection();
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValueOnce(firstConnection).mockResolvedValueOnce(reconnected);
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };
    mocks.lookupLatestDailyBar
      .mockImplementationOnce(async () => {
        firstConnection.emitter.emit(EventName.error, new Error("HMDS data farm connection is broken"), 2103, -1);
        throw new Error(historicalTimeoutError);
      })
      .mockImplementationOnce(async () => {
        reconnected.emitter.emit(EventName.error, new Error("HMDS data farm connection is OK"), 2106, -1);
        reconnected.emitter.emit(EventName.error, new Error("ignored request error"), 162, 7);
        return null;
      });

    await runIbkrHealthCheckJob();

    expect(lastJobOutput().details.farmStatusMessages).toEqual([
      { at: fixedNow.toISOString(), code: 2103, message: "HMDS data farm connection is broken" },
      { at: fixedNow.toISOString(), code: 2106, message: "HMDS data farm connection is OK" },
    ]);
  });
});

describe("runIbkrHealthCheckJob: historical data probe failures with a healthy handshake", () => {
  beforeEach(() => {
    mocks.lookupLatestDailyBar.mockRejectedValue(new Error(historicalTimeoutError));
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
  });

  it("does not restart for a competing-session error and does not even look at the job table", async () => {
    mocks.lookupLatestDailyBar.mockRejectedValue(new Error(competingSessionHistoricalError));
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.jobRunsDatabaseState.queriedTables).toEqual([]);
    const output = lastJobOutput();
    expect(output.notify).toContain("⚠️ Historical data is currently blocked: IBKR code 162");
    expect(output.details.probe).toEqual({ failed: false, reason: null, restarted: false });
    expect(output.details.output).toBe("healthy");
  });

  it("does not restart while another job is running, and names it in the details", async () => {
    mocks.jobRunsDatabaseState.otherRunningJobRow = { job_name: "option_chain_capture" };
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    const output = lastJobOutput();
    expect(output.details.probe).toEqual({ failed: true, reason: historicalTimeoutError, restarted: false });
    expect(output.details.output).toBe(
      `healthy handshake; reqHistoricalData probe failed (${historicalTimeoutError}) while option_chain_capture is running — not restarting under load`,
    );
    expect(output.notify).toBeUndefined();
  });

  it("does not restart on the first failure and waits for the next run to confirm", async () => {
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    const output = lastJobOutput();
    expect(output.details.probe).toEqual({ failed: true, reason: historicalTimeoutError, restarted: false });
    expect(output.details.output).toBe(
      `healthy handshake; reqHistoricalData probe failed once (${historicalTimeoutError}) — no restart until it fails on the next run too`,
    );
    expect(output.notify).toBeUndefined();
  });

  it("restarts on the second consecutive failure with no other job running, disconnecting the old connection first", async () => {
    const firstConnection = createFakeConnection();
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockReset();
    mocks.connectToIbkrGateway.mockResolvedValueOnce(firstConnection).mockResolvedValueOnce(reconnected);
    mocks.lookupLatestDailyBar.mockReset();
    mocks.lookupLatestDailyBar.mockRejectedValueOnce(new Error(historicalTimeoutError)).mockResolvedValueOnce(null);
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };

    await runIbkrHealthCheckJob();

    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
    expect(firstConnection.disconnect).toHaveBeenCalledTimes(1);
    const output = lastJobOutput();
    expect(output.details.probe).toEqual({ failed: true, reason: historicalTimeoutError, restarted: true });
    expect(output.details.output).toBe(
      `unhealthy (handshake succeeded but reqHistoricalData failed on two consecutive runs (${historicalTimeoutError})), restarted, recovered — restart script output: GATEWAY_CONTROL_RESULT=recovered`,
    );
    expect(output.notify).toContain("restarted, recovery confirmed");
    expect(reconnected.disconnect).toHaveBeenCalledTimes(1);
  });

  it("also treats a previous run that failed with a reqHistoricalData error message as a prior failure", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: null, error_message: "restart didn't recover reqHistoricalData failed again" };
    mocks.lookupLatestDailyBar.mockReset();
    mocks.lookupLatestDailyBar.mockRejectedValueOnce(new Error(historicalTimeoutError)).mockResolvedValueOnce(null);
    mocks.connectToIbkrGateway.mockReset();
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
  });

  it("never restarts from the manual check even after two consecutive failures", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };
    await expect(runIbkrHealthCheckJob({ allowGatewayRestart: false })).rejects.toThrow(
      `not restarted: restarts are not allowed from the manual check while the market is open`,
    );
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
  });

  it("fails when the scheduled restart does not fix historical data", async () => {
    mocks.jobRunsDatabaseState.previousRunRow = { details: { probe: { failed: true } }, error_message: null };
    await expect(runIbkrHealthCheckJob()).rejects.toThrow(
      `IBKR Gateway handshake succeeded but reqHistoricalData failed on two consecutive runs (${historicalTimeoutError}) and restart didn't recover reqHistoricalData either (${historicalTimeoutError})`,
    );
    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
  });
});

describe("runIbkrHealthCheckJob: worker service", () => {
  it("notifies when the worker was inactive and the restart recovered it", async () => {
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
    mocks.checkWorkerOnVps.mockResolvedValue({ active: true, restarted: true, output: "restarted" });
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().notify).toBe("⚠️ iorio-worker.service was inactive — restarted successfully, now active.");
    expect(lastJobOutput().details.worker).toEqual({ active: true, restarted: true });
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: true, restartedJustNow: true });
  });

  it("fails and disconnects when the worker is still inactive after its restart", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    mocks.checkWorkerOnVps.mockResolvedValue({ active: false, restarted: true, output: "  failed to start\n" });
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("iorio-worker.service was inactive and the restart didn't recover it: failed to start");
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.probeCompetingLiveSession).not.toHaveBeenCalled();
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledWith({ serviceActive: false, restartedJustNow: true });
  });
});

describe("runIbkrHealthCheckJob: a step that throws after the Gateway connection is open", () => {
  it("closes the connection when the VPS worker check throws", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    mocks.checkWorkerOnVps.mockRejectedValue(new Error("ssh to the VPS timed out"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("ssh to the VPS timed out");
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when the competing-session probe throws", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    mocks.probeCompetingLiveSession.mockRejectedValue(new Error("probe exploded"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("probe exploded");
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("closes the connection when the reconciliation step throws unexpectedly, still only once", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    mocks.reportCompetingLiveSession.mockRejectedValue(new Error("not expected to propagate"));
    await runIbkrHealthCheckJob().catch(() => {});
    expect(connection.disconnect.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("closes only the replacement when a restart reconnects and a later step throws, the first having been closed before the restart", async () => {
    const first = createFakeConnection();
    const replacement = createFakeConnection();
    mocks.connectToIbkrGateway.mockReset();
    mocks.connectToIbkrGateway.mockRejectedValueOnce(new Error("handshake refused")).mockResolvedValue(replacement);
    mocks.checkWorkerOnVps.mockRejectedValue(new Error("worker check failed"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("worker check failed");
    expect(replacement.disconnect).toHaveBeenCalledTimes(1);
    expect(first.disconnect).not.toHaveBeenCalled();
  });
});

describe("runIbkrHealthCheckJob: competing live session (IBKR 10197)", () => {
  beforeEach(() => {
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
  });

  it("restarts once, re-probes on request id 999003, and announces the recovery when the first alert was not already cleared", async () => {
    const firstConnection = createFakeConnection();
    const reconnected = createFakeConnection();
    mocks.connectToIbkrGateway.mockReset();
    mocks.connectToIbkrGateway.mockResolvedValueOnce(firstConnection).mockResolvedValueOnce(reconnected);
    mocks.probeCompetingLiveSession.mockResolvedValueOnce("blocked").mockResolvedValueOnce("flowing");

    await runIbkrHealthCheckJob();

    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
    expect(firstConnection.disconnect).toHaveBeenCalledTimes(1);
    expect(mocks.probeCompetingLiveSession).toHaveBeenNthCalledWith(1, firstConnection.ib, 999_002, "SPY");
    expect(mocks.probeCompetingLiveSession).toHaveBeenNthCalledWith(2, reconnected.ib, 999_003, "SPY");
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith("flowing", blockedAfterReloginMessage);
    const output = lastJobOutput();
    expect(output.details.competingLiveSession).toBe("flowing");
    expect(output.notify).toBe(
      [
        "⚠️ IBKR Gateway was refused real-time market data (IBKR 10197) — restarted, recovery confirmed via a real handshake and a reqHistoricalData probe.",
        "✅ Real-time market data is flowing again after the Gateway re-login (IBKR 10197: stale session).",
      ].join("\n\n"),
    );
    expect(reconnected.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not add its own recovery line when the alert module already sent the 'flowing again' message", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValueOnce("blocked").mockResolvedValueOnce("flowing");
    mocks.reportCompetingLiveSession.mockResolvedValue(true);
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().notify).not.toContain("✅ Real-time market data is flowing again after the Gateway re-login");
    expect(lastJobOutput().notify).toContain("was refused real-time market data (IBKR 10197)");
  });

  it("reports the episode as blocked after relogin when 10197 survives the restart", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValue("blocked");
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).toHaveBeenCalledTimes(1);
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith("blocked", blockedAfterReloginMessage);
    expect(lastJobOutput().notify).not.toContain("✅");
    expect(lastJobOutput().details.competingLiveSession).toBe("blocked");
  });

  it("does not restart again when this episode already survived a restart", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValue("blocked");
    mocks.competingLiveSessionSurvivedRestart.mockResolvedValue(true);
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.jobRunsDatabaseState.queriedTables).toEqual([]);
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith("blocked", blockedAfterReloginMessage);
  });

  it("defers the restart with an explanatory alert when the manual check may not restart, without querying other jobs", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValue("blocked");
    await runIbkrHealthCheckJob({ allowGatewayRestart: false });
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.jobRunsDatabaseState.queriedTables).toEqual([]);
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith(
      "blocked",
      blockedRestartDeferredMessage("restarts aren't allowed from the manual check while the market is open; the scheduled check will restart it"),
    );
  });

  it("defers the restart and names the other running job", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValue("blocked");
    mocks.jobRunsDatabaseState.otherRunningJobRow = { job_name: "daily_market_data" };
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith(
      "blocked",
      blockedRestartDeferredMessage("daily_market_data is running; the next check restarts the Gateway once it finishes"),
    );
  });

  it("leaves the alert state untouched when the probe is inconclusive", async () => {
    mocks.probeCompetingLiveSession.mockResolvedValue("unknown");
    await runIbkrHealthCheckJob();
    expect(mocks.restartIbkrGatewayOnVps).not.toHaveBeenCalled();
    expect(mocks.reportCompetingLiveSession).toHaveBeenCalledWith("unknown", blockedAfterReloginMessage);
    expect(mocks.competingLiveSessionSurvivedRestart).not.toHaveBeenCalled();
    expect(lastJobOutput().details.competingLiveSession).toBe("unknown");
  });

  it("does not consult the survived-restart state when data is flowing", async () => {
    await runIbkrHealthCheckJob();
    expect(mocks.competingLiveSessionSurvivedRestart).not.toHaveBeenCalled();
  });

  it("contains a failing alert module: warns, keeps the job green, and still announces its own recovery line", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.probeCompetingLiveSession.mockResolvedValueOnce("blocked").mockResolvedValueOnce("flowing");
    mocks.reportCompetingLiveSession.mockRejectedValue(new Error("telegram down"));
    await runIbkrHealthCheckJob();
    expect(warning).toHaveBeenCalledWith("competing live session alert failed: telegram down");
    expect(lastJobOutput().notify).toContain("✅ Real-time market data is flowing again after the Gateway re-login");
    warning.mockRestore();
  });

  it("fails the job when the 10197 restart cannot reconnect", async () => {
    mocks.connectToIbkrGateway.mockReset();
    mocks.connectToIbkrGateway.mockResolvedValueOnce(createFakeConnection()).mockRejectedValueOnce(new Error("gone"));
    mocks.probeCompetingLiveSession.mockResolvedValue("blocked");
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("IBKR Gateway was refused real-time market data (IBKR 10197) and restart didn't recover it");
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
  });
});

describe("runIbkrHealthCheckJob: reconciliation, liveness and notify assembly", () => {
  beforeEach(() => {
    mocks.connectToIbkrGateway.mockResolvedValue(createFakeConnection());
  });

  it("includes reconciliation problems in the notify text and the details", async () => {
    mocks.checkPositionReconciliation.mockResolvedValue(["AAPL: leg missing", "MSFT: quantity differs"]);
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().notify).toBe("⚠️ Position reconciliation: 2 discrepancy(ies) between IBKR and local data —\n• AAPL: leg missing\n• MSFT: quantity differs");
    expect(lastJobOutput().details.reconciliationProblems).toEqual(["AAPL: leg missing", "MSFT: quantity differs"]);
  });

  it("contains a throwing reconciliation as a finding and still disconnects and succeeds", async () => {
    const connection = createFakeConnection();
    mocks.connectToIbkrGateway.mockResolvedValue(connection);
    mocks.checkPositionReconciliation.mockRejectedValue(new Error("db is down"));
    await runIbkrHealthCheckJob();
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(lastJobOutput().details.reconciliationProblems).toEqual(["Reconciliation check itself failed: db is down"]);
    expect(lastJobOutput().notify).toContain("1 discrepancy(ies)");
  });

  it("joins several notifications with a blank line in the order they happened", async () => {
    mocks.connectToIbkrGateway.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(createFakeConnection());
    mocks.checkWorkerOnVps.mockResolvedValue({ active: true, restarted: true, output: "" });
    mocks.checkPositionReconciliation.mockResolvedValue(["x"]);
    await runIbkrHealthCheckJob();
    const sections = lastJobOutput().notify!.split("\n\n");
    expect(sections).toHaveLength(3);
    expect(sections[0]).toContain("was unreachable — restarted");
    expect(sections[1]).toBe("⚠️ iorio-worker.service was inactive — restarted successfully, now active.");
    expect(sections[2]).toContain("Position reconciliation");
  });

  it("reports liveness problems in the details without failing, and a throwing liveness check as its own finding", async () => {
    mocks.reportDaySignalsLoopLiveness.mockResolvedValue("Day Signals loop stalled");
    mocks.reportOpsMonitorLiveness.mockRejectedValue(new Error("worker_health unreadable"));
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().details.daySignalsProblem).toBe("Day Signals loop stalled");
    expect(lastJobOutput().details.opsMonitorProblem).toBe("Ops monitor liveness check itself failed: worker_health unreadable");
    expect(lastJobOutput().notify).toBeUndefined();
  });

  it("runs the liveness checks before touching IBKR so an outage cannot blind them", async () => {
    mocks.connectToIbkrGateway.mockRejectedValue(new Error("down"));
    mocks.restartIbkrGatewayOnVps.mockRejectedValue(new Error("vps unreachable"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("vps unreachable");
    expect(mocks.reportDaySignalsLoopLiveness).toHaveBeenCalledTimes(1);
    expect(mocks.reportOpsMonitorLiveness).toHaveBeenCalledTimes(1);
    expect(mocks.reportDaySignalsLoopLiveness.mock.invocationCallOrder[0]!).toBeLessThan(mocks.connectToIbkrGateway.mock.invocationCallOrder[0]!);
  });

  it("records a heartbeat problem and a throwing heartbeat check as details, not failures", async () => {
    mocks.reportWorkerHeartbeat.mockResolvedValueOnce("Worker heartbeat is 12 minutes old");
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().details.workerHeartbeatProblem).toBe("Worker heartbeat is 12 minutes old");

    mocks.reportWorkerHeartbeat.mockRejectedValueOnce(new Error("query failed"));
    await runIbkrHealthCheckJob();
    expect(lastJobOutput().details.workerHeartbeatProblem).toBe("Worker heartbeat check itself failed: query failed");
  });

  it("checks the worker heartbeat exactly once per run on both success and failure paths", async () => {
    await runIbkrHealthCheckJob();
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
    mocks.reportWorkerHeartbeat.mockClear();
    mocks.checkWorkerOnVps.mockRejectedValue(new Error("ssh failed"));
    await expect(runIbkrHealthCheckJob()).rejects.toThrow("ssh failed");
    expect(mocks.reportWorkerHeartbeat).toHaveBeenCalledTimes(1);
  });
});
