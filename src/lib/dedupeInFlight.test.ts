import { describe, expect, it, vi } from "vitest";
import { dedupeInFlight } from "./dedupeInFlight.js";

describe("dedupeInFlight", () => {
  it("shares one call between concurrent callers and returns the same promise result", async () => {
    let release: (value: string) => void = () => undefined;
    const underlying = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const deduped = dedupeInFlight(underlying);
    const first = deduped();
    const second = deduped();
    expect(first).toBe(second);
    release("data");
    expect(await first).toBe("data");
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh call once the previous one settled (never serves a stale result)", async () => {
    let counter = 0;
    const deduped = dedupeInFlight(async () => ++counter);
    expect(await deduped()).toBe(1);
    expect(await deduped()).toBe(2);
  });

  it("shares a failure with every concurrent caller, then allows a retry", async () => {
    let attempt = 0;
    const deduped = dedupeInFlight(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("timeout");
      return "ok";
    });
    const first = deduped();
    const second = deduped();
    await expect(first).rejects.toThrow("timeout");
    await expect(second).rejects.toThrow("timeout");
    expect(await deduped()).toBe("ok");
    expect(attempt).toBe(2);
  });
});
