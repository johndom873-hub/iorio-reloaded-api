import { beforeEach, describe, expect, it, vi } from "vitest";

const runForcedCommandSshMock = vi.hoisted(() => vi.fn());
vi.mock("./runForcedCommandSsh.js", () => ({ runForcedCommandSsh: runForcedCommandSshMock }));

const { restartIbkrGatewayOnVps } = await import("./restartIbkrGatewayOnVps.js");

const options = { sshHost: "vps.example", sshPort: 2222, sshUsername: "healthcheck", sshPrivateKey: Buffer.from("key") };

beforeEach(() => {
  runForcedCommandSshMock.mockReset();
});

describe("restartIbkrGatewayOnVps", () => {
  it("runs the forced-command ssh with the caller's connection settings, a 7 minute timeout and a restart-specific timeout message", async () => {
    runForcedCommandSshMock.mockResolvedValue({ exitCode: 0, output: "GATEWAY_CONTROL_RESULT=recovered\n" });
    await restartIbkrGatewayOnVps(options);
    expect(runForcedCommandSshMock).toHaveBeenCalledTimes(1);
    expect(runForcedCommandSshMock).toHaveBeenCalledWith({ ...options, timeoutMs: 420_000, timeoutMessage: "Timed out running IBKR Gateway restart script on VPS." });
  });

  it("returns the script's exit code and output unchanged", async () => {
    runForcedCommandSshMock.mockResolvedValue({ exitCode: 2, output: "boom\n" });
    await expect(restartIbkrGatewayOnVps(options)).resolves.toEqual({ exitCode: 2, output: "boom\n" });
  });

  it("propagates an ssh failure", async () => {
    runForcedCommandSshMock.mockRejectedValue(new Error("Timed out running IBKR Gateway restart script on VPS."));
    await expect(restartIbkrGatewayOnVps(options)).rejects.toThrow("Timed out running IBKR Gateway restart script on VPS.");
  });
});
