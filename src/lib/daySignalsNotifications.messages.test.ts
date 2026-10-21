import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ telegram: [] as string[], published: [] as unknown[], publishError: null as Error | null }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: async (message: string) => void sent.telegram.push(message) }));
vi.mock("./notificationChannel.js", () => ({
  publishNotification: async (notification: unknown) => {
    if (sent.publishError) throw sent.publishError;
    sent.published.push(notification);
  },
}));

import {
  formatAssignmentRiskMessage,
  formatRollSignalUpgradeMessage,
  formatSignalUpgradeMessage,
  notifyAssignmentRisk,
  notifyRollSignalUpgrade,
  notifySignalUpgrade,
  type AssignmentRiskAlert,
  type RollSignalUpgrade,
  type SignalUpgrade,
} from "./daySignalsNotifications.js";
import type { SignalCandidate } from "./signalCandidates.js";
import type { RollSignalCandidate } from "./rollSignalCandidates.js";
import { fixtureCandidateModel, fixtureRollModel } from "./testSupport/valuationModelFixtures.js";

const candidate: SignalCandidate = {
  strategyKey: "cash_secured_put",
  expiry: "2026-10-16",
  strike: 116,
  dte: 10,
  delta: -0.28,
  bid: 3.9,
  ask: 4.1,
  spreadPercent: 5,
  openInterest: null,
  volume: null,
  bidSize: null,
  askSize: null,
  surfaceImpliedVolatility: 0.6,
  midImpliedVolatility: 0.61,
  vega: 0.132,
  dollarRisk: 11_200,
  annualizedYield: 0.4567,
  uncompensatedSharePercent: null,
  quoteSource: "day",
  quotedAt: "2026-10-06T14:06:00Z",
  flags: [],
  executable: true,
  // Edge margin 15.4% grades Good; Edge Yield 39.8% a year on $11,200 of exposure, Edge $ 83.6.
  model: fixtureCandidateModel({ edgeMargin: 0.154, expectedAnnualizedReturn: 0.398, expectedPnlDollars: 83.6, capitalAtRiskDollars: 11_200 }),
};

const signalUpgrade: SignalUpgrade = { symbol: "HOOD", candidate, previousGrade: "weak", spotPrice: 113.4, quotedAt: "2026-10-06T14:06:00Z" };

const roll: RollSignalCandidate = {
  legId: "leg-1",
  positionId: "pos-1",
  strategyKey: "covered_call",
  quantity: 2,
  replacement: { ...candidate, strategyKey: "covered_call", strike: 120, expiry: "2026-11-20", dte: 45 },
  netCreditPerShare: 0.4,
  deltaChange: 0.05,
  dollarRiskChange: 100,
  flags: [],
  warnings: [],
  // Edge margin 25.6% grades Strong; $41.70 a contract net, $83.40 for the two.
  model: fixtureRollModel({ edgeMargin: 0.256, netExpectedPnlPerContract: 41.7, netExpectedPnl: 83.4 }),
};
const rollUpgrade: RollSignalUpgrade = { symbol: "AAPL", roll, held: { strike: 115, expiry: "2026-10-16", dte: 10 }, previousGrade: "avoid", spotPrice: 118, quotedAt: "2026-12-07T15:30:00Z" };

