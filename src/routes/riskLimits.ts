import { Router, type Request, type Response } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchAccountSummary } from "../ibkr/fetchAccountSummary.js";
import { computeCashLockedInCsps, computePositionExposures, streamPositionExposures, type PositionExposureRow } from "../lib/positionExposure.js";
import { serializeAsyncCalls } from "../lib/serializeAsyncCalls.js";
import { fetchTradingHalt, setTradingHalt, type TradingHalt } from "../lib/platformControls.js";
import { publishNotification } from "../lib/notificationChannel.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { loadTradingSettingsForEditing, saveTradingSettings, validateTradingSettingsInput, type TradingSettingsInput } from "../lib/tradingSettingsStore.js";

export const riskLimitsRouter = Router();
riskLimitsRouter.use(requireAuth);

// The trading halt (kill switch): one switch that stops every order origin at confirm and in the worker. Any signed-in user may
// flip it -- the UI puts a confirm modal in front, the API only requires a reason when halting so the audit trail says why.
const tradingHaltReasonMaxLength = 300;

function serializeTradingHalt(halt: TradingHalt) {
  return {
    enabled: halt.enabled,
    reason: halt.reason,
    setByDisplayName: halt.setByDisplayName,
    setAt: halt.setAt ? halt.setAt.toISOString() : null,
  };
}

riskLimitsRouter.get("/trading-halt", async (_request, response) => {
  response.json(serializeTradingHalt(await fetchTradingHalt()));
});

riskLimitsRouter.put("/trading-halt", async (request: Request, response: Response) => {
  const enabled = request.body?.enabled;
  if (typeof enabled !== "boolean") {
    response.status(400).json({ error: "enabled must be true or false." });
    return;
  }
  const rawReason = request.body?.reason;
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
    response.status(400).json({ error: "reason must be text." });
    return;
  }
  const reason = typeof rawReason === "string" && rawReason.trim() !== "" ? rawReason.trim() : null;
  if (enabled && !reason) {
    response.status(400).json({ error: "A reason is required to halt trading." });
    return;
  }
  if (reason && reason.length > tradingHaltReasonMaxLength) {
    response.status(400).json({ error: `reason must be at most ${tradingHaltReasonMaxLength} characters.` });
    return;
  }

  const halt = await setTradingHalt({ enabled, reason, userId: request.session.userId as string });
  await publishNotification({ type: "trading_halt_changed", enabled: halt.enabled, reason: halt.reason, byDisplayName: halt.setByDisplayName });
  // Written to the ops channel as an audit line; notifyTelegram never throws.
  await notifyTelegram(
    halt.enabled
      ? `🛑 TRADING HALTED by ${halt.setByDisplayName ?? "an operator"}: ${halt.reason ?? "(no reason given)"}. No order from any origin reaches IBKR until it is lifted (Risk & Limits → Trading halt).`
      : `✅ Trading halt lifted by ${halt.setByDisplayName ?? "an operator"}${halt.reason ? `: ${halt.reason}` : "."}`,
  );
  response.json(serializeTradingHalt(halt));
});

// The single set of trading limits and targets (table trading_settings, one row). Approved 2026-10-05: replaces the
// per-strategy copies that were never enforced and the separate Signals-tab limits.
riskLimitsRouter.get("/settings", async (_request, response) => {
  response.json(await loadTradingSettingsForEditing());
});

riskLimitsRouter.put("/settings", async (request, response) => {
  const body = (request.body ?? {}) as Record<string, unknown>;
  const validationError = validateTradingSettingsInput(body);
  if (validationError) {
    response.status(400).json({ error: validationError });
    return;
  }
  await saveTradingSettings(body as TradingSettingsInput, request.session.userId!);
  response.json(await loadTradingSettingsForEditing());
});

// Approved 2026-08-25: every concentration/allocation % on this page and
// on the Dashboard is against total account value (net liquidation value,
// i.e. positions + cash), not against the sum of open positions — so an
// under-deployed account doesn't read as "concentrated" just because
// whatever's invested happens to cluster. Sector/strategy groupings get an
// explicit "Unallocated" row for whatever isn't in any open position,
// rather than silently omitting cash from the picture.
function withUnallocated<T extends { notionalValue: string }>(
  rows: T[],
  totalAccountValue: number | null,
  unallocatedRow: T,
): T[] {
  if (totalAccountValue === null || totalAccountValue === undefined) return rows;
  const allocated = rows.reduce((sum, row) => sum + Number(row.notionalValue), 0);
  const unallocated = totalAccountValue - allocated;
  if (unallocated <= 0) return rows;
  return [...rows, { ...unallocatedRow, notionalValue: String(unallocated) }];
}

function groupByKey<K extends string>(
  rows: PositionExposureRow[],
  keyOf: (row: PositionExposureRow) => K,
): { key: K; notionalValue: string }[] {
  const totals = new Map<K, number>();
  for (const row of rows) {
    const key = keyOf(row);
    totals.set(key, (totals.get(key) ?? 0) + row.exposure);
  }
  return [...totals.entries()]
    .map(([key, notionalValue]) => ({ key, notionalValue: String(notionalValue) }))
    .sort((a, b) => Number(b.notionalValue) - Number(a.notionalValue));
}

