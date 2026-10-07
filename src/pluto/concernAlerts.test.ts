import { beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(() => ({ messages: [] as string[], openKeys: new Set<string>() }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: async (text: string) => { sent.messages.push(text); return true; } }));
vi.mock("../lib/throttledAlert.js", () => ({
  // Opens a key once; later calls on an open key are reminders the real throttle would hold back within the hour.
  notifyDownThrottled: async (key: string, message: string, _interval: number, options: { send: (text: string) => Promise<unknown> }) => {
    if (sent.openKeys.has(key)) return false;
    sent.openKeys.add(key);
    await options.send(message);
    return true;
  },
  clearDownState: async (key: string) => (sent.openKeys.delete(key) ? 60_000 : null),
}));

const { updatePlutoConcernAlerts } = await import("./concernAlerts.js");

beforeEach(() => {
  sent.messages.length = 0;
  sent.openKeys.clear();
});

describe("updatePlutoConcernAlerts", () => {
  it("announces a flagged ticker once, stays quiet while it stays flagged, and says when it clears", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI", "BMNR"], concerns: [{ symbol: "SMCI", concern: "position count conflicts" }] });
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI", "BMNR"], concerns: [{ symbol: "SMCI", concern: "worded differently this time" }] });
    expect(sent.messages).toEqual(["🪐 Pluto sees a data problem on SMCI and will not trade it until it clears. The reason is on the Pluto screen."]);
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI"], concerns: [] });
    expect(sent.messages.at(-1)).toBe("✅ Pluto's data concern on SMCI has cleared.");
  });

  it("does not clear a ticker the round did not look at", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI"], concerns: [{ symbol: "SMCI", concern: "x" }] });
    await updatePlutoConcernAlerts({ roundSymbols: ["BMNR"], concerns: [] });
    expect(sent.messages).toHaveLength(1);
  });

  it("handles a whole-message concern on its own key", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI"], concerns: [{ symbol: null, concern: "account block inconsistent" }] });
    expect(sent.messages).toEqual(["🪐 Pluto sees a problem with the data it was given and is standing aside. The reason is on the Pluto screen."]);
    await updatePlutoConcernAlerts({ roundSymbols: ["SMCI"], concerns: [] });
    expect(sent.messages.at(-1)).toBe("✅ Pluto's concern about the data it was given has cleared.");
  });
});
