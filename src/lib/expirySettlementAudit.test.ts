import { afterEach, describe, expect, it, vi } from "vitest";
import { buildExpiryAuditFailureMessage, classifyAssignedChainSkip, readExpirySettlementMode, summarizeExpirySettlement, type ExpirySettlementAction, type ExpirySettlementResult } from "./expirySettlementAudit.js";

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
      { kind: "call_away_stock_exit", symbol: "AMAT", positionId: "11111111-1111-1111-1111-111111111111", description: "AMAT call $437.5: stock exit -> strike" },
      { kind: "skipped", symbol: "AAOI", positionId: "22222222-2222-2222-2222-222222222222", description: "AAOI put $107 ITM but shares untracked" },
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

describe("buildExpiryAuditFailureMessage", () => {
  const skipped = (description: string, informational?: boolean): ExpirySettlementAction => ({ kind: "skipped", symbol: "AAA", positionId: "p", description, informational });

  it("is undefined when nothing was skipped, or only informational waiting states were", () => {
    expect(buildExpiryAuditFailureMessage([])).toBeUndefined();
    expect(buildExpiryAuditFailureMessage([skipped("TLT put $81 assigned: stock chain is still open", true)])).toBeUndefined();
  });

  it("lists the actionable skips and ignores informational ones next to them", () => {
    const message = buildExpiryAuditFailureMessage([skipped("TLT put $81 assigned: stock chain is still open", true), skipped("AAOI put $107 (expiry 20260925): no daily bar for the expiry date")]);
    expect(message).toBe("1 expired leg(s) need review or could not be audited, AAOI put $107 (expiry 20260925) - no daily bar for the expiry date");
    expect(message).not.toContain("): ");
  });
});

describe("classifyAssignedChainSkip", () => {
  it("only a matching-but-still-open chain is a normal waiting state", () => {
    expect(classifyAssignedChainSkip(true, true)).toBe("informational");
    expect(classifyAssignedChainSkip(true, false)).toBeNull();
  });

  it("a share-total mismatch always needs review, open or not", () => {
    expect(classifyAssignedChainSkip(false, false)).toBe("needs_review");
    expect(classifyAssignedChainSkip(false, true)).toBe("needs_review");
  });
});
