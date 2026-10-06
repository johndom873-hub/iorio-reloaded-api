import { beforeEach, describe, expect, it, vi } from "vitest";

const runForcedCommandSshMock = vi.hoisted(() => vi.fn());
vi.mock("./runForcedCommandSsh.js", () => ({ runForcedCommandSsh: runForcedCommandSshMock }));

const { checkWorkerOnVps } = await import("./checkWorkerOnVps.js");

const options = { sshHost: "vps.example", sshPort: 2222, sshUsername: "workercheck", sshPrivateKey: Buffer.from("key") };

function scriptPrints(output: string) {
  runForcedCommandSshMock.mockResolvedValue({ exitCode: 0, output });
}

beforeEach(() => {
  runForcedCommandSshMock.mockReset();
});

describe("checkWorkerOnVps", () => {
  it("calls the forced-command ssh with a 30 s timeout and the worker-specific timeout message", async () => {
    scriptPrints("worker status: active\n");
    await checkWorkerOnVps(options);
    expect(runForcedCommandSshMock).toHaveBeenCalledWith({ ...options, timeoutMs: 30_000, timeoutMessage: "Timed out running iorio-worker.service check on VPS." });
  });

  it("reports an already active worker as active and not restarted", async () => {
    scriptPrints("worker status: active\n");
    await expect(checkWorkerOnVps(options)).resolves.toEqual({ active: true, restarted: false, output: "worker status: active\n" });
  });

  it("reports an inactive worker the script did not restart as inactive", async () => {
    scriptPrints("worker status: inactive\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: false, restarted: false });
  });

  it("reports a restart that brought the worker back as restarted and active", async () => {
    scriptPrints("worker status: inactive\nrestarting iorio-worker.service\nworker status after restart: active\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: true, restarted: true });
  });

  it("reports a restart that failed as restarted and not active, reading the post-restart status not the first one", async () => {
    scriptPrints("worker status: active-looking-prefix\nrestarting iorio-worker.service\nworker status after restart: failed\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: false, restarted: true });
  });

  it("does not treat the pre-restart 'active' line as success when a restart happened and no post-restart status was printed", async () => {
    scriptPrints("worker status: active\nrestarting iorio-worker.service\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: false, restarted: true });
  });

  it("treats unparseable output as inactive and not restarted", async () => {
    scriptPrints("something unexpected\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: false, restarted: false });
  });

  it("does not count 'activating' or 'active (exiting)' style text as active", async () => {
    scriptPrints("worker status: activating\n");
    await expect(checkWorkerOnVps(options)).resolves.toMatchObject({ active: false });
  });

  it("propagates an ssh failure", async () => {
    runForcedCommandSshMock.mockRejectedValue(new Error("Timed out running iorio-worker.service check on VPS."));
    await expect(checkWorkerOnVps(options)).rejects.toThrow("Timed out running iorio-worker.service check on VPS.");
  });
});
