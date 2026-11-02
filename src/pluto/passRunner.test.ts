import { beforeEach, describe, expect, it, vi } from "vitest";

// runPlutoPass: system checks, market stress and the opening-look wait in front of Vol Farmer v4's round, and the pass row
// closed whatever happens. The round, the ledger and the checks are mocked.

const harness = vi.hoisted(() => ({
  enabledSymbols: ["AAA", "BBB"],
  spyDayChangePct: 0.5 as number | null,
  systemChecksOk: true,
  netLiquidationValue: 1_000_000 as number | null,
  finishFailuresLeft: 0,
  roundThrows: null as unknown,
  rounds: [] as Record<string, unknown>[],
  outcome: { looked: [] as string[], planned: 0, sent: 0, notes: [] as string[] },
}));

vi.mock("./volFarmerV4Round.js", () => ({
  runVolFarmerV4Round: async (input: Record<string, unknown>) => {
    harness.rounds.push(input);
    if (harness.roundThrows !== null) throw harness.roundThrows;
    return harness.outcome;
  },
}));
vi.mock("../db/connection.js", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["join", "whereNull", "where"]) query[method] = () => query;
  query.select = async () => harness.enabledSymbols.map((symbol) => ({ symbol }));
  return { db: () => query };
});
vi.mock("./settingsStore.js", () => ({ loadPlutoSettings: async () => ({ safetySpyStressBreakerPct: 5 }) }));
vi.mock("./ledger.js", () => ({
  startPlutoPass: vi.fn(async () => "pass-1"),
  finishPlutoPass: vi.fn(async () => {
    if (harness.finishFailuresLeft > 0) {
      harness.finishFailuresLeft -= 1;
      throw new Error("finish write failed");
    }
  }),
  recordPlutoEvent: vi.fn(async () => {}),
}));
vi.mock("./stateStore.js", () => ({ loadPlutoState: async () => ({ breakers: {} }), recordPlutoPass: vi.fn(), tripPlutoBreaker: vi.fn() }));
vi.mock("./systemChecks.js", () => ({
  runPlutoSystemChecks: async () => ({
    failures: harness.systemChecksOk ? [] : ["account_data: account summary failed: timeout"],
    checks: harness.systemChecksOk ? {} : { account_data: { ok: false, detail: "account summary failed: timeout" } },
    context: { state: { stressOverrideDate: null }, todayEasternIso: "2026-10-07", session: { cancelByMs: 123 }, netLiquidationValue: harness.netLiquidationValue, totalCashValue: 400_000 },
  }),
}));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: vi.fn() }));

const { runPlutoPass } = await import("./passRunner.js");
const ledger = await import("./ledger.js");

const context = { api: {} as never, marketWatch: { spyDayChangePct: () => harness.spyDayChangePct } as never, trackWatch: () => {} };
const round = (symbols: string[], overrides: Record<string, unknown> = {}) => ({ trigger: "band_quotes_update" as const, triggerDetail: {}, symbols, force: false, ...overrides });

beforeEach(() => {
  harness.spyDayChangePct = 0.5;
  harness.systemChecksOk = true;
  harness.netLiquidationValue = 1_000_000;
  harness.finishFailuresLeft = 0;
  harness.roundThrows = null;
  harness.rounds.length = 0;
  harness.outcome = { looked: [], planned: 0, sent: 0, notes: [] };
  vi.mocked(ledger.finishPlutoPass).mockClear();
  vi.mocked(ledger.recordPlutoEvent).mockClear();
});

