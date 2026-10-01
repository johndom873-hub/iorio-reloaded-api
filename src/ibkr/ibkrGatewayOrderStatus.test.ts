import { describe, expect, it } from "vitest";
import { requestStatusForOrderStatusEvent } from "./ibkrGatewayOrderStatus.js";

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
