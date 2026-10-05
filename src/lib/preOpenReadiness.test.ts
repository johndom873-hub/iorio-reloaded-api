import { describe, expect, it } from "vitest";
import type { InvariantResult } from "./dataInvariants.js";
import {
  buildReadinessMessage,
  configurationExpectationsFor,
  decideReadinessActions,
  emptyReadinessState,
  evaluateAccount,
  evaluateConfiguration,
  evaluateDatabase,
  evaluateDataChecks,
  evaluateHealthCheck,
  evaluateJobs,
  evaluateMarketData,
  evaluateOrderHygiene,
  evaluateOrderPath,
  evaluateSettings,
  evaluateUndeliveredAlerts,
  evaluateWorker,
  productionConfigurationExpectations,
  stagingConfigurationExpectations,
  summarizeReadiness,
  type ReadinessCheck,
  type ReadinessState,
  type WorkerHealthRow,
} from "./preOpenReadiness.js";

const now = new Date("2026-10-05T10:00:00Z");
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);

const everySecret = Object.fromEntries(productionConfigurationExpectations.filter((entry) => entry.secret).map((entry) => [entry.name, "set"]));
const goodProductionEnvironment: Record<string, string | undefined> = {
  ...everySecret,
  APP_ENVIRONMENT: "production",
  IBKR_TRADING_MODE: "live",
  IBKR_EXPECTED_ACCOUNT_ID: "U21518308",
  IBKR_MARKET_DATA_LINES_ENABLED: "true",
  DAY_SIGNALS_LOOP_ENABLED: "true",
  EXPIRY_SETTLEMENT_MODE: "apply",
  GENOSUKE_ENABLED: "true",
};

describe("evaluateConfiguration", () => {
  it("passes when production has every expected value, with the kill switch unset", () => {
    expect(evaluateConfiguration(goodProductionEnvironment, productionConfigurationExpectations)).toMatchObject({ status: "ok" });
  });

  it("names every wrong value: wrong mode, a paper account id in production, a feature off", () => {
    const result = evaluateConfiguration({ ...goodProductionEnvironment, IBKR_TRADING_MODE: "paper", IBKR_EXPECTED_ACCOUNT_ID: "DUR854038", DAY_SIGNALS_LOOP_ENABLED: "false" }, productionConfigurationExpectations);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain('IBKR_TRADING_MODE is "paper" (expected "live")');
    expect(result.detail).toContain('IBKR_EXPECTED_ACCOUNT_ID is "DUR854038"');
    expect(result.detail).toContain('DAY_SIGNALS_LOOP_ENABLED is "false" (expected "true")');
  });

  it("fails on a missing secret without ever printing the secret's value", () => {
    const result = evaluateConfiguration({ ...goodProductionEnvironment, FRED_API_KEY: "", TELEGRAM_CHAT_ID: undefined, OPENROUTER_API_KEY: "sk-very-secret" }, productionConfigurationExpectations);
    expect(result.detail).toContain("FRED_API_KEY is not set");
    expect(result.detail).toContain("TELEGRAM_CHAT_ID is not set");
    expect(result.detail).not.toContain("sk-very-secret");
  });

  it("fails when notifications are switched off, accepts false and empty", () => {
    expect(evaluateConfiguration({ ...goodProductionEnvironment, TELEGRAM_NOTIFICATIONS_DISABLED: "true" }, productionConfigurationExpectations).detail).toContain('TELEGRAM_NOTIFICATIONS_DISABLED is "true" (must be off)');
    expect(evaluateConfiguration({ ...goodProductionEnvironment, TELEGRAM_NOTIFICATIONS_DISABLED: "false" }, productionConfigurationExpectations).status).toBe("ok");
    expect(evaluateConfiguration({ ...goodProductionEnvironment, TELEGRAM_NOTIFICATIONS_DISABLED: "" }, productionConfigurationExpectations).status).toBe("ok");
  });

  it("holds staging to paper values and has no expectations for development", () => {
    const stagingEnvironment = { ...everySecret, APP_ENVIRONMENT: "staging", IBKR_TRADING_MODE: "paper", IBKR_EXPECTED_ACCOUNT_ID: "DUR854038", IBKR_MARKET_DATA_LINES_ENABLED: "true" };
    expect(evaluateConfiguration(stagingEnvironment, stagingConfigurationExpectations).status).toBe("ok");
    expect(evaluateConfiguration({ ...stagingEnvironment, IBKR_TRADING_MODE: "live" }, stagingConfigurationExpectations).status).toBe("fail");
    expect(configurationExpectationsFor("development")).toBeNull();
    expect(configurationExpectationsFor("production")).toBe(productionConfigurationExpectations);
  });
});

