import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppNotification } from "./notificationChannel.js";

const broadcasts = vi.hoisted(() => [] as unknown[]);
vi.mock("./notificationBroadcaster.js", () => ({ broadcastToLocalSubscribers: (notification: unknown) => void broadcasts.push(notification) }));

describe("pulseEmitter", () => {
  let emitter: typeof import("./pulseEmitter.js");

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-06T12:00:00Z"));
    broadcasts.length = 0;
    vi.resetModules();
    emitter = await import("./pulseEmitter.js");
  });
  afterEach(() => vi.useRealTimers());

  it("broadcasts a pulse notification for the edge", () => {
    emitter.emitPulse("heroku-db");
    expect(broadcasts).toEqual([{ type: "pulse", edgeId: "heroku-db" } satisfies AppNotification]);
  });

  it("drops a second pulse for the same edge inside its interval and allows it at the interval", () => {
    emitter.emitPulse("heroku-db");
    vi.advanceTimersByTime(999);
    emitter.emitPulse("heroku-db");
    expect(broadcasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    emitter.emitPulse("heroku-db");
    expect(broadcasts).toHaveLength(2);
  });

  it("uses 500 ms for the browser, genosuke and gateway edges", () => {
    for (const edgeId of ["heroku-browser", "genosuke-db", "genosuke-llm", "ibkr-gateway"] as const) {
      broadcasts.length = 0;
      emitter.emitPulse(edgeId);
      vi.advanceTimersByTime(499);
      emitter.emitPulse(edgeId);
      expect(broadcasts, edgeId).toHaveLength(1);
      vi.advanceTimersByTime(1);
      emitter.emitPulse(edgeId);
      expect(broadcasts, edgeId).toHaveLength(2);
      vi.advanceTimersByTime(10_000);
    }
  });

  it("throttles each edge independently", () => {
    emitter.emitPulse("heroku-db");
    emitter.emitPulse("genosuke-db");
    emitter.emitPulse("heroku-db");
    expect(broadcasts).toEqual([
      { type: "pulse", edgeId: "heroku-db" },
      { type: "pulse", edgeId: "genosuke-db" },
    ]);
  });

  it("pulses the browser edge from the request middleware and always calls next", () => {
    const next = vi.fn();
    emitter.pulseOnRequestMiddleware({} as never, {} as never, next);
    expect(broadcasts).toEqual([{ type: "pulse", edgeId: "heroku-browser" }]);
    expect(next).toHaveBeenCalledTimes(1);
    emitter.pulseOnRequestMiddleware({} as never, {} as never, next);
    expect(broadcasts).toHaveLength(1);
    expect(next).toHaveBeenCalledTimes(2);
  });
});
