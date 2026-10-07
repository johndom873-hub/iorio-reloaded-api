import { beforeEach, describe, expect, it, vi } from "vitest";

// Audit (area A, 2026-10-07): runPlutoSystemChecks after the account summary moved to the 60 s cache and the daily-loss
// detail's snapshot date became text. Every dependency is mocked.

const harness = vi.hoisted(() => ({
  account: null as Record<string, unknown> | Error | null,
  previousSnapshot: { net_liquidation_value: "1000000", snapshot_date_iso: "2026-10-06" } as Record<string, unknown> | undefined,
  firstArgs: [] as unknown[][],
}));

vi.mock("../db/connection.js", () => {
  const chain = (table: string) => {
    const query: Record<string, unknown> = {};
    for (const method of ["where", "whereNull", "orderBy", "limit"]) query[method] = () => query;
    query.first = async (...args: unknown[]) => {
      if (table === "account_pnl_snapshots") {
        harness.firstArgs.push(args);
        return harness.previousSnapshot;
      }
      if (table === "job_runs") return { started_at: new Date("2026-10-07T14:55:00Z"), details: { reconciliationProblems: [] } };
      return {};
    };
    return query;
  };
  return { db: Object.assign((table: string) => chain(table), { raw: (sql: string) => ({ sql }) }) };
});
vi.mock("../ibkr/checkIbkrHealthJob.js", () => ({ reconciliationRunFailedPrefix: "reconciliation could not run" }));
vi.mock("./accountSummaryCache.js", () => ({
  fetchPlutoAccountSummary: async () => {
    if (harness.account instanceof Error) throw harness.account;
    return harness.account;
  },
}));
vi.mock("../lib/appEnvironment.js", () => ({ readAppEnvironment: () => "test" }));
vi.mock("../lib/marketSessionStatus.js", async () => {
  const { easternInstant } = await vi.importActual<typeof import("../lib/easternIsoDate.js")>("../lib/easternIsoDate.js");
  return { easternInstant, computeMarketSessionStatus: async () => ({ state: "open" }) };
});
vi.mock("../lib/platformControls.js", () => ({ fetchTradingHalt: async () => ({ enabled: false }) }));
vi.mock("../lib/tradingGate.js", () => ({ classifyTradingStatus: () => ({ state: "ok", reason: null }) }));
vi.mock("./counters.js", () => ({ loadPlutoTodayCounters: async () => ({ actionsToday: 0, modelCallsToday: 0, costTodayUsd: 0 }), countTrailingModelFailures: async () => 0 }));
vi.mock("./sessionSchedule.js", () => ({ resolvePlutoSession: async () => ({ windowStartEt: "09:45", windowEndEt: "15:30", closeTimeEt: "16:00", closeSource: "ibkr_liquid_hours", closeReadAt: "x", cancelByMs: 0 }) }));
vi.mock("./stateStore.js", () => ({ loadPlutoState: async () => ({ mode: "on", paused: false, breakers: {} }), describePlutoBlock: () => null }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn(), notifyTelegram: vi.fn() }));

const { runPlutoSystemChecks } = await import("./systemChecks.js");

const settings = { dailyLossBreakerPct: 3, dailyCostCeilingUsd: 5, maxActionsPerSession: 10, consecutiveModelFailuresBreaker: 3, windowEndEt: "15:30" } as never;
const at = new Date("2026-10-07T15:00:00Z"); // 11:00 ET

beforeEach(() => {
  harness.account = { netLiquidationValue: 990_000, totalCashValue: 400_000, buyingPower: null, grossPositionValue: null, excessLiquidity: null };
  harness.previousSnapshot = { net_liquidation_value: "1000000", snapshot_date_iso: "2026-10-06" };
  harness.firstArgs.length = 0;
});

describe("runPlutoSystemChecks (audit A)", () => {
  it("passes the cached summary's NLV and total cash to the round's context", async () => {
    const result = await runPlutoSystemChecks(settings, at);
    expect(result.failures).toEqual([]);
    expect(result.context.netLiquidationValue).toBe(990_000);
    expect(result.context.totalCashValue).toBe(400_000);
  });

  it("names the previous snapshot's date as plain text in the daily-loss detail, and asks for it as text", async () => {
    const result = await runPlutoSystemChecks(settings, at);
    expect(result.checks.daily_loss!.detail).toBe("-1.00% vs 2026-10-06 close (breaker at -3%)");
    expect(JSON.stringify(harness.firstArgs[0])).toContain("snapshot_date::text as snapshot_date_iso");
  });

  it("a failed summary fails account_data and daily_loss (fail closed) with no cash in the context", async () => {
    harness.account = new Error("Account summary timeout.");
    const result = await runPlutoSystemChecks(settings, at);
    expect(result.ok).toBe(false);
    expect(result.checks.account_data).toEqual({ ok: false, detail: "account summary failed: Account summary timeout." });
    expect(result.checks.daily_loss!.ok).toBe(false);
    expect(result.checks.daily_loss!.detail.startsWith("cannot compute")).toBe(true); // never trips the breaker
    expect(result.context.totalCashValue).toBeNull();
  });

  it("a summary without total cash still passes account_data (free cash then sizes from 0)", async () => {
    harness.account = { netLiquidationValue: 990_000, totalCashValue: null, buyingPower: null, grossPositionValue: null, excessLiquidity: null };
    const result = await runPlutoSystemChecks(settings, at);
    expect(result.checks.account_data!.ok).toBe(true);
    expect(result.context.totalCashValue).toBeNull();
  });

  it("uses the Eastern date for 'previous snapshot': 23:30 ET is still the same trading date", async () => {
    const lateEvening = new Date("2026-10-08T03:30:00Z"); // 23:30 ET on 10-07
    const result = await runPlutoSystemChecks(settings, lateEvening);
    expect(result.context.todayEasternIso).toBe("2026-10-07");
  });
});
