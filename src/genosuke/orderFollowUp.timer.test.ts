import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TelegramApi } from "./telegramApi.js";

// startOrderFollowUp's polling loop, with the database faked as a chain: `select` answers with the orders needing a notice
// and `update` records which order was marked as told.
const hoisted = vi.hoisted(() => ({
  ordersNeedingNotice: { current: [] as unknown[] },
  selectError: { current: null as Error | null },
  selectGate: { current: null as Promise<void> | null },
  selectCalls: { count: 0 },
  filters: [] as Array<{ method: string; args: unknown[] }>,
  marked: [] as Array<{ orderId: unknown; status: unknown }>,
}));

vi.mock("../db/connection.js", () => {
  function chainFor(table: string) {
    let whereArgument: unknown;
    const chain: Record<string, (...args: unknown[]) => unknown> = {};
    for (const method of ["join", "leftJoin", "where", "whereIn", "whereRaw", "orderBy"]) {
      chain[method] = (...args) => {
        if (method === "where") whereArgument = args[0];
        if (table.startsWith("order_requests as")) hoisted.filters.push({ method, args });
        return chain;
      };
    }
    chain.select = async () => {
      hoisted.selectCalls.count += 1;
      if (hoisted.selectGate.current) await hoisted.selectGate.current;
      if (hoisted.selectError.current) throw hoisted.selectError.current;
      return hoisted.ordersNeedingNotice.current;
    };
    chain.update = async (changes) => {
      hoisted.marked.push({ orderId: (whereArgument as { id: unknown }).id, status: (changes as { genosuke_notified_status: unknown }).genosuke_notified_status });
    };
    return chain;
  }
  return { db: Object.assign((table: string) => chainFor(table), { raw: (sql: string) => ({ rawSql: sql }) }) };
});

const { startOrderFollowUp } = await import("./orderFollowUp.js");

const sendMessage = vi.fn(async () => undefined);
const telegram = { sendMessage } as unknown as TelegramApi;

beforeAll(() => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  startOrderFollowUp(telegram, "chat-42", "genosuke-svc");
});

afterAll(() => {
  vi.useRealTimers();
});

describe("startOrderFollowUp", () => {
  it("does nothing until the first interval (5 seconds) has passed", async () => {
    await vi.advanceTimersByTimeAsync(4999);
    expect(hoisted.selectCalls.count).toBe(0);
  });

  it("restricts the poll to the service user's orders in the notifiable statuses and tells the chat about each", async () => {
    hoisted.ordersNeedingNotice.current = [{ id: "order-1", status: "submitted", errorMessage: null, cancellationReason: null, symbol: "AAOI" }];
    await vi.advanceTimersByTimeAsync(1);
    expect(hoisted.selectCalls.count).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("chat-42", "Working at IBKR: your AAOI order is placed and resting. I'll tell you when it fills or ends.");
    expect(hoisted.marked).toEqual([{ orderId: "order-1", status: "submitted" }]);
    expect(hoisted.filters.find((filter) => filter.method === "where" && Array.isArray(filter.args) && filter.args[0] === "u.username")!.args).toEqual(["u.username", "genosuke-svc"]);
    const statusFilter = hoisted.filters.find((filter) => filter.method === "whereIn")!;
    expect(statusFilter.args[1]).toEqual(["submitted", "partially_filled", "filled", "cancelled", "cancelled_partially_filled", "rejected", "error"]);
  });

  it("keeps polling every 5 seconds", async () => {
    hoisted.ordersNeedingNotice.current = [];
    const callsBefore = hoisted.selectCalls.count;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(hoisted.selectCalls.count - callsBefore).toBe(3);
  });

  it("never starts a second poller when called again", async () => {
    startOrderFollowUp(telegram, "chat-42", "genosuke-svc");
    const callsBefore = hoisted.selectCalls.count;
    await vi.advanceTimersByTimeAsync(5000);
    expect(hoisted.selectCalls.count - callsBefore).toBe(1);
  });

  it("logs a failed pass and carries on with the next one", async () => {
    hoisted.selectError.current = new Error("db down");
    await vi.advanceTimersByTimeAsync(5000);
    expect(console.error).toHaveBeenCalledWith("Genosuke: order follow-up pass failed", "db down");
    hoisted.selectError.current = null;
    hoisted.ordersNeedingNotice.current = [{ id: "order-2", status: "rejected", errorMessage: "no margin", cancellationReason: null, symbol: "TLT" }];
    sendMessage.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sendMessage).toHaveBeenCalledWith("chat-42", "❌ IBKR rejected the TLT order: no margin.");
  });

  it("does not start a new pass while the previous one is still running", async () => {
    hoisted.ordersNeedingNotice.current = [];
    let releaseSlowPass: () => void = () => {};
    hoisted.selectGate.current = new Promise<void>((resolve) => (releaseSlowPass = resolve));
    const callsBefore = hoisted.selectCalls.count;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(hoisted.selectCalls.count - callsBefore).toBe(1);
    hoisted.selectGate.current = null;
    releaseSlowPass();
    await vi.advanceTimersByTimeAsync(5000);
    expect(hoisted.selectCalls.count - callsBefore).toBe(2);
  });
});
