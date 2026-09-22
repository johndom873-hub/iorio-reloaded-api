import { describe, expect, it } from "vitest";
import { classifyTradingStatus, findTradingBlockedReason, type WorkerHealthForTradingGate } from "./tradingGate.js";

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
