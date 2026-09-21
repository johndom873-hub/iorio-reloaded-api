import { afterEach, describe, expect, it, vi } from "vitest";
import { readExpirySettlementMode, summarizeExpirySettlement, type ExpirySettlementResult } from "./expirySettlementAudit.js";

afterEach(() => vi.unstubAllEnvs());

describe("readExpirySettlementMode", () => {
  it("accepts dry_run and apply", () => {
    vi.stubEnv("EXPIRY_SETTLEMENT_MODE", "apply");
    expect(readExpirySettlementMode()).toBe("apply");
    vi.stubEnv("EXPIRY_SETTLEMENT_MODE", "dry_run");
    expect(readExpirySettlementMode()).toBe("dry_run");
  });
  it("rejects anything else, and a missing value", () => {
    vi.stubEnv("EXPIRY_SETTLEMENT_MODE", "yes");
    expect(() => readExpirySettlementMode()).toThrow(/must be "dry_run" or "apply"/);
    vi.stubEnv("EXPIRY_SETTLEMENT_MODE", "");
    expect(() => readExpirySettlementMode()).toThrow(/Missing required environment variable/);
  });
});

describe("summarizeExpirySettlement", () => {
  const result: ExpirySettlementResult = {
    mode: "apply",
    legsExamined: 3,
    realizedPnlDelta: 437.5,
    actions: [
      { kind: "call_away_stock_exit", symbol: "AMAT", description: "AMAT call $437.5: stock exit -> strike" },
      { kind: "skipped", symbol: "AAOI", description: "AAOI put $107 ITM but shares untracked" },
    ],
  };

  it("separates corrections from skipped items and words the applied message", () => {
    const summary = summarizeExpirySettlement("apply", result);
    expect(summary.changes).toHaveLength(1);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.notify).toContain("APPLIED");
    expect(summary.notify).toContain("realized P&L +$437.50");
    expect(summary.notify).toContain("1 item(s) need manual review");
  });

  it("labels a dry run as changing nothing", () => {
    expect(summarizeExpirySettlement("dry_run", result).notify).toContain("DRY RUN — nothing changed");
  });

  it("never notifies for skipped items alone", () => {
    expect(summarizeExpirySettlement("apply", { ...result, actions: [result.actions[1]!] }).notify).toBeUndefined();
  });
});
