import { describe, expect, it, vi } from "vitest";

vi.mock("../db/connection.js", () => ({ db: {} }));
const { buildJobDiedMidRunMessage, buildJobSucceededAfterFailuresMessage, buildJobStillFailingReminder, buildJobCompletedCleanAgainMessage, buildCompletedWithErrorsText } = await import("./runJob.js");

describe("runJob alert texts", () => {
  it("gives the abandoned run's start in Eastern time", () => {
    // 2026-10-04 22:00 UTC is Sunday 18:00 ET.
    expect(buildJobDiedMidRunMessage("daily_market_data_capture", new Date("2026-10-04T22:00:05Z"))).toBe(
      "⚠️ daily_market_data_capture died mid-run: the run started Sun 10-04 18:00 ET never finished (process killed or out of memory). A new run is starting.",
    );
  });

  it("names the failed runs in Eastern time, on the Eastern day (not the UTC one), with no downtime", () => {
    // 2026-10-03 02:30 UTC is still Friday 22:30 ET.
    expect(buildJobSucceededAfterFailuresMessage("daily_pnl_snapshot", 2, new Date("2026-10-03T02:30:00Z"))).toBe(
      "✅ daily_pnl_snapshot succeeded; the previous 2 runs (since Fri 10-02 22:30 ET) failed.",
    );
    // 2026-10-12 14:00 UTC is Monday 10:00 ET.
    expect(buildJobSucceededAfterFailuresMessage("option_chain_capture", 1, new Date("2026-10-12T14:00:16Z"))).toBe(
      "✅ option_chain_capture succeeded; the previous run (Mon 10-12 10:00 ET) failed.",
    );
  });

  it("reminds that a job is still failing, not down", () => {
    expect(buildJobStillFailingReminder("⚠️ ibkr_health_check failed: x", "2h", "6h")).toBe("⚠️ ibkr_health_check failed: x\n\n(Still failing after ~2h. Reminders are sent at most every 6h.)");
  });

  it("names the runs that completed with errors in Eastern time", () => {
    // 2026-10-12 22:00 UTC is Monday 18:00 ET.
    expect(buildJobCompletedCleanAgainMessage("daily_market_data_capture", 2, new Date("2026-10-12T22:00:25Z"))).toBe(
      "✅ daily_market_data_capture completed with no errors; the previous 2 runs (since Mon 10-12 18:00 ET) completed with errors.",
    );
    expect(buildJobCompletedCleanAgainMessage("daily_market_data_capture", 1, new Date("2026-10-13T22:00:18Z"))).toBe(
      "✅ daily_market_data_capture completed with no errors; the previous run (Tue 10-13 18:00 ET) completed with errors.",
    );
  });

  it("starts a completed-with-errors text with the error count", () => {
    expect(buildCompletedWithErrorsText({ errorCount: 1, message: "no implied volatility for TWST - no IV in the snapshot; 25 of 26 tickers complete" })).toBe(
      "1 error: no implied volatility for TWST - no IV in the snapshot; 25 of 26 tickers complete",
    );
    expect(buildCompletedWithErrorsText({ errorCount: 2, message: "x" })).toBe("2 errors: x");
  });
});
