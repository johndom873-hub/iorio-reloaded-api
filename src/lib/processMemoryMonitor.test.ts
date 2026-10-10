import { describe, expect, it } from "vitest";
import { decideMemoryAlert, formatMemoryDetail, formatMemoryLine, parseSmapsBreakdown, readContainerMemoryLimitBytes, readProcessMemoryBreakdown, readProcessSwapBytes, summarizeHeapSpaces } from "./processMemoryMonitor.js";

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
    expect(formatMemoryLine("pluto_agent", usage, limit, { poolContracts: 11 })).toBe("memory pluto_agent: rss=805MB swap=0MB heapUsed=20MB heapTotal=33MB external=5MB arrayBuffers=2MB limit=512MB (157%) poolContracts=11");
    expect(formatMemoryLine("web", usage, null, {})).toBe("memory web: rss=805MB swap=0MB heapUsed=20MB heapTotal=33MB external=5MB arrayBuffers=2MB");
  });

  it("counts swap in the share of the limit (at the limit the excess is swapped out)", () => {
    const usage = { rss: mb(400), heapUsed: mb(20), heapTotal: mb(33), external: mb(5), arrayBuffers: mb(2) } as NodeJS.MemoryUsage;
    expect(formatMemoryLine("web", usage, mb(512), {}, mb(120))).toBe("memory web: rss=400MB swap=120MB heapUsed=20MB heapTotal=33MB external=5MB arrayBuffers=2MB limit=512MB (102%)");
  });
});

describe("readProcessSwapBytes", () => {
  it("reads VmSwap in kB from /proc/self/status, 0 when missing or unreadable", () => {
    expect(readProcessSwapBytes(() => "Name:\tnode\nVmRSS:\t  409600 kB\nVmSwap:\t  122880 kB\nThreads:\t11\n")).toBe(122880 * 1024);
    expect(readProcessSwapBytes(() => "Name:\tnode\n")).toBe(0);
    expect(
      readProcessSwapBytes(() => {
        throw new Error("ENOENT");
      }),
    ).toBe(0);
  });
});

// Excerpt in the /proc/self/smaps layout: the node binary, two resident 256 KB heap pages, one untouched 256 KB page,
// a 256 KB read-only mapping (not a heap page) and a larger anonymous region.
const smapsSample = [
  "55d4c0000000-55d4c3c00000 r-xp 00000000 08:01 1234 /app/.heroku/node/bin/node",
  "Size:              61440 kB",
  "Rss:               60468 kB",
  "Anonymous:             0 kB",
  "7f0000000000-7f0000040000 rw-p 00000000 00:00 0 ",
  "Rss:                 256 kB",
  "Anonymous:           256 kB",
  "7f0000040000-7f0000080000 rw-p 00000000 00:00 0",
  "Rss:                 252 kB",
  "Anonymous:           252 kB",
  "7f0000080000-7f00000c0000 rw-p 00000000 00:00 0",
  "Rss:                   0 kB",
  "Anonymous:             0 kB",
  "7f00000c0000-7f0000100000 r--p 00000000 00:00 0",
  "Rss:                 256 kB",
  "Anonymous:           256 kB",
  "7f1000000000-7f1000800000 rw-p 00000000 00:00 0",
  "Rss:                7900 kB",
  "Anonymous:          7900 kB",
].join("\n");

describe("parseSmapsBreakdown", () => {
  it("separates file-backed memory, anonymous memory and resident 256 KB heap pages", () => {
    expect(parseSmapsBreakdown(smapsSample)).toEqual({
      anonymousBytes: (256 + 252 + 256 + 7900) * 1024,
      fileBackedBytes: 60468 * 1024,
      v8PageMappings: 2,
      v8PageResidentBytes: (256 + 252) * 1024,
    });
  });
  it("is all zero for empty input", () => {
    expect(parseSmapsBreakdown("")).toEqual({ anonymousBytes: 0, fileBackedBytes: 0, v8PageMappings: 0, v8PageResidentBytes: 0 });
  });
  it("reads null where /proc is not there", () => {
    expect(readProcessMemoryBreakdown(() => { throw new Error("ENOENT"); })).toBeNull();
  });
});

describe("summarizeHeapSpaces", () => {
  it("groups V8's spaces into new, old, code, large objects and the rest", () => {
    expect(summarizeHeapSpaces([
      { space_name: "read_only_space", space_size: mb(1) },
      { space_name: "new_space", space_size: mb(16) },
      { space_name: "old_space", space_size: mb(24) },
      { space_name: "code_space", space_size: mb(3) },
      { space_name: "trusted_space", space_size: mb(1) },
      { space_name: "new_large_object_space", space_size: mb(2) },
      { space_name: "large_object_space", space_size: mb(5) },
      { space_name: "code_large_object_space", space_size: mb(1) },
    ])).toEqual({ new: mb(18), old: mb(24), code: mb(4), lo: mb(5), other: mb(2) });
  });
});

describe("formatMemoryDetail", () => {
  const detail = { physicalBytes: mb(44), mallocedBytes: mb(3), peakMallocedBytes: mb(20), nativeContexts: 1, detachedContexts: 0, spaceCommittedBytes: { new: mb(16), old: mb(24), code: mb(4), lo: mb(5), other: mb(2) } };
  it("appends V8's own figures and what the kernel sees", () => {
    expect(formatMemoryDetail(detail, { anonymousBytes: mb(249), fileBackedBytes: mb(65), v8PageMappings: 731, v8PageResidentBytes: mb(183) })).toBe(
      " v8Physical=44MB malloced=3MB peakMalloced=20MB contexts=1 detached=0 spaces=new:16,old:24,code:4,lo:5,other:2 anon=249MB fileBacked=65MB v8Pages=731 (183MB)",
    );
  });
  it("leaves the kernel part out where /proc could not be read", () => {
    expect(formatMemoryDetail(detail, null)).toBe(" v8Physical=44MB malloced=3MB peakMalloced=20MB contexts=1 detached=0 spaces=new:16,old:24,code:4,lo:5,other:2");
  });
});
