import { describe, expect, it } from "vitest";
import { classifyTradingStatus, findTradingBlockedReason, type WorkerHealthForTradingGate } from "./tradingGate.js";
import type { TradingHalt } from "./platformControls.js";

const now = Date.parse("2026-09-22T10:00:00Z");
const healthyRow: WorkerHealthForTradingGate = {
  updated_at: new Date(now - 20_000),
  app_environment: "staging",
  account_binding_status: "ok",
  account_binding_reason: "Bound to DUR854038.",
};

describe("findTradingBlockedReason", () => {
  it("allows a fresh, matching, bound worker", () => {
    expect(findTradingBlockedReason(healthyRow, "staging", now)).toBeNull();
  });
  it("blocks when the worker never reported", () => {
    expect(findTradingBlockedReason(undefined, "staging", now)).toMatch(/never reported/);
  });
  it("blocks on a stale heartbeat", () => {
    expect(findTradingBlockedReason({ ...healthyRow, updated_at: new Date(now - 300_000) }, "staging", now)).toMatch(/offline \(last heartbeat 5m ago\)/);
  });
  it("blocks when the worker's environment differs from the API's", () => {
    expect(findTradingBlockedReason(healthyRow, "production", now)).toMatch(/"staging" but this API is "production"/);
  });
  it("blocks a worker that predates the binding columns", () => {
    expect(findTradingBlockedReason({ ...healthyRow, account_binding_status: null }, "staging", now)).toMatch(/latest version/);
  });
  it("blocks on a mismatch and quotes the worker's reason", () => {
    const reason = findTradingBlockedReason({ ...healthyRow, account_binding_status: "mismatch", account_binding_reason: "Expected account A, but the Gateway reports B." }, "staging", now);
    expect(reason).toBe("Trading is blocked: Expected account A, but the Gateway reports B.");
  });
  it("blocks while binding is still pending", () => {
    expect(findTradingBlockedReason({ ...healthyRow, account_binding_status: "pending", account_binding_reason: "Connected; waiting for the Gateway to report its accounts." }, "staging", now)).toMatch(/waiting for the Gateway/);
  });
});

describe("classifyTradingStatus", () => {
  it("is ok for a fresh, matching, bound worker", () => {
    expect(classifyTradingStatus(healthyRow, "staging", now)).toEqual({ state: "ok", reason: null });
  });
  it("is offline when the worker never reported or its heartbeat is stale", () => {
    expect(classifyTradingStatus(undefined, "staging", now).state).toBe("offline");
    expect(classifyTradingStatus({ ...healthyRow, updated_at: new Date(now - 300_000) }, "staging", now).state).toBe("offline");
  });
  it("is blocked, not offline, for a live worker with a wrong environment, no binding report, or a mismatch", () => {
    expect(classifyTradingStatus(healthyRow, "production", now).state).toBe("blocked");
    expect(classifyTradingStatus({ ...healthyRow, account_binding_status: null }, "staging", now).state).toBe("blocked");
    expect(classifyTradingStatus({ ...healthyRow, account_binding_status: "mismatch", account_binding_reason: "x" }, "staging", now).state).toBe("blocked");
  });
});

describe("the trading halt (kill switch)", () => {
  const haltOff: TradingHalt = { enabled: false, reason: null, setByUserId: null, setByDisplayName: null, setAt: null };
  const haltOn: TradingHalt = { enabled: true, reason: "IBKR data looks wrong", setByUserId: "u1", setByDisplayName: "Marce", setAt: new Date(now - 5 * 60_000) };

  it("changes nothing while off", () => {
    expect(classifyTradingStatus(healthyRow, "staging", now, haltOff)).toEqual({ state: "ok", reason: null });
    expect(classifyTradingStatus(undefined, "staging", now, haltOff).state).toBe("offline");
  });
  it("outranks a healthy worker and names who, when and why", () => {
    expect(classifyTradingStatus(healthyRow, "staging", now, haltOn)).toEqual({
      state: "halted",
      reason: "Trading is halted — switched off by Marce 5m ago: IBKR data looks wrong",
    });
  });
  it("outranks an offline or blocked worker too", () => {
    expect(classifyTradingStatus(undefined, "staging", now, haltOn).state).toBe("halted");
    expect(classifyTradingStatus(healthyRow, "production", now, haltOn).state).toBe("halted");
  });
  it("reads sensibly without a setter or a reason", () => {
    const anonymous: TradingHalt = { enabled: true, reason: null, setByUserId: null, setByDisplayName: null, setAt: null };
    expect(findTradingBlockedReason(healthyRow, "staging", now, anonymous)).toBe("Trading is halted — switched off by an operator.");
  });
});