const goodWorker: WorkerHealthRow = {
  updatedAt: minutesAgo(0.3),
  connected: true,
  appEnvironment: "production",
  accountBindingStatus: "ok",
  accountBindingReason: null,
  ibkrAccountIds: ["U21518308"],
  detectedTradingMode: "live",
  configuredTradingMode: "live",
  gitSha: "460539e",
};
const expectedWorker = { appEnvironment: "production", accountId: "U21518308" };

describe("evaluateWorker", () => {
  it("passes for a fresh, connected, bound worker", () => {
    expect(evaluateWorker(goodWorker, now, expectedWorker)).toMatchObject({ status: "ok", detail: expect.stringContaining("U21518308") });
  });

  it("fails when the worker never reported", () => {
    expect(evaluateWorker(null, now, expectedWorker)).toMatchObject({ status: "fail", detail: "the worker has never reported in" });
  });

  it("fails on a stale heartbeat, a dropped Gateway link, the wrong environment and a pending or mismatched binding", () => {
    const result = evaluateWorker({ ...goodWorker, updatedAt: minutesAgo(10), connected: false, appEnvironment: "staging", accountBindingStatus: "pending", accountBindingReason: "Not connected to the IBKR Gateway." }, now, expectedWorker);
    expect(result.status).toBe("fail");
    for (const fragment of ["heartbeat is stale", "not connected to the IBKR Gateway", 'reports environment "staging"', "account binding is pending (Not connected to the IBKR Gateway.)"]) expect(result.detail).toContain(fragment);
  });

  it("fails on a paper/live mix-up and on the wrong or multiple accounts", () => {
    expect(evaluateWorker({ ...goodWorker, detectedTradingMode: "paper" }, now, expectedWorker).detail).toContain("configured for live but the Gateway account looks paper");
    expect(evaluateWorker({ ...goodWorker, ibkrAccountIds: ["DUR854038"] }, now, expectedWorker).detail).toContain("bound to DUR854038, expected U21518308");
    expect(evaluateWorker({ ...goodWorker, ibkrAccountIds: ["U21518308", "U1"] }, now, expectedWorker).status).toBe("fail");
    expect(evaluateWorker({ ...goodWorker, ibkrAccountIds: null }, now, expectedWorker).detail).toContain("bound to no account");
  });

  it("treats a heartbeat exactly at the limit as fresh and one second beyond as stale", () => {
    expect(evaluateWorker({ ...goodWorker, updatedAt: new Date(now.getTime() - 120_000) }, now, expectedWorker).status).toBe("ok");
    expect(evaluateWorker({ ...goodWorker, updatedAt: new Date(now.getTime() - 121_000) }, now, expectedWorker).status).toBe("fail");
  });
});

describe("evaluateOrderPath", () => {
  it("passes when IBKR answered the what-if, which also proves the Gateway is not read-only", () => {
    expect(evaluateOrderPath({ ok: true, probe: "SPY $500 put 20261120" })).toMatchObject({ status: "ok", detail: expect.stringContaining("SPY $500 put 20261120") });
    expect(evaluateOrderPath({ ok: true, probe: "x" }).detail).toContain("the Gateway is not in Read-Only mode");
  });

  it("names a read-only Gateway outright, by IBKR's code 321 or its wording, and says how to fix it", () => {
    const real = evaluateOrderPath({ ok: false, reason: "IBKR what-if rejected (321): Error validating request.-'bC' : cause - The API interface is currently in Read-Only mode." });
    expect(real.status).toBe("fail");
    expect(real.detail).toContain("the Gateway is in Read-Only API mode, so every order would be refused");
    expect(real.detail).toContain("READ_ONLY_API");
    expect(evaluateOrderPath({ ok: false, reason: "The API interface is currently in Read-Only mode." }).detail).toContain("Read-Only API mode");
  });

  it("reports any other refusal with IBKR's own reason and does not mislabel it as read-only", () => {
    const refused = evaluateOrderPath({ ok: false, reason: "IBKR what-if rejected (201): no trading permissions for this options strategy" });
    expect(refused).toMatchObject({ status: "fail", detail: expect.stringContaining("no trading permissions") });
    expect(refused.detail).not.toContain("Read-Only");
    expect(evaluateOrderPath({ ok: false, reason: "IBKR what-if timed out." }).detail).toBe("IBKR refused or did not answer a what-if order: IBKR what-if timed out.");
    expect(evaluateOrderPath({ ok: false, reason: "order id 13210 rejected" }).detail).not.toContain("Read-Only");
  });
});

