import { describe, expect, it } from "vitest";
import { keepNewestEventPerOrder, type AppNotification } from "./notificationChannel.js";

const order = (orderId: string, at: string) => ({ notification: { type: "order_status", orderId } as AppNotification, occurredAt: at });
const job = (at: string) => ({ notification: { type: "job_started", jobName: "x" } as AppNotification, occurredAt: at });

describe("keepNewestEventPerOrder", () => {
  it("keeps one row per order — the newest — and every non-order event, in order", () => {
    const events = [order("A", "5"), order("A", "4"), job("3"), order("B", "2"), order("A", "1")];
    expect(keepNewestEventPerOrder(events).map((event) => event.occurredAt)).toEqual(["5", "3", "2"]);
  });
});
