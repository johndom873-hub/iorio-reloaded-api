import { beforeEach, describe, expect, it, vi } from "vitest";

// runPlutoPass (the CC + Put Ladder only since 2026-10-27): system checks, market stress and the opening-look wait in front of
// the ladder's round, and the pass row closed whatever happens. The ladder itself, the ledger and the checks are mocked.

const harness = vi.hoisted(() => ({
  enabledSymbols: ["AAA", "BBB"],
  spyDayChangePct: 0.5 as number | null,
  systemChecksOk: true,
  actionsCapReached: false,
  netLiquidationValue: 1_000_000 as number | null,
  finishFailuresLeft: 0,
  ladderThrows: null as unknown,
  ladderRounds: [] as Record<string, unknown>[],
  ladderOutcome: { looked: [] as string[], planned: 0, outcomes: [] as { outcome: string }[], notes: [] as string[] },
}));

vi.mock("./ladderRound.js", () => ({
  runLadderRound: async (input: Record<string, unknown>) => {
    harness.ladderRounds.push(input);
    if (harness.ladderThrows !== null) throw harness.ladderThrows;
    return harness.ladderOutcome;
  },
}));
vi.mock("../db/connection.js", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["join", "whereNull", "where"]) query[method] = () => query;
  query.select = async () => harness.enabledSymbols.map((symbol) => ({ symbol }));
  return { db: () => query };
});
vi.mock("./settingsStore.js", () => ({ loadPlutoSettings: async () => ({ ladderSpyStressBreakerPct: 5 }) }));
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
    failures: [...(harness.systemChecksOk ? [] : ["account_data: account summary failed: timeout"]), ...(harness.actionsCapReached ? ["actions_cap: 10 of 10 actions today"] : [])],
    checks: { ...(harness.systemChecksOk ? {} : { account_data: { ok: false, detail: "account summary failed: timeout" } }), ...(harness.actionsCapReached ? { actions_cap: { ok: false, detail: "10 of 10 actions today" } } : {}) },
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
  harness.actionsCapReached = false;
  harness.netLiquidationValue = 1_000_000;
  harness.finishFailuresLeft = 0;
  harness.ladderThrows = null;
  harness.ladderRounds.length = 0;
  harness.ladderOutcome = { looked: [], planned: 0, outcomes: [], notes: [] };
  vi.mocked(ledger.finishPlutoPass).mockClear();
  vi.mocked(ledger.recordPlutoEvent).mockClear();
});

describe("runPlutoPass", () => {
  it("runs the ladder's round with the account's figures and the round's symbols, and reports a sent order as a trade", async () => {
    harness.ladderOutcome = { looked: ["AAA"], planned: 2, outcomes: [{ outcome: "confirmed" }, { outcome: "blocked" }], notes: [] };
    const summary = await runPlutoPass(round(["AAA"]), context);
    expect(harness.ladderRounds).toEqual([expect.objectContaining({ passId: "pass-1", todayIso: "2026-10-07", totalCashValue: 400_000, netLiquidationValue: 1_000_000, cancelByMs: 123, symbols: ["AAA"] })]);
    expect(summary).toEqual({ passId: "pass-1", skippedReason: null, outcome: "trade" });
    expect(ledger.finishPlutoPass).toHaveBeenCalledWith("pass-1", expect.objectContaining({ candidateCount: 2, modelCalled: false, skippedReason: null }));
  });

  it("names every enabled ticker on a round without symbols of its own", async () => {
    await runPlutoPass(round([]), context);
    expect(ledger.recordPlutoEvent).toHaveBeenCalledWith("pass_started", { passId: "pass-1", trigger: "band_quotes_update", symbols: ["AAA", "BBB"] });
    expect(harness.ladderRounds[0]).toMatchObject({ symbols: [] });
  });

  it("says why nothing was sent", async () => {
    harness.ladderOutcome = { looked: ["AAA"], planned: 0, outcomes: [], notes: ["AAA: no previous-session option volume was captured, so nothing can be sold (the 20% rule)"] };
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("the ladder planned no sale (1 ticker(s) looked at; AAA: no previous-session option volume was captured, so nothing can be sold (the 20% rule))");
    harness.ladderOutcome = { looked: ["AAA"], planned: 1, outcomes: [{ outcome: "blocked" }], notes: [] };
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("none of the ladder's 1 planned sale(s) was sent");
  });

  it("stops at the ladder's SPY stress level", async () => {
    harness.spyDayChangePct = -4.9;
    await runPlutoPass(round(["AAA"]), context);
    expect(harness.ladderRounds).toHaveLength(1);
    harness.spyDayChangePct = -5.2;
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("market stress: the ladder sells nothing while SPY is down");
    expect(harness.ladderRounds).toHaveLength(1);
  });

  it("skips on a failing system check without running the ladder", async () => {
    harness.systemChecksOk = false;
    expect(await runPlutoPass(round(["AAA"]), context)).toMatchObject({ skippedReason: "account_data: account summary failed: timeout", skippedOnSystemChecks: true });
    expect(harness.ladderRounds).toHaveLength(0);
  });

  it("is not stopped by the day's actions cap alone, but is by the cap with another failing check", async () => {
    harness.actionsCapReached = true;
    await runPlutoPass(round(["AAA"]), context);
    expect(harness.ladderRounds).toHaveLength(1);
    harness.systemChecksOk = false;
    expect((await runPlutoPass(round(["AAA"]), context)).skippedOnSystemChecks).toBe(true);
    expect(harness.ladderRounds).toHaveLength(1);
  });

  it("sells nothing before today's opening look, nor without a net liquidation value", async () => {
    expect((await runPlutoPass(round(["AAA"], { heldPositionsOnly: true }), context)).skippedReason).toBe("the ladder's sales wait for today's opening look");
    harness.netLiquidationValue = null;
    expect((await runPlutoPass(round(["AAA"]), context)).skippedReason).toBe("no net liquidation value for the ladder's pots");
    expect(harness.ladderRounds).toHaveLength(0);
  });

  it("a round that throws closes its pass as failed and rethrows", async () => {
    harness.ladderThrows = new Error("worker unreachable");
    await expect(runPlutoPass(round(["AAA"]), context)).rejects.toThrow("worker unreachable");
    expect(ledger.finishPlutoPass).toHaveBeenLastCalledWith("pass-1", { skippedReason: "round failed: worker unreachable" });
  });

  it("a pass whose own finish write failed is closed as failed by the catch", async () => {
    harness.finishFailuresLeft = 1;
    await expect(runPlutoPass(round(["AAA"]), context)).rejects.toThrow("finish write failed");
    expect(ledger.finishPlutoPass).toHaveBeenLastCalledWith("pass-1", { skippedReason: "round failed: finish write failed" });
  });
});
