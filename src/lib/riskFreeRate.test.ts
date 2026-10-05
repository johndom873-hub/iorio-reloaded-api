import { describe, expect, it, vi } from "vitest";
import { runWithRetries } from "./riskFreeRate.js";

describe("runWithRetries", () => {
  it("returns the first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    expect(await runWithRetries(async () => "ok", 3, [2000, 4000], sleep)).toBe("ok");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries with the configured pauses and succeeds on the last attempt", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    const result = await runWithRetries(async () => {
      if (++calls < 3) throw new Error("timeout");
      return "ok";
    }, 3, [2000, 4000], sleep);
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(sleep.mock.calls).toEqual([[2000], [4000]]);
  });

  it("throws the last error after all attempts and does not sleep after the final one", async () => {
    const sleep = vi.fn(async () => {});
    let calls = 0;
    await expect(runWithRetries(async () => { throw new Error(`fail ${++calls}`); }, 3, [2000, 4000], sleep)).rejects.toThrow("fail 3");
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
