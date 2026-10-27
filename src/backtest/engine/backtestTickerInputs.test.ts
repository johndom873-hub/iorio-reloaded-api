import { describe, expect, it } from "vitest";
import { earningsDateKnownCalendarDaysAhead, earningsNotYetReported } from "./backtestTickerInputs.js";

const todayIso = "2026-03-02";

describe("earnings known on a backtest day", () => {
  it("drops a report made before today's open from the earnings that still count", () => {
    expect(earningsNotYetReported([{ dateIso: "2026-03-02", eventTime: "-1" }, { dateIso: "2026-03-02", eventTime: null }, { dateIso: "2026-02-27", eventTime: "1" }], todayIso)).toEqual(["2026-03-02"]);
  });

  it("knows an earnings date from 30 calendar days before it: 30 days out it is seen, 31 days out it is not", () => {
    expect(earningsDateKnownCalendarDaysAhead).toBe(30);
    // 2 March + 30 days = 1 April; 2 March + 31 days = 2 April.
    const earnings = [{ dateIso: "2026-04-01", eventTime: "1" }, { dateIso: "2026-04-02", eventTime: "1" }];
    expect(earningsNotYetReported(earnings, todayIso)).toEqual(["2026-04-01"]);
    expect(earningsNotYetReported(earnings, "2026-03-01")).toEqual([]);
    expect(earningsNotYetReported(earnings, "2026-03-03")).toEqual(["2026-04-01", "2026-04-02"]);
  });
});
