import { db } from "../db/connection.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { finishPlutoPass, type FinishPlutoPassInput, recordPlutoEvent, startPlutoPass, type PlutoSystemCheck, type PlutoTrigger } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadPlutoState, recordPlutoPass, tripPlutoBreaker } from "./stateStore.js";
import { runPlutoSystemChecks } from "./systemChecks.js";
import { runLadderRound } from "./ladderRound.js";
import { runVolFarmerV2Round } from "./volFarmerV2Round.js";

// One round (design rounds 3–4, 2026-09-28; rules only since Signals was retired, 2026-10-27): system checks → each
// ticker's strategy on its band quotes (the CC + Put Ladder's round, then Vol Farmer v2's, Marcelo 2026-10-27) → the real
// order routes. Everything is written to the ledger as it happens.

export interface PassRunnerContext {
  api: InternalApiClient;
  marketWatch: PlutoMarketWatch;
  /** Order watches the agent keeps alive after the pass returns. */
  trackWatch: (promise: Promise<unknown>, orderId: string, symbol: string) => void;
}

export interface PassRequest {
  trigger: PlutoTrigger;
  triggerDetail: Record<string, unknown>;
  /** Symbols this pass is about (empty = every enabled ticker). */
  symbols: string[];
  /** The opening look runs even when no band quote is new. */
  force: boolean;
  /** Before today's opening look: the ladder sells nothing on yesterday's data. */
  heldPositionsOnly?: boolean;
}

export interface PassSummary {
  passId: string;
  skippedReason: string | null;
  outcome: string | null;
  /** The round stopped at the system checks (account data, worker, reconciliation…): nothing was analysed. */
  skippedOnSystemChecks?: boolean;
}

async function loadEnabledSymbols(): Promise<string[]> {
  const rows: { symbol: string }[] = await db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").where("se.bot_enabled", true).select("t.symbol");
  return rows.map((row) => row.symbol).sort();
}

export async function runPlutoPass(request: PassRequest, context: PassRunnerContext): Promise<PassSummary> {
  const settings = await loadPlutoSettings();
  const passId = await startPlutoPass(request.trigger, request.triggerDetail, settings);
  let passFinished = false;
  const finishPass = async (input: FinishPlutoPassInput) => {
    await finishPlutoPass(passId, input);
    passFinished = true;
  };
  try {
    return await runStartedPass(request, context, settings, passId, finishPass);
  } catch (error) {
    if (passFinished) throw error;
    try {
      await finishPlutoPass(passId, { skippedReason: `round failed: ${error instanceof Error ? error.message : String(error)}` });
    } catch {
      // The round's own error is the one worth reporting; the abandoned-pass sweep closes the row later.
    }
    throw error;
  }
}

