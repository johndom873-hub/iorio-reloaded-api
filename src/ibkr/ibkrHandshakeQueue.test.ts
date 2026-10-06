import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

async function freshQueue() {
  vi.resetModules();
  return import("./ibkrHandshakeQueue.js");
}

interface ControlledHandshake {
  started: boolean;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  run: () => Promise<string>;
}

function controlledHandshake(): ControlledHandshake {
  const handshake: ControlledHandshake = {
    started: false,
    resolve: () => {},
    reject: () => {},
    run: () => {
      handshake.started = true;
      return new Promise<string>((resolve, reject) => {
        handshake.resolve = resolve;
        handshake.reject = reject;
      });
    },
  };
  return handshake;
}

async function flush(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("runIbkrHandshake", () => {
  it("returns the handshake's value", async () => {
    const { runIbkrHandshake } = await freshQueue();
    await expect(runIbkrHandshake(async () => "connected")).resolves.toBe("connected");
  });

  it("starts at most two handshakes at once and queues the rest", async () => {
    const { runIbkrHandshake } = await freshQueue();
    const [first, second, third, fourth] = [controlledHandshake(), controlledHandshake(), controlledHandshake(), controlledHandshake()];
    const results = [first, second, third, fourth].map((handshake) => runIbkrHandshake(handshake.run));
    await flush();
    expect([first.started, second.started, third.started, fourth.started]).toEqual([true, true, false, false]);

    first.resolve("first");
    await flush();
    expect([third.started, fourth.started]).toEqual([true, false]);

    second.resolve("second");
    await flush();
    expect(fourth.started).toBe(true);

    third.resolve("third");
    fourth.resolve("fourth");
    await expect(Promise.all(results)).resolves.toEqual(["first", "second", "third", "fourth"]);
  });

  it("serves waiters in the order they arrived", async () => {
    const { runIbkrHandshake } = await freshQueue();
    const startOrder: string[] = [];
    const handshakes = ["a", "b", "c", "d", "e"].map((name) => {
      const handshake = controlledHandshake();
      const originalRun = handshake.run;
      handshake.run = () => {
        startOrder.push(name);
        return originalRun();
      };
      return handshake;
    });
    const results = handshakes.map((handshake) => runIbkrHandshake(handshake.run));
    await flush();
    for (const handshake of handshakes) {
      handshake.resolve("done");
      await flush();
    }
    await Promise.all(results);
    expect(startOrder).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("frees the slot when a handshake rejects and passes the rejection to its own caller only", async () => {
    const { runIbkrHandshake } = await freshQueue();
    const [first, second, third] = [controlledHandshake(), controlledHandshake(), controlledHandshake()];
    const firstResult = runIbkrHandshake(first.run);
    const secondResult = runIbkrHandshake(second.run);
    const thirdResult = runIbkrHandshake(third.run);
    await flush();
    expect(third.started).toBe(false);

    first.reject(new Error("Timed out connecting to IBKR Gateway."));
    await expect(firstResult).rejects.toThrow("Timed out connecting to IBKR Gateway.");
    await flush();
    expect(third.started).toBe(true);

    second.resolve("second");
    third.resolve("third");
    await expect(secondResult).resolves.toBe("second");
    await expect(thirdResult).resolves.toBe("third");
  });

  it("frees the slot when the handshake function throws synchronously", async () => {
    const { runIbkrHandshake } = await freshQueue();
    await expect(
      runIbkrHandshake(() => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    await expect(runIbkrHandshake(async () => "next")).resolves.toBe("next");
  });

  it("returns to two free slots once everything settled", async () => {
    const { runIbkrHandshake } = await freshQueue();
    await Promise.all([runIbkrHandshake(async () => 1), runIbkrHandshake(async () => 2), runIbkrHandshake(async () => 3)]);
    const [first, second, third] = [controlledHandshake(), controlledHandshake(), controlledHandshake()];
    void runIbkrHandshake(first.run);
    void runIbkrHandshake(second.run);
    void runIbkrHandshake(third.run);
    await flush();
    expect([first.started, second.started, third.started]).toEqual([true, true, false]);
  });

  it("does not count time spent waiting in the queue against the handshake itself", async () => {
    const { runIbkrHandshake } = await freshQueue();
    const [first, second] = [controlledHandshake(), controlledHandshake()];
    void runIbkrHandshake(first.run);
    void runIbkrHandshake(second.run);
    const queuedHandshake = vi.fn(async () => "late");
    const queuedResult = runIbkrHandshake(queuedHandshake);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(queuedHandshake).not.toHaveBeenCalled();
    first.resolve("ok");
    await flush();
    expect(queuedHandshake).toHaveBeenCalledTimes(1);
    await expect(queuedResult).resolves.toBe("late");
  });
});
