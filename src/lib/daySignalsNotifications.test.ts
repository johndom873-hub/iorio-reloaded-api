import { describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ telegram: [] as string[], published: [] as unknown[] }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: async (message: string) => void sent.telegram.push(message) }));
vi.mock("./notificationChannel.js", () => ({ publishNotification: async (notification: unknown) => void sent.published.push(notification) }));

import {
  assignmentRiskAlertAbsoluteDelta,
  assignmentRiskRearmAbsoluteDelta,
  clearsNotificationHysteresis,
  decideAssignmentRiskAlert,
  notificationHysteresisEdgeMargin,
  formatAssignmentRiskMessage,
  isGradeUpgrade,
  notifyAssignmentRisk,
  type AssignmentRiskAlert,
} from "./daySignalsNotifications.js";

describe("isGradeUpgrade", () => {
  it("counts only a strictly higher grade against a previously recorded one, and never a baseline (null)", () => {
    expect(isGradeUpgrade(null, "strong")).toBe(false);
    expect(isGradeUpgrade("weak", "good")).toBe(true);
    expect(isGradeUpgrade("good", "good")).toBe(false);
    expect(isGradeUpgrade("good", "weak")).toBe(false);
  });
});

describe("clearsNotificationHysteresis", () => {
  it("never clears into avoid, whatever the Edge margin", () => {
    expect(clearsNotificationHysteresis("avoid", 0)).toBe(false);
    expect(clearsNotificationHysteresis("avoid", -0.5)).toBe(false);
    expect(clearsNotificationHysteresis("avoid", 0.5)).toBe(false);
  });

  it("requires 2 points of Edge margin above each grade's own cut (Marcelo 2026-10-20)", () => {
    expect(notificationHysteresisEdgeMargin).toBe(0.02);
    // weak: cut 0%, so an Edge margin of 2% or more.
    expect(clearsNotificationHysteresis("weak", 0.019)).toBe(false);
    expect(clearsNotificationHysteresis("weak", 0.02)).toBe(true);
    // good: cut 10%, so 12% or more -- a contract wobbling on the 10% cut on quote noise does not re-notify.
    expect(clearsNotificationHysteresis("good", 0.1)).toBe(false);
    expect(clearsNotificationHysteresis("good", 0.119)).toBe(false);
    expect(clearsNotificationHysteresis("good", 0.12)).toBe(true);
    // strong: cut 20%, so 22% or more.
    expect(clearsNotificationHysteresis("strong", 0.2)).toBe(false);
    expect(clearsNotificationHysteresis("strong", 0.219)).toBe(false);
    expect(clearsNotificationHysteresis("strong", 0.22)).toBe(true);
  });
});

describe("decideAssignmentRiskAlert", () => {
  const armed = { notifiedAt: null, lastAlertTradingDateIso: null };
  const flagged = { notifiedAt: "2026-09-24T15:00:00.000Z", lastAlertTradingDateIso: "2026-09-24" };

  it("uses 0.50 to alert and 0.45 to re-arm", () => {
    expect(assignmentRiskAlertAbsoluteDelta).toBe(0.5);
    expect(assignmentRiskRearmAbsoluteDelta).toBe(0.45);
  });

  it("alerts an armed leg once |delta| reaches 0.50, on either side of zero", () => {
    expect(decideAssignmentRiskAlert(0.5, armed, "2026-09-24")).toBe("alert");
    expect(decideAssignmentRiskAlert(-0.62, armed, "2026-09-24")).toBe("alert");
    expect(decideAssignmentRiskAlert(-0.49, armed, "2026-09-24")).toBe("none");
  });

  it("keeps a flagged leg quiet while |delta| stays at or above 0.45, and re-arms it below", () => {
    expect(decideAssignmentRiskAlert(-0.7, flagged, "2026-09-24")).toBe("none");
    expect(decideAssignmentRiskAlert(0.45, flagged, "2026-09-24")).toBe("none");
    expect(decideAssignmentRiskAlert(-0.449, flagged, "2026-09-24")).toBe("rearm");
  });

  it("does not alert twice on the same Eastern trading day, even after re-arming", () => {
    const rearmedToday = { notifiedAt: null, lastAlertTradingDateIso: "2026-09-24" };
    expect(decideAssignmentRiskAlert(-0.55, rearmedToday, "2026-09-24")).toBe("none");
    expect(decideAssignmentRiskAlert(-0.55, rearmedToday, "2026-09-25")).toBe("alert");
  });
});

describe("assignment-risk notification", () => {
  const alert: AssignmentRiskAlert = {
    symbol: "HOOD",
    spotPrice: 113.42,
    leg: {
      legId: "leg-1", positionId: "pos-1", strategyKey: "cash_secured_put", expiry: "2026-10-16", strike: 116, right: "P", quantity: 1, entryPrice: 2.1, entryAtIso: "2026-09-10T14:00:00Z",
      dte: 17, delta: -0.5234, bid: 3.9, ask: 4.1, mid: 4, surfaceImpliedVolatility: 0.6, midImpliedVolatility: 0.61, dollarRisk: 11_200, quoteSource: "day", quotedAt: null, flags: ["assignment_risk"], unscoredReason: null, model: null,
    },
  };

  it("formats the Telegram message like the old assignment-risk line, with DTE, spot and where to look", () => {
    expect(formatAssignmentRiskMessage(alert)).toBe(["⚠️ HOOD — Assignment risk (spot below strike)", "$116.00P exp Oct 16 (17 DTE) · Δ-0.52 · spot $113.42", "Open: Signals → HOOD → Your positions"].join("\n"));
  });

  it("sends Telegram and publishes a persisted assignment_risk event carrying what the toast links to", async () => {
    sent.telegram.length = 0;
    sent.published.length = 0;
    await notifyAssignmentRisk(alert);
    expect(sent.telegram).toHaveLength(1);
    expect(sent.published).toEqual([
      { type: "assignment_risk", symbol: "HOOD", strategyKey: "cash_secured_put", positionId: "pos-1", legId: "leg-1", right: "P", strike: 116, expiry: "2026-10-16", dte: 17, delta: -0.5234, spotPrice: 113.42 },
    ]);
  });
});
