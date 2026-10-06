import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ForwardOutCallback = (error: Error | undefined, stream?: FakeStream) => void;
type ConnectionHandler = (socket: FakeSocket) => void;

interface FakeStream extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
}

interface FakeSocket extends EventEmitter {
  remoteAddress?: string;
  remotePort?: number;
  destroy: ReturnType<typeof vi.fn>;
  pipe: ReturnType<typeof vi.fn>;
}

interface FakeLocalServer extends EventEmitter {
  listen: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  connectionHandler: ConnectionHandler;
}

const tunnelHarness = vi.hoisted(() => ({
  sshClients: [] as Array<{ connect: ReturnType<typeof vi.fn>; forwardOut: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; emit: (eventName: string, ...args: unknown[]) => boolean }>,
  localServers: [] as unknown[],
  serverAddress: { port: 54_321 } as unknown,
  listenCallsBack: true,
}));

vi.mock("ssh2", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  class FakeSshClient extends NodeEventEmitter {
    connect = vi.fn();
    forwardOut = vi.fn();
    end = vi.fn();
    constructor() {
      super();
      tunnelHarness.sshClients.push(this as unknown as (typeof tunnelHarness.sshClients)[number]);
    }
  }
  return { Client: FakeSshClient };
});

vi.mock("node:net", async () => {
  const { EventEmitter: NodeEventEmitter } = await import("node:events");
  const createServer = (connectionHandler: ConnectionHandler) => {
    const server = Object.assign(new NodeEventEmitter(), {
      connectionHandler,
      listen: vi.fn((_port: number, _host: string, onListening: () => void) => {
        if (tunnelHarness.listenCallsBack) onListening();
      }),
      address: vi.fn(() => tunnelHarness.serverAddress),
      close: vi.fn(),
    });
    tunnelHarness.localServers.push(server);
    return server;
  };
  return { default: { createServer }, createServer };
});

const { openIbkrTunnel } = await import("./ibkrGatewayTunnel.js");

const options = { sshHost: "vps.example", sshPort: 2222, sshUsername: "tunnel", sshPrivateKey: Buffer.from("key"), remoteHost: "gateway.internal", remotePort: 4002 };

function latestSshClient() {
  return tunnelHarness.sshClients.at(-1)!;
}

function latestLocalServer(): FakeLocalServer {
  return tunnelHarness.localServers.at(-1) as FakeLocalServer;
}

function createSocket(): FakeSocket {
  return Object.assign(new EventEmitter(), { remoteAddress: "127.0.0.1", remotePort: 61_000, destroy: vi.fn(), pipe: vi.fn() });
}

function createStream(): FakeStream {
  const stream = Object.assign(new EventEmitter(), { destroy: vi.fn(), pipe: vi.fn() });
  stream.pipe.mockReturnValue(stream);
  return stream;
}

