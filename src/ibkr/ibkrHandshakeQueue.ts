// IBKR Gateway can't reliably accept several simultaneous new-client API
// handshakes at once — found 2026-09-11 reproducing a stall where one
// connection attempt (SSH tunnel open, `ib.connect()` called) never received
// `nextValidId` while others opened around the same time succeeded in
// 1-2s, leaving it to sit for its full internal timeout with neither a
// result nor an error. The SSH tunnel itself never contends (multiple open
// concurrently in well under the timeout); only the IBKR API handshake step
// does. This queue serializes that step to a small number of concurrent
// slots across every caller (streaming one-shots in connectIbkr.ts, the
// shared read connection in sharedReadConnection.ts) so a burst of
// connection attempts queues for the handshake instead of racing Gateway
// for it. Each caller still gets its own full timeout budget, starting only
// once it acquires a slot — waiting in this queue is not counted against it.
const maxConcurrentHandshakes = 2;

let activeHandshakes = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (activeHandshakes < maxConcurrentHandshakes) {
    activeHandshakes++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  // Hand the slot directly to the next waiter rather than decrementing —
  // keeps activeHandshakes accurate without a separate wake-up + re-acquire
  // race.
  if (next) next();
  else activeHandshakes--;
}

/**
 * Runs `handshake` (expected to call `ib.connect()` and resolve/reject once
 * IBKR responds) once a slot is free, releasing the slot when it settles
 * either way.
 */
export async function runIbkrHandshake<T>(handshake: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await handshake();
  } finally {
    release();
  }
}