describe("evaluateAccount", () => {
  const healthy = { netLiquidationValue: 100_000, totalCashValue: 60_000, buyingPower: 200_000, excessLiquidity: 50_000 };

  it("shows the figures and the largest put strike the position limit allows", () => {
    const result = evaluateAccount(healthy, 15);
    expect(result.status).toBe("ok");
    expect(result.detail).toContain("net liquidation $100,000");
    expect(result.detail).toContain("strike $150 (1 contract)");
  });

  it("fails without a summary, with no net liquidation value, and in a margin shortfall", () => {
    expect(evaluateAccount(null, 15).status).toBe("fail");
    expect(evaluateAccount({ ...healthy, netLiquidationValue: 0 }, 15).status).toBe("fail");
    expect(evaluateAccount({ ...healthy, netLiquidationValue: null }, 15).status).toBe("fail");
    expect(evaluateAccount({ ...healthy, excessLiquidity: -1 }, 15).detail).toContain("margin shortfall");
  });

  it("only warns when cash or buying power is missing, and skips the strike hint without settings", () => {
    expect(evaluateAccount({ ...healthy, buyingPower: null }, 15).status).toBe("warn");
    expect(evaluateAccount(healthy, null).detail).not.toContain("largest cash-secured put");
  });
});

describe("evaluateSettings", () => {
  const settings = { maxPositionPctOfPortfolio: 15, maxConcentrationPerTickerPct: 20, minCashReservePct: 5, deltaTargetMin: 0.2, deltaTargetMax: 0.4 };
  it("lists the limits and the band", () => {
    expect(evaluateSettings(settings)).toMatchObject({ status: "ok", detail: "max position 15%, per ticker 20%, cash reserve 5%, delta band 0.2-0.4" });
  });
  it("fails when unreadable and warns when a 0% limit would block every order", () => {
    expect(evaluateSettings(null).status).toBe("fail");
    expect(evaluateSettings({ ...settings, maxPositionPctOfPortfolio: 0 })).toMatchObject({ status: "warn", detail: expect.stringContaining("max position size is 0%") });
    expect(evaluateSettings({ ...settings, maxPositionPctOfPortfolio: 0, maxConcentrationPerTickerPct: 0 }).detail).toContain("max position size and max exposure per ticker is 0%");
  });
});

describe("evaluateOrderHygiene", () => {
  it("passes with no active order", () => {
    expect(evaluateOrderHygiene([], now).status).toBe("ok");
  });
  it("fails for any order still in flight, naming symbol and status once each", () => {
    const result = evaluateOrderHygiene([{ status: "submitted", symbol: "AAOI", createdAt: minutesAgo(900) }, { status: "submitted", symbol: "AAOI", createdAt: minutesAgo(800) }, { status: "confirmed", symbol: "COIN", createdAt: minutesAgo(5) }], now);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("3 order(s) still in flight");
    expect(result.detail).toContain("AAOI submitted, COIN confirmed");
  });
  it("warns only for built orders older than 15 minutes and ignores fresh ones", () => {
    expect(evaluateOrderHygiene([{ status: "pending_confirmation", symbol: "AAOI", createdAt: minutesAgo(16) }], now).status).toBe("warn");
    expect(evaluateOrderHygiene([{ status: "pending_confirmation", symbol: "AAOI", createdAt: minutesAgo(14) }], now).status).toBe("ok");
  });
});

