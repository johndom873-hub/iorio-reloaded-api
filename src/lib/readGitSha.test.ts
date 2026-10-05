import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFileSync: execFileSyncMock }));

describe("readGitSha", () => {
  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    vi.restoreAllMocks();
  });

  it("forks git and warns only once when git is missing, then keeps returning null", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("spawnSync git ENOENT");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { readGitSha } = await import("./readGitSha.js");

    expect(readGitSha()).toBeNull();
    expect(readGitSha()).toBeNull();
    expect(readGitSha()).toBeNull();

    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("caches a successful read", async () => {
    execFileSyncMock.mockReturnValue("abc123\n");
    const { readGitSha } = await import("./readGitSha.js");

    expect(readGitSha()).toBe("abc123");
    expect(readGitSha()).toBe("abc123");
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});
