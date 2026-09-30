import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyTelegram = vi.fn(async (_message: string) => true);
let alreadyAlerted = false;

vi.mock("./notifyTelegram.js", () => ({ notifyTelegram }));
vi.mock("./runJob.js", () => ({ wasErrorAlerted: () => alreadyAlerted }));

const { runScript } = await import("./runScript.js");

beforeEach(() => {
  vi.clearAllMocks();
  alreadyAlerted = false;
  process.exitCode = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("runScript", () => {
  it("runs cleanup after a successful main and leaves the exit code alone", async () => {
    const cleanup = vi.fn(async () => {});
    await runScript("job", async () => {}, cleanup);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(notifyTelegram).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("alerts once and exits 1 when main throws before job tracking, then still cleans up", async () => {
    const cleanup = vi.fn(async () => {});
    await runScript("job", async () => { throw new Error("connect ECONNREFUSED\nsecond line"); }, cleanup);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifyTelegram.mock.calls[0]![0]).toBe("⚠️ job failed outside job tracking, so no job run was recorded: connect ECONNREFUSED");
    expect(process.exitCode).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not alert a second time for an error runJob already reported, but still exits 1", async () => {
    alreadyAlerted = true;
    await runScript("job", async () => { throw new Error("already sent"); }, async () => {});
    expect(notifyTelegram).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("never leaves a blank alert: an error with an empty message falls back to its code or name", async () => {
    const refused = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    await runScript("job", async () => { throw refused; }, async () => {});
    expect(notifyTelegram.mock.calls[0]![0]).toContain("ECONNREFUSED");
    await runScript("job", async () => { throw new AggregateError([], ""); }, async () => {});
    expect(notifyTelegram.mock.calls[1]![0]).toContain("AggregateError");
  });

  it("leaves no timer behind after a failure: the alert timeout must not keep the process alive for its full 15 seconds", async () => {
    vi.useFakeTimers();
    try {
      await runScript("job", async () => { throw new Error("boom"); }, async () => {});
      expect(notifyTelegram).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
