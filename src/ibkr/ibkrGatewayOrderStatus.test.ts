import { describe, expect, it } from "vitest";
import { cancellationReasonForIbkrCancel, ibkrCancelReasonText, requestStatusForOrderStatusEvent } from "./ibkrGatewayOrderStatus.js";

describe("requestStatusForOrderStatusEvent", () => {
  it("records a cancel after a partial fill as its own status instead of leaving it partially_filled", () => {
    expect(requestStatusForOrderStatusEvent("Cancelled", 40, 60)).toBe("cancelled_partially_filled");
    expect(requestStatusForOrderStatusEvent("ApiCancelled", 40, 60)).toBe("cancelled_partially_filled");
  });

  it("records a cancel with nothing filled as cancelled", () => {
    expect(requestStatusForOrderStatusEvent("Cancelled", 0, 100)).toBe("cancelled");
    expect(requestStatusForOrderStatusEvent("ApiCancelled", 0, 100)).toBe("cancelled");
  });

  it("keeps an order that is still working with fills as partially_filled", () => {
    expect(requestStatusForOrderStatusEvent("Submitted", 40, 60)).toBe("partially_filled");
    expect(requestStatusForOrderStatusEvent("PreSubmitted", 40, 60)).toBe("partially_filled");
  });

  it("maps the plain statuses and ignores the rest", () => {
    expect(requestStatusForOrderStatusEvent("Filled", 100, 0)).toBe("filled");
    expect(requestStatusForOrderStatusEvent("Submitted", 0, 100)).toBe("submitted");
    expect(requestStatusForOrderStatusEvent("PreSubmitted", 0, 100)).toBe("submitted");
    expect(requestStatusForOrderStatusEvent("Inactive", 0, 100)).toBeNull();
    expect(requestStatusForOrderStatusEvent("PendingCancel", 0, 100)).toBeNull();
  });
});

describe("cancellationReasonForIbkrCancel", () => {
  const createdMorning = new Date("2026-09-29T14:29:00Z"); // 10:29 ET (EDT)
  it("is an expiry at or after the 16:00 ET close of the order's own day", () => {
    expect(cancellationReasonForIbkrCancel(createdMorning, new Date("2026-09-29T20:00:00Z"))).toBe("expired_at_close");
    expect(cancellationReasonForIbkrCancel(createdMorning, new Date("2026-09-29T20:30:35Z"))).toBe("expired_at_close");
  });
  it("is IBKR's own cancel before the close", () => {
    expect(cancellationReasonForIbkrCancel(createdMorning, new Date("2026-09-29T19:59:59Z"))).toBe("cancelled_by_ibkr");
  });
  it("is an expiry whenever the order was created on an earlier Eastern date (seen only after a restart)", () => {
    expect(cancellationReasonForIbkrCancel(createdMorning, new Date("2026-09-30T13:31:00Z"))).toBe("expired_at_close");
  });
  it("uses the Eastern close in standard time too", () => {
    const createdDecember = new Date("2026-12-01T15:00:00Z"); // 10:00 EST
    expect(cancellationReasonForIbkrCancel(createdDecember, new Date("2026-12-01T20:59:00Z"))).toBe("cancelled_by_ibkr");
    expect(cancellationReasonForIbkrCancel(createdDecember, new Date("2026-12-01T21:00:00Z"))).toBe("expired_at_close");
  });
});

describe("ibkrCancelReasonText", () => {
  it("is null for a plain expiry or requested cancel", () => {
    expect(ibkrCancelReasonText("Order Canceled - reason:")).toBeNull();
    expect(ibkrCancelReasonText("Order Canceled - reason:   ")).toBeNull();
    expect(ibkrCancelReasonText("Order Canceled")).toBeNull();
  });
  it("returns IBKR's reason when there is one", () => {
    expect(ibkrCancelReasonText("Order Canceled - reason:Not enough buying power")).toBe("Not enough buying power");
  });
});
