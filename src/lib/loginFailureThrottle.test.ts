import { beforeEach, describe, expect, it } from "vitest";
import { clearLoginFailures, clientAddress, describeClientAddress, isLoginThrottled, recordLoginFailure, resetLoginFailuresForTests } from "./loginFailureThrottle.js";

const minute = 60_000;

beforeEach(() => resetLoginFailuresForTests());

describe("clientAddress", () => {
  it("is the address Express resolved, never an X-Forwarded-For entry a client supplied", () => {
    expect(clientAddress({ ip: "10.0.0.5", headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.5" } } as never)).toBe("10.0.0.5");
  });

  it("falls back to 'unknown' when there is no address", () => {
    expect(clientAddress({})).toBe("unknown");
  });
});

describe("describeClientAddress", () => {
  it("adds the client Cloudflare reports, labelled as reported", () => {
    expect(describeClientAddress({ ip: "172.71.1.1", headers: { "cf-connecting-ip": " 203.0.113.9 " } })).toBe("172.71.1.1 (reported client 203.0.113.9)");
  });

  it("is just the address when Cloudflare reports none", () => {
    expect(describeClientAddress({ ip: "10.0.0.5", headers: {} })).toBe("10.0.0.5");
  });
});

describe("throttle window", () => {
  it("throttles at the tenth failure, frees at 15 minutes, and clears on success", () => {
    const start = Date.UTC(2026, 9, 6, 12);
    for (let attempt = 0; attempt < 9; attempt += 1) recordLoginFailure("a", start);
    expect(isLoginThrottled("a", start)).toBe(false);
    recordLoginFailure("a", start);
    expect(isLoginThrottled("a", start + 15 * minute - 1)).toBe(true);
    expect(isLoginThrottled("a", start + 15 * minute)).toBe(false);
    recordLoginFailure("b", start);
    clearLoginFailures("b");
    expect(isLoginThrottled("b", start)).toBe(false);
  });
});