describe("evaluateJobs and evaluateHealthCheck", () => {
  const run = (jobName: string, status: "success" | "failure" | "running" | null, errorMessage: string | null = null) => ({ jobName, startedAt: status ? minutesAgo(600) : null, status, errorMessage });
  it("passes when every latest run succeeded", () => {
    expect(evaluateJobs([run("a", "success"), run("b", "success")], [])).toMatchObject({ status: "ok", detail: expect.stringContaining("2 jobs") });
  });
  it("fails on a failed latest run (first line of the error) and on a job due but not started", () => {
    const result = evaluateJobs([run("daily_pnl_snapshot", "failure", "FRED timed out\nstack"), run("b", "success")], ["option_chain_structure_refresh"]);
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("failed: daily_pnl_snapshot (FRED timed out)");
    expect(result.detail).toContain("not started although due: option_chain_structure_refresh");
  });
  it("warns for a job that never ran, and treats a still-running job as not failing", () => {
    expect(evaluateJobs([run("a", null)], []).status).toBe("warn");
    expect(evaluateJobs([run("a", "running")], []).status).toBe("ok");
  });
  it("judges the health check by recency and result", () => {
    expect(evaluateHealthCheck(null, now).status).toBe("fail");
    expect(evaluateHealthCheck({ startedAt: minutesAgo(26), status: "success" }, now).status).toBe("fail");
    expect(evaluateHealthCheck({ startedAt: minutesAgo(25), status: "success" }, now).status).toBe("ok");
    expect(evaluateHealthCheck({ startedAt: minutesAgo(3), status: "failure" }, now).status).toBe("fail");
    expect(evaluateHealthCheck({ startedAt: minutesAgo(3), status: "running" }, now).status).toBe("ok");
  });
});

describe("evaluateDataChecks", () => {
  const invariants: InvariantResult[] = [
    { name: "Today's option-chain snapshots", ok: true, detail: "9 complete" },
    { name: "Surface fits", ok: false, detail: "no fitted expiry for AAOI" },
    { name: "Economic calendar", ok: false, detail: "captured 40 h ago" },
  ];
  it("names the session being judged, fails real problems and only warns for the calendars", () => {
    const checks = evaluateDataChecks(invariants, "2026-10-02");
    expect(checks.map((entry) => entry.status)).toEqual(["ok", "fail", "warn"]);
    expect(checks[1]!.name).toBe("Data: Surface fits (2026-10-02)");
  });
});

describe("evaluateMarketData", () => {
  const live = { symbol: "SPY", bid: 500.1, ask: 500.12, delta: null };
  const base = { linesEnabled: true, feedRefusal: null, stockProbe: live, optionProbe: null };
  it("passes before the open with a live stock quote", () => {
    expect(evaluateMarketData(base, "pre_open").map((entry) => entry.status)).toEqual(["ok", "ok"]);
  });
  it("fails when real-time lines are off or IBKR refuses prices", () => {
    expect(evaluateMarketData({ ...base, linesEnabled: false }, "pre_open")[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("switched off") });
    expect(evaluateMarketData({ ...base, feedRefusal: { code: 10197, message: "competing live session" } }, "pre_open")[0]).toMatchObject({ status: "fail", detail: expect.stringContaining("10197") });
  });
  it("only warns about a missing stock quote before the open but fails it at the open", () => {
    const empty = { ...base, stockProbe: { symbol: "SPY", bid: null, ask: null, delta: null } };
    expect(evaluateMarketData(empty, "pre_open")[1]!.status).toBe("warn");
    expect(evaluateMarketData({ ...empty, optionProbe: null }, "open")[1]!.status).toBe("fail");
    expect(evaluateMarketData({ ...base, stockProbe: null }, "pre_open")[1]!.status).toBe("warn");
    expect(evaluateMarketData({ ...base, stockProbe: { symbol: "SPY", bid: 0, ask: 0, delta: null } }, "open")[1]!.status).toBe("fail");
  });
  it("at the open also needs a two-sided option quote with a live delta", () => {
    const option = { symbol: "SPY", bid: 1.1, ask: 1.15, delta: -0.25 };
    expect(evaluateMarketData({ ...base, optionProbe: option }, "open")[2]).toMatchObject({ status: "ok", detail: expect.stringContaining("delta -0.25") });
    expect(evaluateMarketData({ ...base, optionProbe: { ...option, delta: null } }, "open")[2]).toMatchObject({ status: "fail", detail: expect.stringContaining("no live delta") });
    expect(evaluateMarketData({ ...base, optionProbe: { ...option, bid: null } }, "open")[2]).toMatchObject({ status: "fail", detail: expect.stringContaining("OPRA") });
    expect(evaluateMarketData(base, "open")[2]).toMatchObject({ status: "fail", detail: "no option contract could be probed" });
    expect(evaluateMarketData(base, "pre_open")).toHaveLength(2);
  });
});

