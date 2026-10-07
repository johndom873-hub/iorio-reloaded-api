import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Audit F (2026-10-07): startProcessMemoryMonitor end to end with the cgroup file, alert_state, the throttled sender and
// process.memoryUsage replaced. Telegram is mocked (dev .env has live credentials).

const mocks = vi.hoisted(() => ({
  cgroupFiles: new Map<string, string>(),
  alertStateRow: undefined as { alert_key: string } | undefined,
  alertStateReads: [] as string[],
  notifyDownThrottled: vi.fn(async () => true),
  clearDownState: vi.fn(async (): Promise<number | null> => 60_000),
  notifyTelegramTracked: vi.fn(async () => {}),
}));

vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));
vi.mock("./throttledAlert.js", () => ({ notifyDownThrottled: mocks.notifyDownThrottled, clearDownState: mocks.clearDownState }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: mocks.notifyTelegramTracked }));
vi.mock("../db/connection.js", () => ({
  db: (table: string) => ({
    where: (filter: { alert_key: string }) => ({
      first: async () => {
        mocks.alertStateReads.push(`${table}:${filter.alert_key}`);
        return mocks.alertStateRow;
      },
    }),
  }),
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const readFileSync = (file: string) => {
    const content = mocks.cgroupFiles.get(String(file));
    if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
    return content;
  };
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const { startProcessMemoryMonitor, readContainerMemoryLimitBytes, memoryLogIntervalMs } = await import("./processMemoryMonitor.js");

const mb = (value: number) => value * 1_048_576;
let rssBytes = mb(100);
let stop: (() => void) | null = null;

function usage(): NodeJS.MemoryUsage {
  return { rss: rssBytes, heapUsed: mb(20), heapTotal: mb(30), external: mb(2), arrayBuffers: mb(1) };
}

async function tick(rssMb: number): Promise<void> {
  rssBytes = mb(rssMb);
  await vi.advanceTimersByTimeAsync(memoryLogIntervalMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.cgroupFiles.clear();
  mocks.alertStateRow = undefined;
  mocks.alertStateReads.length = 0;
  mocks.notifyDownThrottled.mockClear();
  mocks.clearDownState.mockClear();
  mocks.clearDownState.mockImplementation(async () => 60_000);
  mocks.notifyTelegramTracked.mockClear();
  vi.spyOn(process, "memoryUsage").mockImplementation(usage as typeof process.memoryUsage);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  stop?.();
  stop = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("readContainerMemoryLimitBytes layouts", () => {
  it("reads cgroup v2 memory.max when the v1 file is missing", () => {
    expect(readContainerMemoryLimitBytes((file) => {
      if (file === "/sys/fs/cgroup/memory.max") return "536870912\n";
      throw new Error("ENOENT");
    })).toBe(536_870_912);
  });
  it("falls through a v1 unlimited sentinel to a real v2 limit", () => {
    const files: Record<string, string> = { "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n", "/sys/fs/cgroup/memory.max": "1073741824\n" };
    expect(readContainerMemoryLimitBytes((file) => files[file] ?? (() => { throw new Error("ENOENT"); })())).toBe(1_073_741_824);
  });
  it("treats empty, zero, negative and garbage contents as no limit", () => {
    for (const content of ["", "\n", "0", "-1", "abc", "max"]) expect(readContainerMemoryLimitBytes(() => content)).toBeNull();
  });
});

describe("startProcessMemoryMonitor", () => {
  it("logs a line every minute and never alerts or reads alert_state without a readable limit (a laptop)", async () => {
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno" });
    await tick(5_000);
    await tick(5_000);
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(vi.mocked(console.log).mock.calls[0]![0]).toBe("memory web: rss=5000MB swap=0MB heapUsed=20MB heapTotal=30MB external=2MB arrayBuffers=1MB");
    expect(mocks.alertStateReads).toEqual([]);
    expect(mocks.notifyDownThrottled).not.toHaveBeenCalled();
  });

  it("alerts at 90% with a constant text, stays quiet between 80% and 90%, recovers once under 80%", async () => {
    mocks.cgroupFiles.set("/sys/fs/cgroup/memory/memory.limit_in_bytes", String(mb(512)));
    stop = startProcessMemoryMonitor({ processName: "pluto_agent", label: "Pluto's agent" });
    await tick(450); // 87.9%: under, nothing
    expect(mocks.notifyDownThrottled).not.toHaveBeenCalled();
    await tick(461); // 90.04%
    await tick(700);
    expect(mocks.notifyDownThrottled).toHaveBeenCalledTimes(2);
    const [key, firstText, reminderMs] = mocks.notifyDownThrottled.mock.calls[0] as unknown as [string, string, number];
    const secondText = (mocks.notifyDownThrottled.mock.calls[1] as unknown as [string, string])[1];
    expect(key).toBe("memory:pluto_agent");
    expect(reminderMs).toBe(24 * 60 * 60_000);
    // notifyDownThrottled re-sends whenever the text changes, so it must not carry the reading.
    expect(secondText).toBe(firstText);
    expect(firstText).not.toMatch(/MB/);
    await tick(420); // 82%: still over
    expect(mocks.clearDownState).not.toHaveBeenCalled();
    await tick(400); // 78%: recovers
    await tick(300);
    expect(mocks.clearDownState).toHaveBeenCalledTimes(1);
    expect(mocks.clearDownState).toHaveBeenCalledWith("memory:pluto_agent");
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked.mock.calls[0]).toEqual(["✅ Pluto's agent is back under 80% of its dyno's memory."]);
  });

  it("announces the recovery after a restart when an episode was still open in alert_state", async () => {
    mocks.cgroupFiles.set("/sys/fs/cgroup/memory/memory.limit_in_bytes", String(mb(512)));
    mocks.alertStateRow = { alert_key: "memory:web" };
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno" });
    expect(mocks.alertStateReads).toEqual(["alert_state:memory:web"]);
    await tick(150);
    expect(mocks.clearDownState).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledTimes(1);
  });

  it("sends no recovery message when there was nothing to clear", async () => {
    mocks.cgroupFiles.set("/sys/fs/cgroup/memory.max", String(mb(512)));
    mocks.alertStateRow = { alert_key: "memory:web" };
    mocks.clearDownState.mockImplementation(async () => null);
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno" });
    await tick(150);
    expect(mocks.clearDownState).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked).not.toHaveBeenCalled();
  });

  it("does not clear anything on a fresh boot with no open episode", async () => {
    mocks.cgroupFiles.set("/sys/fs/cgroup/memory.max", String(mb(512)));
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno" });
    await tick(150);
    await tick(150);
    expect(mocks.clearDownState).not.toHaveBeenCalled();
  });

  it("still logs when the counts callback throws, and a failed alert send does not stop the timer", async () => {
    mocks.cgroupFiles.set("/sys/fs/cgroup/memory.max", String(mb(512)));
    mocks.notifyDownThrottled.mockImplementationOnce(async () => { throw new Error("db down"); });
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno", counts: () => { throw new Error("boom"); } });
    await tick(500);
    await tick(500);
    expect(console.log).toHaveBeenCalledTimes(2);
    expect(mocks.notifyDownThrottled).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("memory alert failed: db down"));
  });

  it("stops logging after the returned stop function runs", async () => {
    stop = startProcessMemoryMonitor({ processName: "web", label: "The API web dyno" });
    await tick(100);
    stop();
    stop = null;
    await tick(100);
    expect(console.log).toHaveBeenCalledTimes(1);
  });
});