beforeEach(() => {
  vi.useFakeTimers();
  tunnelHarness.sshClients.length = 0;
  tunnelHarness.localServers.length = 0;
  tunnelHarness.serverAddress = { port: 54_321 };
  tunnelHarness.listenCallsBack = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("openIbkrTunnel", () => {
  it("connects over ssh with the given host, port, user and key", () => {
    void openIbkrTunnel(options).catch(() => {});
    expect(latestSshClient().connect).toHaveBeenCalledWith({ host: "vps.example", port: 2222, username: "tunnel", privateKey: options.sshPrivateKey });
  });

  it("resolves with the local port once ssh is ready and the loopback server listens on an ephemeral port", async () => {
    const tunnel = openIbkrTunnel(options);
    latestSshClient().emit("ready");
    await expect(tunnel).resolves.toMatchObject({ localPort: 54_321 });
    expect(latestLocalServer().listen).toHaveBeenCalledWith(0, "127.0.0.1", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and ends the ssh client when ssh does not become ready within 15 s, but not earlier", async () => {
    const outcome = openIbkrTunnel(options).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(latestSshClient().end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe("Timed out opening SSH tunnel to IBKR Gateway.");
    expect(latestSshClient().end).toHaveBeenCalledTimes(1);
  });

  it("rejects with the ssh error and clears the timeout", async () => {
    const outcome = openIbkrTunnel(options);
    latestSshClient().emit("error", new Error("All configured authentication methods failed"));
    await expect(outcome).rejects.toThrow("All configured authentication methods failed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects when the local server reports an error before it is listening", async () => {
    tunnelHarness.listenCallsBack = false;
    const outcome = openIbkrTunnel(options);
    latestSshClient().emit("ready");
    latestLocalServer().emit("error", new Error("EADDRINUSE"));
    await expect(outcome).rejects.toThrow("EADDRINUSE");
    expect(latestSshClient().end).toHaveBeenCalledTimes(1);
  });

  it("rejects when the local server cannot report a numeric port", async () => {
    tunnelHarness.serverAddress = null;
    const outcome = openIbkrTunnel(options);
    latestSshClient().emit("ready");
    await expect(outcome).rejects.toThrow("Failed to determine local IBKR tunnel port");
    expect(latestSshClient().end).toHaveBeenCalledTimes(1);
    expect(latestLocalServer().close).toHaveBeenCalledTimes(1);

    tunnelHarness.serverAddress = "/tmp/pipe.sock";
    const secondOutcome = openIbkrTunnel(options);
    latestSshClient().emit("ready");
    await expect(secondOutcome).rejects.toThrow("Failed to determine local IBKR tunnel port");
  });

  it("closes both the local server and the ssh client when the tunnel is closed", async () => {
    const tunnel = openIbkrTunnel(options);
    latestSshClient().emit("ready");
    const opened = await tunnel;
    opened.close();
    expect(latestLocalServer().close).toHaveBeenCalledTimes(1);
    expect(latestSshClient().end).toHaveBeenCalledTimes(1);
  });

  describe("forwarding each local connection", () => {
    async function openedTunnelWithConnection() {
      const tunnel = openIbkrTunnel(options);
      latestSshClient().emit("ready");
      await tunnel;
      const socket = createSocket();
      latestLocalServer().connectionHandler(socket);
      return { socket, sshClient: latestSshClient() };
    }

    it("forwards to the configured remote host and port, using the local socket's address as the source", async () => {
      const { sshClient } = await openedTunnelWithConnection();
      expect(sshClient.forwardOut).toHaveBeenCalledWith("127.0.0.1", 61_000, "gateway.internal", 4002, expect.any(Function));
    });

    it("falls back to 127.0.0.1 and port 0 when the socket has no remote address", async () => {
      const tunnel = openIbkrTunnel(options);
      latestSshClient().emit("ready");
      await tunnel;
      const socket = createSocket();
      socket.remoteAddress = undefined;
      socket.remotePort = undefined;
      latestLocalServer().connectionHandler(socket);
      expect(latestSshClient().forwardOut).toHaveBeenCalledWith("127.0.0.1", 0, "gateway.internal", 4002, expect.any(Function));
    });

    it("destroys the local socket when the ssh channel cannot be opened", async () => {
      const { socket, sshClient } = await openedTunnelWithConnection();
      const callback = sshClient.forwardOut.mock.calls[0]![4] as ForwardOutCallback;
      callback(new Error("administratively prohibited"));
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    it("pipes the local socket and the ssh stream into each other", async () => {
      const { socket, sshClient } = await openedTunnelWithConnection();
      const stream = createStream();
      socket.pipe.mockReturnValue(stream);
      (sshClient.forwardOut.mock.calls[0]![4] as ForwardOutCallback)(undefined, stream);
      expect(socket.pipe).toHaveBeenCalledWith(stream);
      expect(stream.pipe).toHaveBeenCalledWith(socket);
    });

    it("destroys the other side instead of crashing the process when either side errors", async () => {
      const { socket, sshClient } = await openedTunnelWithConnection();
      const stream = createStream();
      socket.pipe.mockReturnValue(stream);
      (sshClient.forwardOut.mock.calls[0]![4] as ForwardOutCallback)(undefined, stream);

      expect(() => stream.emit("error", new Error("read ECONNRESET"))).not.toThrow();
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(() => socket.emit("error", new Error("write EPIPE"))).not.toThrow();
      expect(stream.destroy).toHaveBeenCalledTimes(1);
    });
  });
});