async function runStartedPass(request: PassRequest, context: PassRunnerContext, settings: PlutoSettings, passId: string, finishPass: (input: FinishPlutoPassInput) => Promise<void>): Promise<PassSummary> {
  // A round with no symbols of its own (opening look, settings change) looks at every enabled ticker: name them,
  // so the Event log's ticker filter finds the round.
  const symbols = request.symbols.length > 0 ? request.symbols : await loadEnabledSymbols();
  await recordPlutoEvent("pass_started", { passId, trigger: request.trigger, symbols });
  const now = new Date();

  const skip = async (reason: string, systemChecks?: Record<string, PlutoSystemCheck>): Promise<PassSummary> => {
    await finishPass({ skippedReason: reason, ...(systemChecks ? { systemChecks } : {}) });
    await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason });
    await recordPlutoPass();
    return { passId, skippedReason: reason, outcome: null };
  };

  // 1. System gates.
  const checks = await runPlutoSystemChecks(settings, now);
  // The daily-loss check is also a breaker (design item 51): tripping it needs a human reset.
  if (checks.checks.daily_loss && !checks.checks.daily_loss.ok && !checks.checks.daily_loss.detail.startsWith("cannot compute") && !checks.checks.daily_loss.detail.startsWith("could not read")) {
    const before = await loadPlutoState();
    if (!before.breakers.daily_loss) {
      await tripPlutoBreaker("daily_loss", checks.checks.daily_loss.detail);
      await recordPlutoEvent("breaker_tripped", { name: "daily_loss", detail: checks.checks.daily_loss.detail });
      await notifyPlutoTelegram(`🛑 Pluto breaker tripped (daily_loss): ${checks.checks.daily_loss.detail}. Pluto is paused until a human resets it.`);
    }
  }
  // A reconciliation discrepancy is a breaker too (design breaker list): IBKR and the book disagree.
  if (checks.checks.reconciliation && !checks.checks.reconciliation.ok && checks.checks.reconciliation.detail.startsWith("discrepancy")) {
    const before = await loadPlutoState();
    if (!before.breakers.reconciliation) {
      await tripPlutoBreaker("reconciliation", checks.checks.reconciliation.detail);
      await recordPlutoEvent("breaker_tripped", { name: "reconciliation", detail: checks.checks.reconciliation.detail });
      await notifyPlutoTelegram(`🛑 Pluto breaker tripped (reconciliation): ${checks.checks.reconciliation.detail}. Pluto is paused until a human resets it.`);
    }
  }
  if (checks.failures.length > 0) return { ...(await skip(checks.failures.join(" | "), checks.checks)), skippedOnSystemChecks: true };

  // Market stress (design round 4, item 72; a Safety Limit): a broad intraday drop stops Pluto opening anything for as long as it lasts.
  // Recorded as a check, not a breaker, so it lifts on its own when SPY recovers.
  const spyDayChangePct = context.marketWatch.spyDayChangePct();
  const stressOverridden = checks.context.state.stressOverrideDate === checks.context.todayEasternIso;
  const marketStress = spyDayChangePct !== null && spyDayChangePct <= -settings.safetySpyStressBreakerPct && !stressOverridden;
  checks.checks.market_stress = {
    ok: !marketStress,
    detail: `${spyDayChangePct === null ? "SPY day change unknown" : `SPY ${spyDayChangePct.toFixed(2)}% (Pluto stops opening at -${settings.safetySpyStressBreakerPct}%)`}${stressOverridden ? ` — override on for today${checks.context.state.stressOverrideByDisplayName ? ` by ${checks.context.state.stressOverrideByDisplayName}` : ""}` : ""}`,
  };

  // 2. The strategies (Marcelo 2026-10-14/15 and 2026-10-27): rules only. Their orders wait for today's opening look. Under
  // market stress the ladder sells nothing and Vol Farmer v2 opens nothing, a LEAPS sale still going.
  if (request.heldPositionsOnly) return skip("the strategies' orders wait for today's opening look", checks.checks);
  if (checks.context.netLiquidationValue === null) return skip("no net liquidation value for the strategies' pots", checks.checks);
  const roundInput = { passId, settings, api: context.api, marketWatch: context.marketWatch, trackWatch: context.trackWatch, now, todayIso: checks.context.todayEasternIso, totalCashValue: checks.context.totalCashValue, netLiquidationValue: checks.context.netLiquidationValue, cancelByMs: checks.context.session.cancelByMs, symbols: request.symbols };
  const ladder = marketStress ? null : await runLadderRound(roundInput);
  const volFarmerV2 = await runVolFarmerV2Round({ ...roundInput, stressed: marketStress });
  const sent = (ladder?.outcomes.filter((outcome) => outcome.outcome === "confirmed").length ?? 0) + volFarmerV2.sent;
  const planned = (ladder?.planned ?? 0) + volFarmerV2.planned;
  const looked = (ladder?.looked.length ?? 0) + volFarmerV2.looked.length;
  const notes = [...(ladder?.notes ?? []), ...volFarmerV2.notes];
  const skippedReason =
    sent > 0
      ? null
      : marketStress && planned === 0
        ? "market stress: Pluto opens nothing while SPY is down"
        : planned === 0
          ? `no order planned (${looked} ticker(s) looked at${notes.length > 0 ? `; ${notes.join("; ")}` : ""})`
          : `none of the ${planned} planned order(s) was sent${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
  await finishPass({ candidateCount: planned, systemChecks: checks.checks, skippedReason, notes });
  if (skippedReason) await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason: skippedReason });
  await recordPlutoPass();
  return { passId, skippedReason, outcome: sent > 0 ? "trade" : null };
}
