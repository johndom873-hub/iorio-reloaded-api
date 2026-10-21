import { describe, expect, it } from "vitest";
import { formatDurationToTheSecond } from "../lib/formatDurationHuman.js";
import { plutoStartMessage, plutoStopMessage, type PlutoStartFacts } from "./agentLifecycleMessages.js";

const running: PlutoStartFacts["state"] = { mode: "on", paused: false, pauseReason: null, breakers: {} };
const freeLease = { waitedMs: 0, tookOverFrom: null };

function start(overrides: Partial<PlutoStartFacts>): string {
  return plutoStartMessage({ release: "v234", previousRelease: "v234", lease: freeLease, state: running, ...overrides });
}

describe("plutoStopMessage", () => {
  it("says only what the process knows", () => {
    expect(plutoStopMessage("sigterm")).toBe("⏹️ Pluto stopping: Heroku asked it to stop");
    expect(plutoStopMessage("lease_lost")).toBe("⏹️ Pluto stopping: another agent took over");
    expect(plutoStopMessage("sigint")).toBe("⏹️ Pluto stopping: interrupted by hand");
  });
});

describe("plutoStartMessage", () => {
  it("a free lease and the same release: a Heroku restart", () => {
    expect(start({})).toBe("▶️ Pluto started: Heroku restart, same release");
  });

  it("names a new release, and a first start ever", () => {
    expect(start({ previousRelease: "v233" })).toBe("▶️ Pluto started: new release v234");
    expect(start({ previousRelease: null })).toBe("▶️ Pluto started: new release v234");
    expect(start({ release: "3f9c2ab71d0e", previousRelease: "aaaaaaa" })).toBe("▶️ Pluto started: new release 3f9c2ab");
  });

  it("an expired lease taken over: the previous agent stopped responding (never also the wait)", () => {
    expect(start({ lease: { waitedMs: 60_000, tookOverFrom: "agent.1:old" } })).toBe("▶️ Pluto started: previous agent stopped responding");
  });

  it("a wait for a lease given up: to the second", () => {
    expect(start({ lease: { waitedMs: 95_400, tookOverFrom: null } })).toBe("▶️ Pluto started: waited 1m 35s for the previous agent to stop");
  });

  it("joins every fact that holds", () => {
    expect(start({ previousRelease: "v233", lease: { waitedMs: 12_000, tookOverFrom: null } })).toBe("▶️ Pluto started: new release v234 · waited 12s for the previous agent to stop");
  });

  it("adds Pluto's state only when it is not running normally", () => {
    expect(start({ state: { ...running, mode: "off" } })).toBe("▶️ Pluto started: Heroku restart, same release · off");
    expect(start({ state: { ...running, paused: true, pauseReason: "crash_loop" } })).toBe("▶️ Pluto started: Heroku restart, same release · paused (crash loop)");
    expect(start({ state: { ...running, breakers: { order_error: { trippedAt: "x", detail: "y" } } } })).toBe("▶️ Pluto started: Heroku restart, same release · paused (breaker: order error)");
  });

  it("never claims the same release when the release is unknown", () => {
    expect(start({ release: null, previousRelease: null })).toBe("▶️ Pluto started: Heroku restart");
  });
});

describe("formatDurationToTheSecond", () => {
  it("keeps every unit down to the second", () => {
    expect(formatDurationToTheSecond(12_900)).toBe("12s");
    expect(formatDurationToTheSecond(95_000)).toBe("1m 35s");
    expect(formatDurationToTheSecond(7_205_000)).toBe("2h 0m 5s");
  });
});