describe("evaluateUndeliveredAlerts and evaluateDatabase", () => {
  it("warns about alerts Telegram could not deliver", () => {
    expect(evaluateUndeliveredAlerts(0).status).toBe("ok");
    expect(evaluateUndeliveredAlerts(2)).toMatchObject({ status: "warn", detail: "2 earlier alert(s) could not be delivered to Telegram" });
  });
  it("warns above 85% of connections or storage and fails when unreadable", () => {
    expect(evaluateDatabase(null).status).toBe("fail");
    expect(evaluateDatabase({ totalConnections: 8, maxConnections: 20, sizeBytes: 1, maxSizeBytes: 100 }).status).toBe("ok");
    expect(evaluateDatabase({ totalConnections: 18, maxConnections: 20, sizeBytes: 1, maxSizeBytes: 100 })).toMatchObject({ status: "warn", detail: "90% of its connections are in use" });
    expect(evaluateDatabase({ totalConnections: 1, maxConnections: 20, sizeBytes: 90, maxSizeBytes: 100 }).detail).toBe("90% of its storage is used");
    expect(evaluateDatabase({ totalConnections: 1, maxConnections: 20, sizeBytes: 90, maxSizeBytes: null }).status).toBe("ok");
  });
});

describe("summarizeReadiness and buildReadinessMessage", () => {
  const checks: ReadinessCheck[] = [
    { name: "Worker", status: "fail", detail: "offline" },
    { name: "Account", status: "ok", detail: "funded" },
    { name: "Telegram", status: "warn", detail: "1 undelivered" },
    { name: "Order path", status: "fail", detail: "refused" },
  ];
  it("is ready only without failures and signs the failing names in a stable order", () => {
    const verdict = summarizeReadiness(checks);
    expect(verdict.ready).toBe(false);
    expect(verdict.signature).toBe("Order path|Worker");
    expect(summarizeReadiness([checks[1]!, checks[2]!]).ready).toBe(true);
    expect(summarizeReadiness([checks[1]!]).signature).toBe("");
    expect(summarizeReadiness([...checks].reverse()).signature).toBe(verdict.signature);
  });
  it("words each message kind and lists problems, warnings and passes", () => {
    const verdict = summarizeReadiness(checks);
    const message = buildReadinessMessage({ kind: "first", dateIso: "2026-10-05", environment: "production", verdict });
    expect(message.split("\n")[0]).toBe("🚫 Pre-open check: NOT READY — production 2026-10-05");
    expect(message).toContain("❌ Worker: offline");
    expect(message).toContain("⚠️ Telegram: 1 undelivered");
    expect(message).toContain("✅ Account: funded");
    expect(message).toContain("reply to this message and Genosuke can send the 2FA push");
    expect(buildReadinessMessage({ kind: "final", dateIso: "d", environment: "production", verdict }).startsWith("🛑 FINAL pre-open check: NO-GO")).toBe(true);
    expect(buildReadinessMessage({ kind: "changed", dateIso: "d", environment: "production", verdict }).startsWith("🚫 Pre-open check: still NOT READY")).toBe(true);
    expect(buildReadinessMessage({ kind: "open", dateIso: "d", environment: "production", verdict }).startsWith("🛑 Market-open confirmation: NOT READY")).toBe(true);
    const green = summarizeReadiness([checks[1]!]);
    expect(buildReadinessMessage({ kind: "final", dateIso: "d", environment: "production", verdict: green }).split("\n")[0]).toContain("GO");
    expect(buildReadinessMessage({ kind: "final", dateIso: "d", environment: "production", verdict: green })).not.toContain("2FA");
    expect(buildReadinessMessage({ kind: "open", dateIso: "d", environment: "production", verdict: green }).startsWith("✅ Market-open confirmation")).toBe(true);
  });
});

