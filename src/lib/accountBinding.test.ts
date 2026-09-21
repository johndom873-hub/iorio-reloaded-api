import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateAccountBinding, findStaticBindingConfigProblem, noAccountsReportedTimeoutSeconds, readExpectedAccountId } from "./accountBinding.js";

const stagingParams = {
  expectedAccountId: "DUR854038",
  reportedAccountIds: ["DUR854038"],
  connected: true,
  secondsConnected: 120,
  configuredTradingMode: "paper" as const,
  appEnvironment: "staging" as const,
};

afterEach(() => vi.unstubAllEnvs());

describe("readExpectedAccountId", () => {
  it("returns one trimmed id", () => {
    vi.stubEnv("IBKR_EXPECTED_ACCOUNT_ID", " DUR854038 ");
    expect(readExpectedAccountId()).toBe("DUR854038");
  });
  it("rejects a list, a missing value", () => {
    vi.stubEnv("IBKR_EXPECTED_ACCOUNT_ID", "DUR1,DUR2");
    expect(() => readExpectedAccountId()).toThrow(/exactly one/);
    vi.stubEnv("IBKR_EXPECTED_ACCOUNT_ID", "");
    expect(() => readExpectedAccountId()).toThrow(/Missing required/);
  });
});

describe("findStaticBindingConfigProblem", () => {
  it("accepts a consistent staging paper setup", () => {
    expect(findStaticBindingConfigProblem(stagingParams)).toBeNull();
  });
  it("rejects a live account while IBKR_TRADING_MODE is paper", () => {
    expect(findStaticBindingConfigProblem({ ...stagingParams, expectedAccountId: "U1234567" })).toMatch(/looks live/);
  });
  it("rejects a live account outside production", () => {
    expect(findStaticBindingConfigProblem({ ...stagingParams, expectedAccountId: "U1234567", configuredTradingMode: "live" })).toMatch(/only production may trade live/);
  });
  it("allows production on a live account and on paper", () => {
    expect(findStaticBindingConfigProblem({ ...stagingParams, expectedAccountId: "U1234567", configuredTradingMode: "live", appEnvironment: "production" })).toBeNull();
    expect(findStaticBindingConfigProblem({ ...stagingParams, appEnvironment: "production" })).toBeNull();
  });
  it("rejects an unrecognised account id format", () => {
    expect(findStaticBindingConfigProblem({ ...stagingParams, expectedAccountId: "F999" })).toMatch(/neither a paper/);
  });
});

describe("evaluateAccountBinding", () => {
  it("is ok when the Gateway reports exactly the expected account", () => {
    expect(evaluateAccountBinding(stagingParams).status).toBe("ok");
  });
  it("is pending while disconnected and while waiting for accounts", () => {
    expect(evaluateAccountBinding({ ...stagingParams, connected: false, reportedAccountIds: [], secondsConnected: null }).status).toBe("pending");
    expect(evaluateAccountBinding({ ...stagingParams, reportedAccountIds: [], secondsConnected: 5 }).status).toBe("pending");
  });
  it("is a mismatch when no accounts arrive within the timeout", () => {
    const binding = evaluateAccountBinding({ ...stagingParams, reportedAccountIds: [], secondsConnected: noAccountsReportedTimeoutSeconds });
    expect(binding.status).toBe("mismatch");
    expect(binding.reason).toMatch(/no accounts/);
  });
  it("is a mismatch for a different account, and for extra accounts alongside the expected one", () => {
    expect(evaluateAccountBinding({ ...stagingParams, reportedAccountIds: ["DUR000000"] }).reason).toMatch(/Expected account DUR854038, but the Gateway reports DUR000000/);
    expect(evaluateAccountBinding({ ...stagingParams, reportedAccountIds: ["DUR854038", "U1234567"] }).status).toBe("mismatch");
  });
  it("is a mismatch on inconsistent config even when the Gateway matches", () => {
    expect(evaluateAccountBinding({ ...stagingParams, appEnvironment: "staging", expectedAccountId: "U1", reportedAccountIds: ["U1"], configuredTradingMode: "live" }).status).toBe("mismatch");
  });
});