riskLimitsRouter.get("/exposure", async (_request, response) => {
  const [exposures, accountResult, cashLockedInCsps] = await Promise.all([
    computePositionExposures(),
    fetchAccountSummary()
      .then((account) => ({ account, accountDataError: null as string | null }))
      .catch((error) => ({
        account: null,
        accountDataError: error instanceof Error ? error.message : "Failed to fetch live account data from IBKR.",
      })),
    computeCashLockedInCsps(),
  ]);

  const { account, accountDataError } = accountResult;
  const totalAccountValue = account?.netLiquidationValue ?? null;
  const availableCash = account?.totalCashValue !== null && account?.totalCashValue !== undefined
    ? account.totalCashValue - cashLockedInCsps
    : null;

  const concentrationByTicker = groupByKey(exposures, (row) => row.symbol).map((row) => ({
    symbol: row.key,
    notionalValue: row.notionalValue,
  }));
  const concentrationBySector = groupByKey(exposures, (row) => row.sector).map((row) => ({
    sector: row.key,
    notionalValue: row.notionalValue,
  }));
  const strategyAllocation = groupByKey(exposures, (row) => row.strategyKey).map((row) => ({
    strategyKey: row.key,
    notionalValue: row.notionalValue,
  }));
  const topPositions = [...exposures]
    .sort((a, b) => b.exposure - a.exposure)
    .slice(0, 5)
    .map((row) => ({ positionId: row.positionId, symbol: row.symbol, strategyKey: row.strategyKey, notionalValue: String(row.exposure) }));

  response.json({
    account,
    accountDataError,
    totalAccountValue,
    availableCash,
    concentrationByTicker,
    concentrationBySector: withUnallocated(concentrationBySector, totalAccountValue, {
      sector: "Unallocated",
      notionalValue: "0",
    }),
    strategyAllocation: withUnallocated(strategyAllocation, totalAccountValue, {
      strategyKey: "unallocated",
      notionalValue: "0",
    }),
    topPositions,
  });
});

async function loadExposureAccountContext() {
  const [accountResult, cashLockedInCsps] = await Promise.all([
    fetchAccountSummary()
      .then((account) => ({ account, accountDataError: null as string | null }))
      .catch((error) => ({
        account: null,
        accountDataError: error instanceof Error ? error.message : "Failed to fetch live account data from IBKR.",
      })),
    computeCashLockedInCsps(),
  ]);
  const { account, accountDataError } = accountResult;
  const totalAccountValue = account?.netLiquidationValue ?? null;
  const availableCash =
    account?.totalCashValue !== null && account?.totalCashValue !== undefined ? account.totalCashValue - cashLockedInCsps : null;
  return { account, accountDataError, totalAccountValue, availableCash };
}

// SSE live-upgrading sibling of GET /exposure (approved 2026-09-09). Fetches
// account summary once up front (see /dashboard/portfolio/stream's matching
// comment for why), then streams exposure-derived aggregates: a
// FROZEN-priced reading first, recomputed and re-sent every time
// streamPositionExposures reports newer prices, until the client
// disconnects.
export async function streamExposureHandler(request: Request, response: Response): Promise<void> {
  // Account data and the price stream are independent — started together
  // (2026-09-19) so the ~1s account fetch overlaps the stream's own setup
  // instead of delaying it. Every reading awaits this before sending.
  let accountContextPromise = loadExposureAccountContext();
  // Handled below inside the stream callback; this only stops a failure from
  // being reported as unhandled if the client disconnects before any reading.
  accountContextPromise.catch(() => {});
  let isFirstReading = true;
  let previousReadingWasEmpty = false;

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders();
  response.on("error", () => {});

  const abortController = new AbortController();
  request.on("close", () => abortController.abort());

  const send = (data: unknown) => {
    if (response.writableEnded) return;
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    if (!response.writableEnded) response.write(": ping\n\n");
  }, 20_000);

  try {
    await streamPositionExposures(
      serializeAsyncCalls(async (exposures) => {
        // With no open position the stream re-sends an empty reading every minute (streamPositionExposures); the
        // account figures are all that moves on it, so they are re-read for each of those, and for the first
        // reading after a position opens.
        if (!isFirstReading && (exposures.length === 0 || previousReadingWasEmpty)) accountContextPromise = loadExposureAccountContext();
        isFirstReading = false;
        previousReadingWasEmpty = exposures.length === 0;
        const { account, accountDataError, totalAccountValue, availableCash } = await accountContextPromise;
        const concentrationByTicker = groupByKey(exposures, (row) => row.symbol).map((row) => ({ symbol: row.key, notionalValue: row.notionalValue }));
        const concentrationBySector = groupByKey(exposures, (row) => row.sector).map((row) => ({ sector: row.key, notionalValue: row.notionalValue }));
        const strategyAllocation = groupByKey(exposures, (row) => row.strategyKey).map((row) => ({ strategyKey: row.key, notionalValue: row.notionalValue }));
        const topPositions = [...exposures]
          .sort((a, b) => b.exposure - a.exposure)
          .slice(0, 5)
          .map((row) => ({ positionId: row.positionId, symbol: row.symbol, strategyKey: row.strategyKey, notionalValue: String(row.exposure) }));

        send({
          account,
          accountDataError,
          totalAccountValue,
          availableCash,
          concentrationByTicker,
          concentrationBySector: withUnallocated(concentrationBySector, totalAccountValue, { sector: "Unallocated", notionalValue: "0" }),
          strategyAllocation: withUnallocated(strategyAllocation, totalAccountValue, { strategyKey: "unallocated", notionalValue: "0" }),
          topPositions,
        });
      }),
      abortController.signal,
    );
  } catch (error) {
    console.error("risk-limits/exposure/stream: streamPositionExposures failed", error);
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

riskLimitsRouter.get("/exposure/stream", streamExposureHandler);