describe("runPlutoPass", () => {
  it("runs Vol Farmer v4's round with the account's figures and the round's symbols, and reports a sent order as a trade", async () => {
    harness.outcome = { looked: ["AAA"], planned: 2, sent: 1, notes: [] };
    const summary = await runPlutoPass(round(["AAA"]), context);
    expect(harness.rounds).toEqual([expect.objectContaining({ passId: "pass-1", todayIso: "2026-10-07", totalCashValue: 400_000, netLiquidationValue: 1_000_000, cancelByMs: 123, symbols: ["AAA"], stressed: false })]);
    expect(summary).toEqual({ passId: "pass-1", skippedReason: null, outcome: "trade" });
    expect(ledger.finishPlutoPass).toHaveBeenCalledWith("pass-1", expect.objectContaining({ candidateCount: 2, skippedReason: null }));
  });

  it("names every enabled ticker on a round without symbols of its own", async () => {
    await runPlutoPass(round([]), context);
    expect(ledger.recordPlutoEvent).toHaveBeenCalledWith("pass_started", { passId: "pass-1", trigger: "band_quotes_update", symbols: ["AAA", "BBB"] });
    expect(harness.rounds[0]).toMatchObject({ symbols: [] });
  });

  it("says why nothing was sent", async () => {
    harness.outcome = { looked: ["AAA"], planned: 0, sent: 0, notes: ["AAA: no previous-session option volume was captured, so nothing can be sold (the 20% rule)"] };
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("no order planned (1 ticker(s) looked at; AAA: no previous-session option volume was captured, so nothing can be sold (the 20% rule))");
    harness.outcome = { looked: ["AAA"], planned: 1, sent: 0, notes: [] };
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("none of the 1 planned order(s) was sent");
  });

  it("keeps the round's notes on the pass, a pass that sent an order included", async () => {
    harness.outcome = { looked: ["BBB", "CCC"], planned: 1, sent: 1, notes: ["CCC: no cycle opened: a lot costs $39,431, more than half the pot ($36,907)"] };
    await runPlutoPass(round([]), context);
    expect(ledger.finishPlutoPass).toHaveBeenCalledWith("pass-1", expect.objectContaining({ skippedReason: null, notes: ["CCC: no cycle opened: a lot costs $39,431, more than half the pot ($36,907)"] }));
  });

  it("runs Vol Farmer v4 stressed (its LEAPS and share sales only) from the SPY stress level", async () => {
    harness.spyDayChangePct = -4.9;
    await runPlutoPass(round(["AAA"]), context);
    expect(harness.rounds.at(-1)).toMatchObject({ stressed: false });
    harness.spyDayChangePct = -5.2;
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("market stress: Pluto opens nothing while SPY is down");
    expect(harness.rounds.at(-1)).toMatchObject({ stressed: true });
  });

  it("skips on a failing system check without running the round", async () => {
    harness.systemChecksOk = false;
    expect(await runPlutoPass(round(["AAA"]), context)).toMatchObject({ skippedReason: "account_data: account summary failed: timeout", skippedOnSystemChecks: true });
    expect(harness.rounds).toHaveLength(0);
  });

  it("sells nothing before today's opening look, nor without a net liquidation value", async () => {
    expect((await runPlutoPass(round(["AAA"], { heldPositionsOnly: true }), context)).skippedReason).toBe("the strategies' orders wait for today's opening look");
    harness.netLiquidationValue = null;
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("no net liquidation value for the strategies' pots");
    expect(harness.rounds).toHaveLength(0);
  });

  it("a round that throws closes its pass as failed and rethrows", async () => {
    harness.roundThrows = new Error("worker unreachable");
    await expect(runPlutoPass(round(["AAA"]), context)).rejects.toThrow("worker unreachable");
    expect(ledger.finishPlutoPass).toHaveBeenLastCalledWith("pass-1", { skippedReason: "round failed: worker unreachable" });
  });

  it("a pass whose own finish write failed is closed as failed by the catch", async () => {
    harness.finishFailuresLeft = 1;
    await expect(runPlutoPass(round(["AAA"]), context)).rejects.toThrow("finish write failed");
    expect(ledger.finishPlutoPass).toHaveBeenLastCalledWith("pass-1", { skippedReason: "round failed: finish write failed" });
  });
});
