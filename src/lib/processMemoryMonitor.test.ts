import { describe, expect, it } from "vitest";
import { decideMemoryAlert, formatMemoryLine, readContainerMemoryLimitBytes } from "./processMemoryMonitor.js";

const limit = 512 * 1_048_576;
const mb = (value: number) => value * 1_048_576;

describe("decideMemoryAlert", () => {
  it("alerts at or above 90% of the limit, whatever the state (the throttled sender handles reminders)", () => {
    expect(decideMemoryAlert("under", mb(461), limit)).toBe("alert");
    expect(decideMemoryAlert("over", mb(805), limit)).toBe("alert");
    expect(decideMemoryAlert("under", mb(460), limit)).toBeNull();
  });
  it("recovers only under 80% once an episode is open", () => {
    expect(decideMemoryAlert("over", mb(420), limit)).toBeNull();
    expect(decideMemoryAlert("over", mb(409), limit)).toBe("recover");
    expect(decideMemoryAlert("under", mb(100), limit)).toBeNull();
  });
});

describe("readContainerMemoryLimitBytes", () => {
  it("reads the cgroup v1 limit", () => {
    expect(readContainerMemoryLimitBytes(() => "536870912\n")).toBe(536_870_912);
  });
  it("treats no file, 'max' and the unlimited sentinel as no limit", () => {
    expect(readContainerMemoryLimitBytes(() => { throw new Error("ENOENT"); })).toBeNull();
    expect(readContainerMemoryLimitBytes(() => "max\n")).toBeNull();
    expect(readContainerMemoryLimitBytes(() => "9223372036854771712")).toBeNull();
  });
});

describe("formatMemoryLine", () => {
  it("separates heap from native memory and shows the share of the limit", () => {
    const usage = { rss: mb(805), heapUsed: mb(20), heapTotal: mb(33), external: mb(5), arrayBuffers: mb(2) } as NodeJS.MemoryUsage;
    expect(formatMemoryLine("pluto_agent", usage, limit, { poolContracts: 11 })).toBe("memory pluto_agent: rss=805MB heapUsed=20MB heapTotal=33MB external=5MB arrayBuffers=2MB limit=512MB (157%) poolContracts=11");
    expect(formatMemoryLine("web", usage, null, {})).toBe("memory web: rss=805MB heapUsed=20MB heapTotal=33MB external=5MB arrayBuffers=2MB");
  });
});
