import { EventName } from "@stoqey/ib";
import { connectToIbkrGateway } from "../ibkr/connectIbkr.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import type { PlutoReadinessProbes } from "./readiness.js";

// The live side of Pluto's readiness check: each probe resolves with what it proved or throws with what failed.

const ibkrServerTimeTimeoutMs = 20_000;

/**
 * Opens a one-shot connection from Pluto's process through the same tunnel and Gateway its live connection uses, asks for
 * the server time, and disconnects. It holds no market-data line and leaves Pluto's own live connection alone.
 */
export async function probeIbkrServerTime(): Promise<string> {
  const connection = await connectToIbkrGateway();
  try {
    await new Promise<void>((resolve, reject) => {
      const onCurrentTime = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        connection.ib.off(EventName.currentTime, onCurrentTime);
        reject(new Error(`connected, but IBKR did not answer the server-time request within ${ibkrServerTimeTimeoutMs / 1000} s`));
      }, ibkrServerTimeTimeoutMs);
      connection.ib.once(EventName.currentTime, onCurrentTime);
      connection.ib.reqCurrentTime();
    });
    return "connected and answered";
  } finally {
    connection.disconnect();
  }
}

/** A fresh sign-in as Pluto's service user (never a cached session), then one read-only request. */
export async function probeApiSignIn(api: InternalApiClient): Promise<string> {
  await api.verifySignIn("/pluto/state");
  return "signed in and read Pluto's state";
}

export function createPlutoReadinessProbes(input: { api: InternalApiClient }): PlutoReadinessProbes {
  return {
    ibkr: probeIbkrServerTime,
    apiSignIn: () => probeApiSignIn(input.api),
  };
}