describe("decideReadinessActions", () => {
  const summerDay = "2026-10-05"; // EDT: 6:00 ET = 10:00 UTC, 9:20 = 13:20, 9:35 = 13:35, 10:15 = 14:15
  const winterDay = "2026-11-09"; // EST: 6:00 ET = 11:00 UTC
  const at = (iso: string) => new Date(iso);
  const redPreOpen = (lastRunIso: string): ReadinessState => ({ ...emptyReadinessState, preOpenLastRunAtMs: at(lastRunIso).getTime(), preOpenSignature: "Worker" });

  it("does nothing before 6:00 ET, in summer and in winter time", () => {
    expect(decideReadinessActions(at("2026-10-05T09:59:00Z"), summerDay, emptyReadinessState)).toEqual([]);
    expect(decideReadinessActions(at("2026-11-09T10:59:00Z"), winterDay, emptyReadinessState)).toEqual([]);
  });

  it("starts at 6:00 ET with an announced pre-open run (10:00 UTC in summer, 11:00 UTC in winter)", () => {
    expect(decideReadinessActions(at("2026-10-05T10:00:00Z"), summerDay, emptyReadinessState)).toEqual([{ kind: "pre_open", announce: "always" }]);
    expect(decideReadinessActions(at("2026-11-09T11:00:00Z"), winterDay, emptyReadinessState)).toEqual([{ kind: "pre_open", announce: "always" }]);
  });

  it("catches up a late start: the first run is announced whenever the monitor first sees the day", () => {
    expect(decideReadinessActions(at("2026-10-05T12:00:00Z"), summerDay, emptyReadinessState)).toEqual([{ kind: "pre_open", announce: "always" }]);
  });

  it("does not repeat a green pre-open run", () => {
    const green: ReadinessState = { ...emptyReadinessState, preOpenLastRunAtMs: at("2026-10-05T10:00:00Z").getTime(), preOpenSignature: "" };
    expect(decideReadinessActions(at("2026-10-05T12:00:00Z"), summerDay, green)).toEqual([]);
  });

  it("re-checks a red run every 10 minutes, announcing only on change", () => {
    const state = redPreOpen("2026-10-05T10:00:00Z");
    expect(decideReadinessActions(at("2026-10-05T10:09:00Z"), summerDay, state)).toEqual([]);
    expect(decideReadinessActions(at("2026-10-05T10:10:00Z"), summerDay, state)).toEqual([{ kind: "pre_open", announce: "on_change" }]);
  });

  it("sends one FINAL verdict from 9:20 ET and never twice", () => {
    expect(decideReadinessActions(at("2026-10-05T13:19:00Z"), summerDay, redPreOpen("2026-10-05T13:15:00Z"))).toEqual([]);
    expect(decideReadinessActions(at("2026-10-05T13:20:00Z"), summerDay, redPreOpen("2026-10-05T13:15:00Z"))).toEqual([{ kind: "final" }]);
    expect(decideReadinessActions(at("2026-10-05T13:30:00Z"), summerDay, { ...redPreOpen("2026-10-05T13:15:00Z"), finalSent: true })).toEqual([]);
  });

  it("stops re-checking pre-open at 9:20 ET: the final run takes over", () => {
    expect(decideReadinessActions(at("2026-10-05T13:25:00Z"), summerDay, { ...redPreOpen("2026-10-05T13:00:00Z"), finalSent: true })).toEqual([]);
  });

  it("runs the live-data confirmation from 9:35 ET, announced, then every 2 minutes while red", () => {
    const afterFinal: ReadinessState = { ...emptyReadinessState, preOpenLastRunAtMs: 1, preOpenSignature: "", finalSent: true };
    expect(decideReadinessActions(at("2026-10-05T13:34:00Z"), summerDay, afterFinal)).toEqual([]);
    expect(decideReadinessActions(at("2026-10-05T13:35:00Z"), summerDay, afterFinal)).toEqual([{ kind: "open", announce: "always" }]);
    const redOpen: ReadinessState = { ...afterFinal, openLastRunAtMs: at("2026-10-05T13:35:00Z").getTime(), openSignature: "Live option quote" };
    expect(decideReadinessActions(at("2026-10-05T13:36:00Z"), summerDay, redOpen)).toEqual([]);
    expect(decideReadinessActions(at("2026-10-05T13:37:00Z"), summerDay, redOpen)).toEqual([{ kind: "open", announce: "on_change" }]);
    expect(decideReadinessActions(at("2026-10-05T13:50:00Z"), summerDay, { ...redOpen, openSignature: "" })).toEqual([]);
  });

  it("gives up on the morning at 10:15 ET", () => {
    const redEverything: ReadinessState = { preOpenLastRunAtMs: 1, preOpenSignature: "Worker", finalSent: false, openLastRunAtMs: 1, openSignature: "Worker" };
    expect(decideReadinessActions(at("2026-10-05T14:14:00Z"), summerDay, redEverything)).toEqual([{ kind: "final" }, { kind: "open", announce: "on_change" }]);
    expect(decideReadinessActions(at("2026-10-05T14:15:00Z"), summerDay, redEverything)).toEqual([]);
  });

  it("after a restart past 9:35 with no state at all, sends the final verdict and the open confirmation", () => {
    expect(decideReadinessActions(at("2026-10-05T13:40:00Z"), summerDay, emptyReadinessState)).toEqual([{ kind: "final" }, { kind: "open", announce: "always" }]);
  });
});
