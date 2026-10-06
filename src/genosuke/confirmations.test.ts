import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfirmation, takeConfirmation } from "./confirmations.js";

const tenMinutesMs = 10 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-05T15:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createConfirmation", () => {
  it("stores everything the card needs and gives each confirmation a distinct id", () => {
    const input = { ip: "1.2.3.4" };
    const prepared = { orderId: "order-1" };
    const first = createConfirmation("chat-1", "unblock_ip", input, "Unblock IP 1.2.3.4", prepared);
    const second = createConfirmation("chat-1", "unblock_ip", input, "Unblock IP 1.2.3.4");
    expect(first.id).not.toBe(second.id);
    expect(first).toMatchObject({ chatId: "chat-1", toolName: "unblock_ip", description: "Unblock IP 1.2.3.4", createdAt: Date.now() });
    expect(first.input).toBe(input);
    expect(first.prepared).toBe(prepared);
    expect(second.prepared).toBeUndefined();
  });
});

describe("takeConfirmation", () => {
  it("returns the confirmation once and nothing the second time (one-shot)", () => {
    const created = createConfirmation("chat-1", "remove_waf_rule", { ruleId: "r1" }, "Remove rule r1");
    expect(takeConfirmation(created.id)).toBe(created);
    expect(takeConfirmation(created.id)).toBeNull();
  });

  it("returns null for an id that was never created", () => {
    expect(takeConfirmation("not-a-real-id")).toBeNull();
  });

  it("keeps the confirmation valid right up to the 10 minute limit", () => {
    const created = createConfirmation("chat-1", "remove_waf_rule", {}, "x");
    vi.advanceTimersByTime(tenMinutesMs);
    expect(takeConfirmation(created.id)).toBe(created);
  });

  it("refuses a confirmation one millisecond past the limit, and consumes it", () => {
    const created = createConfirmation("chat-1", "remove_waf_rule", {}, "x");
    vi.advanceTimersByTime(tenMinutesMs + 1);
    expect(takeConfirmation(created.id)).toBeNull();
    vi.setSystemTime(new Date("2026-01-05T15:00:00Z"));
    expect(takeConfirmation(created.id)).toBeNull();
  });

  it("resolves each confirmation independently", () => {
    const first = createConfirmation("chat-1", "unblock_ip", { ip: "1.1.1.1" }, "one");
    const second = createConfirmation("chat-1", "unblock_ip", { ip: "2.2.2.2" }, "two");
    expect(takeConfirmation(second.id)).toBe(second);
    expect(takeConfirmation(first.id)).toBe(first);
  });

  it("sweeps expired confirmations when a new one is created, leaving fresh ones untouched", () => {
    const stale = createConfirmation("chat-1", "unblock_ip", {}, "stale");
    vi.advanceTimersByTime(tenMinutesMs - 1000);
    const fresh = createConfirmation("chat-1", "unblock_ip", {}, "fresh");
    vi.advanceTimersByTime(2000);
    createConfirmation("chat-1", "unblock_ip", {}, "trigger sweep");
    expect(takeConfirmation(stale.id)).toBeNull();
    expect(takeConfirmation(fresh.id)).toBe(fresh);
  });
});

describe("chat scoping", () => {
  // The store itself does not filter by chat: bot.ts only ever offers a confirmation to the one allowed chat
  // and drops callbacks from any other chat before taking it. These tests pin what the store records for that check.
  it("records which chat the confirmation belongs to, so a caller can refuse a tap from another chat", () => {
    const created = createConfirmation("chat-A", "unblock_ip", {}, "x");
    const taken = takeConfirmation(created.id);
    expect(taken!.chatId).toBe("chat-A");
    expect(taken!.chatId).not.toBe("chat-B");
  });
});
