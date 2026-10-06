import { describe, expect, it, vi } from "vitest";

vi.mock("../db/connection.js", () => ({ db: {} }));
const { buildJobDiedMidRunMessage, buildJobRecoveredMessage } = await import("./runJob.js");

describe("runJob alert texts", () => {
  it("gives the abandoned run's start in Eastern time", () => {
    // 2026-10-04 22:00 UTC is Sunday 18:00 ET.
    expect(buildJobDiedMidRunMessage("daily_market_data_capture", new Date("2026-10-04T22:00:05Z"))).toBe(
      "⚠️ daily_market_data_capture died mid-run: the run started Sun 10-04 18:00 ET never finished (process killed or out of memory). A new run is starting.",
    );
  });

  it("gives when the job went down in Eastern time, on the Eastern day (not the UTC one)", () => {
    // 2026-10-03 02:30 UTC is still Friday 22:30 ET.
    expect(buildJobRecoveredMessage("daily_pnl_snapshot", "2 failed attempts", new Date("2026-10-03T02:30:00Z"), "1 day")).toBe(
      "✅ daily_pnl_snapshot recovered after 2 failed attempts (was down since Fri 10-02 22:30 ET, ~1 day).",
    );
  });
});
