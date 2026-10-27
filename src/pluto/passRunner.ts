import { db } from "../db/connection.js";
import type { InternalApiClient } from "../lib/internalApiClient.js";
import { notifyPlutoTelegram } from "../lib/notifyTelegram.js";
import { finishPlutoPass, type FinishPlutoPassInput, recordPlutoEvent, startPlutoPass, type PlutoSystemCheck, type PlutoTrigger } from "./ledger.js";
import type { PlutoMarketWatch } from "./marketWatch.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { loadPlutoState, recordPlutoPass, tripPlutoBreaker } from "./stateStore.js";
import { runPlutoSystemChecks } from "./systemChecks.js";
import { runLadderRound } from "./ladderRound.js";

// One round (design rounds 3–4, 2026-09-28; the CC + Put Ladder only since Signals was retired, 2026-10-27): system
// checks → the ladder's rules on its band quotes → the real order routes. Everything is written to the ledger as it happens.

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
    await finishPass({ skippedReason: reason, modelCalled: false, ...(systemChecks ? { systemChecks } : {}) });
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
  // The day's actions cap is recorded but does not stop the ladder, which keeps to its own book limits.
  const blockingFailures = checks.failures.filter((failure) => !failure.startsWith("actions_cap:"));
  if (blockingFailures.length > 0) return { ...(await skip(checks.failures.join(" | "), checks.checks)), skippedOnSystemChecks: true };

  // Market stress (design round 4, item 72): a broad intraday drop stops the ladder's sales for as long as it lasts.
  // Recorded as a check, not a breaker, so it lifts on its own when SPY recovers.
  const spyDayChangePct = context.marketWatch.spyDayChangePct();
  const stressOverridden = checks.context.state.stressOverrideDate === checks.context.todayEasternIso;
  const ladderStress = spyDayChangePct !== null && spyDayChangePct <= -settings.ladderSpyStressBreakerPct && !stressOverridden;
  checks.checks.market_stress = {
    ok: !ladderStress,
    detail: `${spyDayChangePct === null ? "SPY day change unknown" : `SPY ${spyDayChangePct.toFixed(2)}% (the ladder stops at -${settings.ladderSpyStressBreakerPct}%)`}${stressOverridden ? ` — override on for today${checks.context.state.stressOverrideByDisplayName ? ` by ${checks.context.state.stressOverrideByDisplayName}` : ""}` : ""}`,
  };

  // 2. The CC + Put Ladder (Marcelo 2026-10-14/15): rules only. Its sales wait for today's opening look.
  if (request.heldPositionsOnly) return skip("the ladder's sales wait for today's opening look", checks.checks);
  if (ladderStress) return skip("market stress: the ladder sells nothing while SPY is down", checks.checks);
  if (checks.context.netLiquidationValue === null) return skip("no net liquidation value for the ladder's pots", checks.checks);
  const ladder = await runLadderRound({ passId, settings, api: context.api, marketWatch: context.marketWatch, trackWatch: context.trackWatch, now, todayIso: checks.context.todayEasternIso, totalCashValue: checks.context.totalCashValue, netLiquidationValue: checks.context.netLiquidationValue, cancelByMs: checks.context.session.cancelByMs, symbols: request.symbols });
  const sent = ladder.outcomes.filter((outcome) => outcome.outcome === "confirmed").length;
  const skippedReason = sent > 0 ? null : ladder.planned === 0 ? `the ladder planned no sale (${ladder.looked.length} ticker(s) looked at${ladder.notes.length > 0 ? `; ${ladder.notes.join("; ")}` : ""})` : `none of the ladder's ${ladder.planned} planned sale(s) was sent`;
  await finishPass({ candidateCount: ladder.planned, systemChecks: checks.checks, modelCalled: false, skippedReason });
  if (skippedReason) await recordPlutoEvent("pass_skipped", { passId, trigger: request.trigger, reason: skippedReason });
  await recordPlutoPass();
  return { passId, skippedReason, outcome: sent > 0 ? "trade" : null };
}
