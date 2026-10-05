import { db } from "../db/connection.js";
import { sharedLiveConnection } from "../ibkr/sharedReadConnection.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { InternalApiClient } from "../lib/internalApiClient.js";
import { startNotificationBroadcaster, subscribeToNotifications } from "../lib/notificationBroadcaster.js";
import { computeMarketSessionStatus, easternDateIso } from "../lib/marketSessionStatus.js";
import { notifyTelegram } from "../lib/notifyTelegram.js";
import { readGitSha } from "../lib/readGitSha.js";
import type { PlutoConfig } from "./config.js";
import { labelExpiredCandidateOutcomes } from "./candidateOutcomes.js";
import { loadWorkingPlutoOrders, watchPlutoOrder } from "./executor.js";
import { plutoEventsRetentionDays, pruneOldPlutoEvents, recordPlutoEvent, type PlutoTrigger } from "./ledger.js";
import { PlutoMarketWatch } from "./marketWatch.js";
import { runPlutoPass, type PassRunnerContext } from "./passRunner.js";
import { resolvePlutoSession } from "./sessionSchedule.js";
import { loadPlutoSettings, type PlutoSettings } from "./settingsStore.js";
import { describePlutoBlock, loadPlutoState, pausePluto, recordPlutoRelease } from "./stateStore.js";
import { isInsideTradingWindow } from "./systemChecks.js";

// The Pluto agent process (design round 4, 2026-09-28). Event-driven, not a decision loop:
//   - boot: crash-loop and deploy detection pause the agent before it can act;
//   - a 45 s heartbeat row (worker_health, process_name "pluto_agent") for the screen;
//   - a 60 s housekeeping tick: settings, state, the watched stock lines, the opening look;
//   - a 30 s day-quotes poll and spot-move triggers, both coalesced into one pass per window;
//   - passes run one at a time; order watches outlive their pass.

const heartbeatIntervalMs = 45_000;
const housekeepingIntervalMs = 60_000;
const dayQuotesPollIntervalMs = 30_000;
export const plutoProcessName = "pluto_agent";

// Settings that shape how Pluto operates but never what it would decide: changing only these does
// not warrant a forced pass (and its model call).
export const settingsFieldsThatNeverChangeADecision = new Set([
  "telegramVerbosity", "crashLoopRestartsPerHour", "messageRateLimitPerSecond", "burstLines", "burstSettleSeconds",
  "coalescingWindowSeconds", "callTimeoutSeconds", "maxEnabledTickers", "promptVersion",
]);

export class PlutoAgent {
  private readonly api: InternalApiClient;
  private readonly marketWatch: PlutoMarketWatch;
  private settings: PlutoSettings | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubscribeNotifications: (() => void) | null = null;
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSymbols = new Set<string>();
  private pendingTrigger: PlutoTrigger = "day_quotes";
  private pendingDetail: Record<string, unknown> = {};
  private pendingForce = false;
  private passChain: Promise<unknown> = Promise.resolve();
  private readonly watches = new Set<Promise<unknown>>();
  private readonly watchedOrderIds = new Set<string>();
  private openingLookDoneFor: string | null = null;
  private watching = false;
  private stopped = false;
  private readonly startedAtMs = Date.now();
  private readonly context: PassRunnerContext;

  constructor(private readonly config: PlutoConfig) {
    this.api = new InternalApiClient({ apiBaseUrl: config.apiBaseUrl, serviceUsername: config.serviceUsername, serviceUserPassword: config.serviceUserPassword, serviceLoginSecret: config.serviceLoginSecret, label: "Pluto" });
    this.marketWatch = new PlutoMarketWatch({} as PlutoSettings);
    this.context = {
      api: this.api,
      openRouterApiKey: config.openRouterApiKey,
      marketWatch: this.marketWatch,
      lastFingerprintBySymbol: new Map(),
      lastModelEvaluationAtBySymbol: new Map(),
      lastModelCallAtMs: { value: null },
      trackWatch: (promise, orderId) => {
        this.watches.add(promise);
        this.watchedOrderIds.add(orderId);
        promise
          .catch((error) => console.error(`Pluto: order watch failed — ${error instanceof Error ? error.message : error}`))
          .finally(() => {
            this.watches.delete(promise);
            this.watchedOrderIds.delete(orderId);
          });
      },
    };
  }