beforeEach(() => {
  sent.telegram.length = 0;
  sent.published.length = 0;
  sent.publishError = null;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("formatSignalUpgradeMessage", () => {
  it("renders the full put upgrade message with the quote time in Eastern daylight time", () => {
    expect(formatSignalUpgradeMessage(signalUpgrade)).toBe(
      [
        "▲ Signal upgraded — HOOD",
        "Put $116 · Oct 16 (10 DTE)",
        "Weak → Good",
        "Edge margin 15% · Edge Yield 40% ann. · Edge $ 84",
        "Spot $113.40 · quote 10:06 ET (day quotes)",
        "Open: Signals → HOOD",
      ].join("\n"),
    );
  });

  it("labels a covered call as Call and shows n/a without a quote time", () => {
    const message = formatSignalUpgradeMessage({ ...signalUpgrade, candidate: { ...candidate, strategyKey: "covered_call", model: { ...candidate.model, edgeMargin: 0.254, grade: "strong" } }, previousGrade: "avoid", quotedAt: null });
    expect(message.split("\n")).toEqual([
      "▲ Signal upgraded — HOOD",
      "Call $116 · Oct 16 (10 DTE)",
      "Avoid → Strong",
      "Edge margin 25% · Edge Yield 40% ann. · Edge $ 84",
      "Spot $113.40 · quote n/a (day quotes)",
      "Open: Signals → HOOD",
    ]);
  });

  it("converts the quote time to Eastern standard time in winter", () => {
    expect(formatSignalUpgradeMessage({ ...signalUpgrade, quotedAt: "2026-12-07T15:30:00Z" })).toContain("quote 10:30 ET (day quotes)");
  });

  it("uses a 24-hour clock for an afternoon quote", () => {
    expect(formatSignalUpgradeMessage({ ...signalUpgrade, quotedAt: "2026-10-06T19:45:00Z" })).toContain("quote 15:45 ET");
  });
});

describe("formatRollSignalUpgradeMessage", () => {
  it("renders the full roll upgrade message with the model's net roll $ and plural contracts", () => {
    expect(formatRollSignalUpgradeMessage(rollUpgrade)).toBe(
      [
        "▲ Roll signal upgraded — AAPL",
        "Call $115 (10 DTE) → Call $120 · Nov 20 (45 DTE)",
        "Avoid → Strong",
        "Edge margin 26% · +$83 for 2 contracts · net credit $0.40/sh",
        "Spot $118.00 · quote 10:30 ET (day quotes)",
        "Open: Signals → AAPL → Your positions",
      ].join("\n"),
    );
  });

  it("omits the held DTE when unknown, uses a minus sign for a negative net roll $, singular contract and Put", () => {
    const message = formatRollSignalUpgradeMessage({
      ...rollUpgrade,
      roll: { ...roll, strategyKey: "cash_secured_put", quantity: 1, model: { ...roll.model, netExpectedPnlPerContract: -12.6, netExpectedPnl: -12.6 }, netCreditPerShare: -0.05 },
      held: { strike: 115, expiry: "2026-10-16", dte: null },
      quotedAt: null,
    });
    expect(message.split("\n")).toEqual([
      "▲ Roll signal upgraded — AAPL",
      "Put $115 → Put $120 · Nov 20 (45 DTE)",
      "Avoid → Strong",
      "Edge margin 26% · −$13 for 1 contract · net credit −$0.05/sh",
      "Spot $118.00 · quote n/a (day quotes)",
      "Open: Signals → AAPL → Your positions",
    ]);
  });

  it("shows a zero net roll $ with a plus sign", () => {
    expect(formatRollSignalUpgradeMessage({ ...rollUpgrade, roll: { ...roll, model: { ...roll.model, netExpectedPnlPerContract: 0, netExpectedPnl: 0 } } })).toContain("+$0 for 2 contracts");
  });
});

describe("notifySignalUpgrade / notifyRollSignalUpgrade", () => {
  it("publishes a signal_upgraded event with the model's grade and figures and sends no Telegram message", async () => {
    await notifySignalUpgrade(signalUpgrade);
    expect(sent.published).toEqual([
      {
        type: "signal_upgraded",
        symbol: "HOOD",
        strategyKey: "cash_secured_put",
        strike: 116,
        expiry: "2026-10-16",
        dte: 10,
        previousGrade: "weak",
        grade: "good",
        edgeMargin: 0.154,
        edgeYield: 0.398,
        expectedPnlDollars: 83.6,
        exposureDollars: 11_200,
      },
    ]);
    expect(sent.telegram).toEqual([]);
  });

  it("swallows a publish failure and logs it with the symbol", async () => {
    sent.publishError = new Error("pg down");
    await expect(notifySignalUpgrade(signalUpgrade)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("day signals: could not notify the HOOD upgrade: pg down");
  });

  it("logs a non-Error failure verbatim", async () => {
    sent.publishError = "plain string" as unknown as Error;
    await notifySignalUpgrade(signalUpgrade);
    expect(console.error).toHaveBeenCalledWith("day signals: could not notify the HOOD upgrade: plain string");
  });

  it("publishes a roll_signal_upgraded event carrying the held leg, the replacement and the model's roll", async () => {
    await notifyRollSignalUpgrade(rollUpgrade);
    expect(sent.published).toEqual([
      {
        type: "roll_signal_upgraded",
        symbol: "AAPL",
        strategyKey: "covered_call",
        legId: "leg-1",
        heldStrike: 115,
        heldExpiry: "2026-10-16",
        heldDte: 10,
        strike: 120,
        expiry: "2026-11-20",
        dte: 45,
        previousGrade: "avoid",
        grade: "strong",
        edgeMargin: 0.256,
        netExpectedPnl: 83.4,
        netCreditPerShare: 0.4,
      },
    ]);
  });

  it("swallows a roll publish failure and logs it", async () => {
    sent.publishError = new Error("pg down");
    await expect(notifyRollSignalUpgrade(rollUpgrade)).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledWith("day signals: could not notify the AAPL roll upgrade: pg down");
  });
});

describe("assignment-risk message variants and failure handling", () => {
  const alert: AssignmentRiskAlert = {
    symbol: "HOOD",
    spotPrice: 120.5,
    leg: {
      legId: "leg-1", positionId: "pos-1", strategyKey: "covered_call", expiry: "2026-10-16", strike: 118, right: "C", quantity: 1, entryPrice: 2.1, entryAtIso: "2026-09-10T14:00:00Z",
      dte: null, delta: 0.6, bid: 3.9, ask: 4.1, mid: 4, surfaceImpliedVolatility: 0.6, midImpliedVolatility: 0.61, dollarRisk: 11_200, quoteSource: "day", quotedAt: null, flags: ["assignment_risk"], unscoredReason: null, model: null,
    },
  };

  it("says 'above' for a call, omits DTE when null and omits spot when null", () => {
    expect(formatAssignmentRiskMessage(alert).split("\n")).toEqual([
      "⚠️ HOOD — Assignment risk (spot above strike)",
      "$118.00C exp Oct 16 · Δ0.60 · spot $120.50",
      "Open: Signals → HOOD → Your positions",
    ]);
    expect(formatAssignmentRiskMessage({ ...alert, spotPrice: null }).split("\n")[1]).toBe("$118.00C exp Oct 16 · Δ0.60");
  });

  it("still sends Telegram when the persisted notification fails, and logs the failure", async () => {
    sent.publishError = new Error("pg down");
    await expect(notifyAssignmentRisk(alert)).resolves.toBeUndefined();
    expect(sent.telegram).toEqual([formatAssignmentRiskMessage(alert)]);
    expect(console.error).toHaveBeenCalledWith("day signals: could not publish the HOOD assignment-risk notification: pg down");
  });
});
