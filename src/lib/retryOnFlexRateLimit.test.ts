import { describe, expect, it, vi } from "vitest";
import { FlexRateLimitError, flexRateLimitMaxAttempts, flexRateLimitRetryDelayMs, isFlexRateLimitResponse, retryOnFlexRateLimit } from "./retryOnFlexRateLimit.js";

const rateLimited = () => new FlexRateLimitError("Flex SendRequest failed: Too many requests have been made from this token. Please try again shortly.");

describe("isFlexRateLimitResponse", () => {
  it("recognises IBKR's throttle by its error code or by its message", () => {
    expect(isFlexRateLimitResponse("1018", undefined)).toBe(true);
    expect(isFlexRateLimitResponse(undefined, "Too many requests have been made from this token. Please try again shortly.")).toBe(true);
    expect(isFlexRateLimitResponse(undefined, "TOO MANY REQUESTS")).toBe(true);
  });

  it("does not treat other Flex errors as a throttle", () => {
    expect(isFlexRateLimitResponse("1012", "Token has expired.")).toBe(false);
    expect(isFlexRateLimitResponse("1019", "Statement generation in progress.")).toBe(false);
    expect(isFlexRateLimitResponse(undefined, undefined)).toBe(false);
  });
});

describe("retryOnFlexRateLimit", () => {
  it("uses 3 attempts, 45 seconds apart, by default", () => {
    expect(flexRateLimitMaxAttempts).toBe(3);
    expect(flexRateLimitRetryDelayMs).toBe(45_000);
  });

  it("returns at once, without waiting, when the first attempt works", async () => {
    const sleep = vi.fn(async () => {});
    const operation = vi.fn(async () => "reference-code");
    await expect(retryOnFlexRateLimit(operation, { sleep })).resolves.toBe("reference-code");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries after a throttle, waiting the default delay, and returns the later success", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    const operation = vi.fn().mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited()).mockResolvedValueOnce("reference-code");
    await expect(retryOnFlexRateLimit(operation, { sleep, onRetry })).resolves.toBe("reference-code");
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(45_000);
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ attempt: 1, maxAttempts: 3, delayMs: 45_000 }));
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ attempt: 2, maxAttempts: 3 }));
  });

  it("rethrows the last throttle error unchanged when every attempt is refused, with no wait after the last", async () => {
    const sleep = vi.fn(async () => {});
    const lastError = rateLimited();
    const operation = vi.fn().mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(rateLimited()).mockRejectedValueOnce(lastError);
    await expect(retryOnFlexRateLimit(operation, { sleep })).rejects.toBe(lastError);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry any other error", async () => {
    const sleep = vi.fn(async () => {});
    const expiredTokenError = new Error("Flex SendRequest failed: Token has expired.");
    const operation = vi.fn().mockRejectedValue(expiredTokenError);
    await expect(retryOnFlexRateLimit(operation, { sleep })).rejects.toBe(expiredTokenError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