  async start(): Promise<void> {
    // The first housekeeping tick borrows the IBKR connection while it is still connecting; the default 3 s
    // borrow timeout made the day's first session-close read fail every boot.
    sharedLiveConnection.setBorrowTimeoutMs(30_000);
    this.settings = await loadPlutoSettings();
    this.marketWatch.updateSettings(this.settings);
    await recordPlutoEvent("agent_started", { environment: readAppEnvironment(), release: currentRelease() });
    await this.guardBoot();
    await this.heartbeat();
    this.timers.push(setInterval(() => void this.heartbeat(), heartbeatIntervalMs));
    this.timers.push(setInterval(() => void this.housekeeping(), housekeepingIntervalMs));
    this.timers.push(setInterval(() => void this.pollDayQuotes(), dayQuotesPollIntervalMs));
    this.marketWatch.onSpotMove((trigger) => this.enqueue("spot_move", [trigger.symbol], { symbol: trigger.symbol, movePct: Math.round(trigger.movePct * 100) / 100, fromSpot: trigger.fromSpot, spot: trigger.spot }, false));
    // A saved settings change is felt within the coalescing window, not at the next market trigger (Marcelo, 2026-09-28).
    startNotificationBroadcaster();
    this.unsubscribeNotifications = subscribeToNotifications((notification) => {
      if (notification.type !== "pluto_event" || notification.eventType !== "settings_changed") return;
      const fields = ((notification.payload.fields as { field: string }[] | undefined) ?? []).map((change) => change.field);
      if (fields.length > 0 && fields.every((field) => settingsFieldsThatNeverChangeADecision.has(field))) return;
      this.enqueue("settings_changed", [], { fields, by: notification.payload.by ?? null }, true);
    });
    await this.housekeeping();
    console.log("Pluto agent started.");
  }

  /** Deploy and crash-loop detection: both pause before anything else happens (design item 6, refined round 2). */
  private async guardBoot(): Promise<void> {
    const settings = this.settings!;
    const state = await loadPlutoState();
    const release = currentRelease();
    if (state.lastSeenRelease !== null && release !== null && state.lastSeenRelease !== release) {
      await pausePluto("deploy");
      await recordPlutoEvent("paused", { by: "agent", reason: "deploy", from: state.lastSeenRelease, to: release });
      await notifyTelegram(`⏸️ Pluto paused after a deploy (${state.lastSeenRelease.slice(0, 7)} → ${release.slice(0, 7)}). Press Resume on the Pluto screen once you are happy with the release.`);
    }
    if (release !== null) await recordPlutoRelease(release);
    const recentStarts = await db("pluto_events").where({ type: "agent_started" }).where("occurred_at", ">", new Date(Date.now() - 60 * 60_000)).count<{ count: string }[]>("* as count").then((rows) => Number(rows[0]?.count ?? 0));
    if (recentStarts >= settings.crashLoopRestartsPerHour) {
      const current = await loadPlutoState();
      if (!current.paused) {
        await pausePluto("crash_loop");
        await recordPlutoEvent("paused", { by: "agent", reason: "crash_loop", startsInLastHour: recentStarts });
        await notifyTelegram(`⏸️ Pluto paused: ${recentStarts} agent starts in the last hour (crash loop?). Check the logs, then Resume on the Pluto screen.`);
      }
    }
  }

