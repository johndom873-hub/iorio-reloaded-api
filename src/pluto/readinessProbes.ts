import { EventName } from "@stoqey/ib";
import { connectToIbkrGateway } from "../ibkr/connectIbkr.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { formatSignedDollars } from "../lib/formatSignedDollars.js";
import type { PlutoReadinessProbes } from "./readiness.js";

// The live side of Pluto's readiness check: each probe resolves with what it proved or throws with what failed.

const ibkrServerTimeTimeoutMs = 20_000;
const openRouterTimeoutMs = 15_000;
export const openRouterCreditsUrl = "https://openrouter.ai/api/v1/credits";

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

/** Key valid and remaining credit at least one day of Pluto's cost ceiling. Spends no model tokens. */
export async function probeOpenRouterCredit(apiKey: string, dailyCostCeilingUsd: number, fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(openRouterCreditsUrl, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(openRouterTimeoutMs) });
  if (!response.ok) throw new Error(`OpenRouter refused the key (HTTP ${response.status})`);
  const body = (await response.json()) as { data?: { total_credits?: unknown; total_usage?: unknown } };
  const credits = Number(body.data?.total_credits);
  const usage = Number(body.data?.total_usage);
  if (!Number.isFinite(credits) || !Number.isFinite(usage)) throw new Error("OpenRouter returned no credit figures");
  const remaining = credits - usage;
  if (remaining < dailyCostCeilingUsd) throw new Error(`${formatSignedDollars(remaining, 2)} credit left, below Pluto's ${formatSignedDollars(dailyCostCeilingUsd, 2)} daily cost ceiling`);
  return `${formatSignedDollars(remaining, 2)} credit left`;
}

export function createPlutoReadinessProbes(input: { api: InternalApiClient; openRouterApiKey: string; dailyCostCeilingUsd: number }): PlutoReadinessProbes {
  return {
    ibkr: probeIbkrServerTime,
    apiSignIn: () => probeApiSignIn(input.api),
    openRouter: () => probeOpenRouterCredit(input.openRouterApiKey, input.dailyCostCeilingUsd),
  };
}
