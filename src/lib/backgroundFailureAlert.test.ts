import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyRateLimited = vi.fn();
const markRateLimitedRecovered = vi.fn();
const notifyTelegram = vi.fn(async (_message: string) => true);
const notifyTelegramTracked = vi.fn(async (_message: string) => {});

vi.mock("./throttledAlert.js", () => ({ notifyRateLimited, markRateLimitedRecovered }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked }));

const { reportBackgroundFailure, reportBackgroundRecovery, resetBackgroundFailureLimiterForTests, databaseCheckPrefilterMs, backgroundFailureIntervalMs } = await import("./backgroundFailureAlert.js");
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  resetBackgroundFailureLimiterForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  notifyRateLimited.mockResolvedValue(true);
});

describe("reportBackgroundFailure", () => {
  it("asks the database at most once per source per pre-filter window, however often it fails", async () => {
    for (let i = 0; i < 500; i++) reportBackgroundFailure("signals:live-prices", "boom", 1_000_000 + i * 10);
    await flush();
    expect(notifyRateLimited).toHaveBeenCalledTimes(1);
    reportBackgroundFailure("signals:live-prices", "boom", 1_000_000 + databaseCheckPrefilterMs + 1);
    reportBackgroundFailure("signals:other", "boom");
    await flush();
    expect(notifyRateLimited).toHaveBeenCalledTimes(3);
  });

  it("adds the warning prefix unless the message already starts with an emoji", async () => {
    reportBackgroundFailure("a", "plain failure");
    reportBackgroundFailure("b", "🔥 already marked");
    await flush();
    expect(notifyRateLimited).toHaveBeenCalledWith("bg_failure:a", "⚠️ plain failure", backgroundFailureIntervalMs);
    expect(notifyRateLimited).toHaveBeenCalledWith("bg_failure:b", "🔥 already marked", backgroundFailureIntervalMs);
  });

  it("still alerts, once per hour, when the database is the thing that is down", async () => {
    notifyRateLimited.mockRejectedValue(new Error("ECONNREFUSED"));
    const start = 5_000_000;
    reportBackgroundFailure("day-signals:quote-write", "could not save quotes", start);
    await flush();
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifyTelegram).toHaveBeenCalledWith("⚠️ could not save quotes");
    reportBackgroundFailure("day-signals:quote-write", "could not save quotes", start + databaseCheckPrefilterMs + 1);
    await flush();
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    reportBackgroundFailure("day-signals:quote-write", "could not save quotes", start + backgroundFailureIntervalMs + 1);
    await flush();
    expect(notifyTelegram).toHaveBeenCalledTimes(2);
  });

  it("never throws or rejects, even when the fallback send fails", async () => {
    notifyRateLimited.mockRejectedValue(new Error("db down"));
    notifyTelegram.mockRejectedValueOnce(new Error("telegram down"));
    expect(() => reportBackgroundFailure("x", "y")).not.toThrow();
    await flush();
  });
});

describe("reportBackgroundRecovery", () => {
  it("announces recovery only when an unrecovered alert existed", async () => {
    markRateLimitedRecovered.mockResolvedValueOnce(null).mockResolvedValueOnce(90_000);
    reportBackgroundRecovery("day-signals:cycle", "Day Signals loop cycles are completing again");
    reportBackgroundRecovery("day-signals:cycle", "Day Signals loop cycles are completing again");
    await flush();
    expect(notifyTelegramTracked).toHaveBeenCalledTimes(1);
    expect(notifyTelegramTracked.mock.calls[0]![0]).toContain("✅ Day Signals loop cycles are completing again (was failing ~");
  });

  it("measures the duration from when the failure began when given, not from the first alert", async () => {
    markRateLimitedRecovered.mockResolvedValueOnce(3 * 60_000);
    reportBackgroundRecovery("shared-ibkr:API", "The API's shared IBKR connections are back", Date.now() - 14 * 60_000);
    await flush();
    expect(notifyTelegramTracked).toHaveBeenCalledWith("✅ The API's shared IBKR connections are back (was failing ~14m).");
  });

  it("does not throw when the database is unavailable", async () => {
    markRateLimitedRecovered.mockRejectedValue(new Error("db down"));
    reportBackgroundRecovery("x", "y");
    await flush();
    expect(notifyTelegramTracked).not.toHaveBeenCalled();
  });
});