  private async heartbeat(): Promise<void> {
    try {
      const health = sharedLiveConnection.getHealthSnapshot();
      await db("worker_health")
        .insert({ process_name: plutoProcessName, connected: health.connected, uptime_ms: Date.now() - this.startedAtMs, total_reconnects: health.totalReconnects, git_sha: readGitSha(), app_environment: readAppEnvironment(), updated_at: db.fn.now() })
        .onConflict("process_name")
        .merge();
    } catch (error) {
      console.warn(`Pluto heartbeat failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private async isAllowedToAct(): Promise<{ allowed: boolean; reason: string | null; insideWindow: boolean }> {
    const settings = this.settings!;
    const state = await loadPlutoState();
    const block = describePlutoBlock(state);
    if (block) return { allowed: false, reason: block, insideWindow: false };
    const now = new Date();
    const session = await computeMarketSessionStatus(now).catch(() => ({ state: "closed" as const }));
    const plutoSession = await resolvePlutoSession(now, settings);
    const insideWindow = session.state === "open" && isInsideTradingWindow(now, easternDateIso(now), plutoSession.windowStartEt, plutoSession.windowEndEt);
    return { allowed: true, reason: null, insideWindow };
  }

  private async housekeeping(): Promise<void> {
    if (this.stopped) return;
    try {
      this.settings = await loadPlutoSettings();
      this.marketWatch.updateSettings(this.settings);
      await this.adoptWorkingOrders();
      await this.pruneEventsOncePerDay();
      await this.labelCandidateOutcomesOncePerDay();
      const { allowed, insideWindow } = await this.isAllowedToAct();
      if (!allowed || !insideWindow) {
        if (this.watching) {
          await this.marketWatch.stop();
          this.watching = false;
          await recordPlutoEvent("lines_changed", { held: 0, reason: allowed ? "outside the trading window" : "not allowed to act" });
        }
        return;
      }
      const enabled: { symbol: string }[] = await db("shortlist_entries as se").join("tickers as t", "t.id", "se.ticker_id").whereNull("se.removed_at").where("se.bot_enabled", true).select("t.symbol");
      const symbols = enabled.map((row) => row.symbol).sort();
      const result = await this.marketWatch.watch(symbols);
      if (result.ok !== this.watching) await recordPlutoEvent("lines_changed", { held: result.ok ? symbols.length + 1 + this.settings.burstLines : 0, detail: result.detail });
      this.watching = result.ok;
      if (!result.ok) return;

      // The opening look (design item 74): once per session, when today's fit exists and the window is open.
      const todayIso = easternDateIso(new Date());
      if (this.openingLookDoneFor !== todayIso) {
        const fitToday = await db("option_chain_snapshots as s").join("option_surface_fits as f", "f.snapshot_id", "s.id").where("s.trading_date", todayIso).where("f.status", "ok").first("s.id");
        if (fitToday) {
          this.openingLookDoneFor = todayIso;
          this.enqueue("opening_look", [], { date: todayIso }, true);
        }
      }
    } catch (error) {
      console.error(`Pluto housekeeping failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private outcomesLabelledFor: string | null = null;
  /** Hold-to-expiry labels for every candidate offered in past passes, once the expiry has settled (backtest data). */
  private async labelCandidateOutcomesOncePerDay(): Promise<void> {
    const todayIso = easternDateIso(new Date());
    if (this.outcomesLabelledFor === todayIso) return;
    this.outcomesLabelledFor = todayIso;
    try {
      const result = await labelExpiredCandidateOutcomes();
      if (result.labelled > 0 || result.missingBars.length > 0) console.log(`Pluto: labelled ${result.labelled} candidate outcome(s), ${result.pending} pending expiry${result.missingBars.length > 0 ? `, no bar for ${result.missingBars.join(", ")}` : ""}.`);
    } catch (error) {
      console.warn(`Pluto: candidate outcome labelling failed — ${error instanceof Error ? error.message : error}`);
    }
  }

  /**
   * Orders IBKR may still be working that no watch in this process covers — after a restart, or a
   * deploy mid-session. Each gets a watch with its original clock, so the unfilled-cancel timeout and
   * the cancel-by-close still apply. Runs on boot and every housekeeping tick.
   */
  private async adoptWorkingOrders(): Promise<void> {
    if (!this.settings) return;
    try {
      const working = await loadWorkingPlutoOrders();
      const orphans = working.filter((order) => !this.watchedOrderIds.has(order.orderId));
      if (orphans.length === 0) return;
      const session = await resolvePlutoSession(new Date(), this.settings);
      for (const order of orphans) {
        await recordPlutoEvent("order_adopted", { actionId: order.actionId, orderId: order.orderId, symbol: order.symbol, description: order.description, ageMinutes: Math.round((Date.now() - order.createdAtMs) / 60_000) });
        this.context.trackWatch(
          watchPlutoOrder(this.api, this.settings, { actionId: order.actionId, orderId: order.orderId, symbol: order.symbol, reference: order.reference, description: order.description, cancelByMs: session.cancelByMs, startedAtMs: order.createdAtMs }),
          order.orderId,
        );
      }
      console.log(`Pluto: adopted ${orphans.length} working order(s) left from a previous process.`);
    } catch (error) {
      console.warn(`Pluto: could not adopt working orders — ${error instanceof Error ? error.message : error}`);
    }
  }

  private eventsPrunedFor: string | null = null;
  private async pruneEventsOncePerDay(): Promise<void> {
    const todayIso = easternDateIso(new Date());
    if (this.eventsPrunedFor === todayIso) return;
    this.eventsPrunedFor = todayIso;
    try {
      const pruned = await pruneOldPlutoEvents();
      if (pruned > 0) console.log(`Pluto: pruned ${pruned} timeline event(s) older than ${plutoEventsRetentionDays} days.`);
    } catch (error) {
      console.warn(`Pluto: event pruning failed — ${error instanceof Error ? error.message : error}`);
    }
  }

  private async pollDayQuotes(): Promise<void> {
    if (this.stopped || !this.watching) return;
    this.enqueue("day_quotes", [], {}, false);
  }

  /** Coalesces triggers into one pass per window; a forced trigger keeps the pass forced. */
  private enqueue(trigger: PlutoTrigger, symbols: string[], detail: Record<string, unknown>, force: boolean): void {
    if (this.stopped) return;
    for (const symbol of symbols) this.pendingSymbols.add(symbol);
    if (force || trigger === "spot_move" || this.pendingTrigger === "day_quotes") {
      this.pendingTrigger = force ? trigger : this.pendingTrigger === "spot_move" ? "spot_move" : trigger;
      this.pendingDetail = { ...this.pendingDetail, ...detail };
    }
    this.pendingForce = this.pendingForce || force;
    if (this.coalesceTimer) return;
    const windowMs = (this.settings?.coalescingWindowSeconds ?? 20) * 1000;
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null;
      const request = { trigger: this.pendingTrigger, triggerDetail: this.pendingDetail, symbols: this.pendingTrigger === "spot_move" ? [...this.pendingSymbols] : [], force: this.pendingForce };
      this.pendingSymbols.clear();
      this.pendingTrigger = "day_quotes";
      this.pendingDetail = {};
      this.pendingForce = false;
      this.passChain = this.passChain.then(() => this.runPassSafely(request));
    }, windowMs);
  }

  private async runPassSafely(request: { trigger: PlutoTrigger; triggerDetail: Record<string, unknown>; symbols: string[]; force: boolean }): Promise<void> {
    if (this.stopped) return;
    try {
      const summary = await runPlutoPass(request, this.context);
      console.log(`Pluto pass ${summary.passId} (${request.trigger}): ${summary.modelCalled ? `model called → ${summary.outcome}` : `skipped — ${summary.skippedReason}`}`);
    } catch (error) {
      console.error(`Pluto pass failed: ${error instanceof Error ? error.stack ?? error.message : error}`);
      await recordPlutoEvent("warning", { message: `pass failed: ${error instanceof Error ? error.message : String(error)}` }).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribeNotifications?.();
    for (const timer of this.timers) clearInterval(timer);
    if (this.coalesceTimer) clearTimeout(this.coalesceTimer);
    await this.passChain.catch(() => {});
    await this.marketWatch.stop();
    await Promise.race([Promise.allSettled([...this.watches]), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await recordPlutoEvent("agent_stopped", {}).catch(() => {});
  }
}

function currentRelease(): string | null {
  return process.env.HEROKU_RELEASE_VERSION ?? readGitSha();
}
