import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeStream extends EventEmitter {
  stderr: EventEmitter;
}

const sshHarness = vi.hoisted(() => ({
  clients: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    exec: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    emit: (eventName: string, ...args: unknown[]) => boolean;
  }>,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeSshClient extends NodeEventEmitter {
    connect = vi.fn();
    exec = vi.fn();
    end = vi.fn();
    constructor() {
      super();
      sshHarness.clients.push(this as unknown as (typeof sshHarness.clients)[number]);
    }
  }
  return { Client: FakeSshClient };
});

const { runForcedCommandSsh } = await import("./runForcedCommandSsh.js");

const baseOptions = {
  sshHost: "vps.example",
  sshPort: 2222,
  sshUsername: "healthcheck",
  sshPrivateKey: Buffer.from("key"),
  timeoutMs: 30_000,
  timeoutMessage: "Timed out running the script.",
};

function latestClient() {
  return sshHarness.clients.at(-1)!;
}

function createStream(): FakeStream {
  return Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
}

/** Makes the next exec() hand the stream to the callback, as ssh2 does once the channel is open. */
function openChannel(stream: FakeStream) {
  latestClient().exec.mockImplementation((_command: string, callback: (error: Error | undefined, stream: FakeStream) => void) => callback(undefined, stream));
  latestClient().emit("ready");
}

beforeEach(() => {
  vi.useFakeTimers();
  sshHarness.clients.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("runForcedCommandSsh", () => {
  it("connects with the given host, port, user and key and a 15 s ready timeout", () => {
    void runForcedCommandSsh(baseOptions).catch(() => {});
    expect(latestClient().connect).toHaveBeenCalledWith({ host: "vps.example", port: 2222, username: "healthcheck", privateKey: baseOptions.sshPrivateKey, readyTimeout: 15_000 });
  });

  it("runs the forced-command placeholder once the connection is ready", () => {
    void runForcedCommandSsh(baseOptions).catch(() => {});
    openChannel(createStream());
    expect(latestClient().exec).toHaveBeenCalledTimes(1);
    expect(latestClient().exec.mock.calls[0]![0]).toBe("forced-command");
  });

  it("resolves with the exit code and stdout and stderr interleaved in arrival order, then ends the client", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const stream = createStream();
    openChannel(stream);
    stream.emit("data", Buffer.from("restarting container\n"));
    stream.stderr.emit("data", Buffer.from("warning: slow\n"));
    stream.emit("data", Buffer.from("GATEWAY_CONTROL_RESULT=recovered\n"));
    stream.emit("close", 0);
    await expect(result).resolves.toEqual({ exitCode: 0, output: "restarting container\nwarning: slow\nGATEWAY_CONTROL_RESULT=recovered\n" });
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });

  it("passes a non-zero exit code through as a result, not an error", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const stream = createStream();
    openChannel(stream);
    stream.emit("close", 3);
    await expect(result).resolves.toEqual({ exitCode: 3, output: "" });
  });

  it("passes a null exit code (killed by signal) through", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const stream = createStream();
    openChannel(stream);
    stream.emit("close", null);
    await expect(result).resolves.toEqual({ exitCode: null, output: "" });
  });

  it("rejects and ends the client when exec fails", async () => {
    const result = runForcedCommandSsh(baseOptions);
    latestClient().exec.mockImplementation((_command: string, callback: (error: Error) => void) => callback(new Error("channel open failure")));
    latestClient().emit("ready");
    await expect(result).rejects.toThrow("channel open failure");
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });

  it("rejects when the ssh connection errors", async () => {
    const result = runForcedCommandSsh(baseOptions);
    latestClient().emit("error", new Error("All configured authentication methods failed"));
    await expect(result).rejects.toThrow("All configured authentication methods failed");
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });

  it("gives up with the configured message after the timeout and ends the client, but not before", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const outcome = result.catch((error: Error) => error.message);
    openChannel(createStream());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(latestClient().end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("Timed out running the script.");
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });

  it("ignores a late close after the timeout already rejected, and does not end the client twice", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const outcome = result.catch((error: Error) => error.message);
    const stream = createStream();
    openChannel(stream);
    await vi.advanceTimersByTimeAsync(30_000);
    stream.emit("close", 0);
    await expect(outcome).resolves.toBe("Timed out running the script.");
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });

  it("clears the timeout timer once settled", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const stream = createStream();
    openChannel(stream);
    stream.emit("close", 0);
    await result;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles only once when an error follows a successful close", async () => {
    const result = runForcedCommandSsh(baseOptions);
    const stream = createStream();
    openChannel(stream);
    stream.emit("close", 0);
    latestClient().emit("error", new Error("late socket error"));
    await expect(result).resolves.toEqual({ exitCode: 0, output: "" });
    expect(latestClient().end).toHaveBeenCalledTimes(1);
  });
});
