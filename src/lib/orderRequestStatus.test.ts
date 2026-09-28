import { describe, expect, it } from "vitest";
import { isInformationalIbkrOrderCode, isOrderRequestFinal, mapIbkrOrderStatus, rejectionErrorCodes } from "./orderRequestStatus.js";

describe("mapIbkrOrderStatus", () => {
  it("maps the working and filled states as before", () => {
    expect(mapIbkrOrderStatus("PreSubmitted", 0, 5)).toBe("submitted");
    expect(mapIbkrOrderStatus("Submitted", 0, 5)).toBe("submitted");
    expect(mapIbkrOrderStatus("Submitted", 2, 3)).toBe("partially_filled");
    expect(mapIbkrOrderStatus("Filled", 5, 0)).toBe("filled");
    expect(mapIbkrOrderStatus("PendingSubmit", 0, 5)).toBeNull();
  });

  it("a cancelled order with fills stays partially_filled instead of hiding the fills", () => {
    expect(mapIbkrOrderStatus("Cancelled", 2, 3)).toBe("partially_filled");
    expect(mapIbkrOrderStatus("ApiCancelled", 1, 4)).toBe("partially_filled");
    expect(mapIbkrOrderStatus("Cancelled", 0, 5)).toBe("cancelled");
  });

  it("Inactive is a rejection when nothing filled, partially_filled otherwise", () => {
    expect(mapIbkrOrderStatus("Inactive", 0, 5)).toBe("rejected");
    expect(mapIbkrOrderStatus("Inactive", 3, 2)).toBe("partially_filled");
  });
});

describe("isOrderRequestFinal", () => {
  it("final statuses are final regardless of IBKR's status", () => {
    for (const status of ["filled", "cancelled", "rejected", "error"]) expect(isOrderRequestFinal({ status })).toBe(true);
  });
  it("a partial fill is final only once IBKR stopped working the order", () => {
    expect(isOrderRequestFinal({ status: "partially_filled", ibkr_status: "Submitted" })).toBe(false);
    expect(isOrderRequestFinal({ status: "partially_filled", ibkr_status: null })).toBe(false);
    expect(isOrderRequestFinal({ status: "partially_filled", ibkr_status: "Cancelled" })).toBe(true);
    expect(isOrderRequestFinal({ status: "partially_filled", ibkr_status: "Inactive" })).toBe(true);
  });
  it("working states are never final", () => {
    for (const status of ["pending_confirmation", "confirmed", "submitted", "cancel_requested"]) expect(isOrderRequestFinal({ status, ibkr_status: "Submitted" })).toBe(false);
  });
});

describe("IBKR error codes", () => {
  it("keeps the informational codes out of the error path, including 202 for a cancel", () => {
    expect(isInformationalIbkrOrderCode(399)).toBe(true);
    expect(isInformationalIbkrOrderCode(202)).toBe(true);
    expect(isInformationalIbkrOrderCode(2104)).toBe(true);
    expect(isInformationalIbkrOrderCode(201)).toBe(false);
  });
  it("treats an order rejection as rejected, not error", () => {
    expect(rejectionErrorCodes.has(201)).toBe(true);
    expect(rejectionErrorCodes.has(110)).toBe(true);
    expect(rejectionErrorCodes.has(10148)).toBe(false);
  });
});
