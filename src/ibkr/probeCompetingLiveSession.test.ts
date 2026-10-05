import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { describe, expect, it, vi } from "vitest";
import { probeCompetingLiveSession } from "./probeCompetingLiveSession.js";

function fakeIb() {
  const emitter = new EventEmitter();
  const cancelMktData = vi.fn();
  const ib = {
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => emitter.removeListener(event, listener),
    reqMarketDataType: vi.fn(),
    reqMktData: vi.fn(),
    cancelMktData,
  };
  return { ib: ib as unknown as Parameters<typeof probeCompetingLiveSession>[0], emitter, cancelMktData };
}

describe("probeCompetingLiveSession", () => {
  it("is blocked when 10197 arrives after the marketDataType answer (the order IBKR really uses)", async () => {
    const { ib, emitter, cancelMktData } = fakeIb();
    const probe = probeCompetingLiveSession(ib, 7, "SPY", 1_000);
    emitter.emit(EventName.marketDataType, 7, 1);
    emitter.emit(EventName.error, new Error("No market data during competing live session"), 10197, 7);
    await expect(probe).resolves.toBe("blocked");
    expect(cancelMktData).toHaveBeenCalledWith(7);
    expect(emitter.listenerCount(EventName.error)).toBe(0);
    expect(emitter.listenerCount(EventName.tickPrice)).toBe(0);
  });

  it("is flowing on a real price", async () => {
    const { ib, emitter } = fakeIb();
    const probe = probeCompetingLiveSession(ib, 7, "SPY", 1_000);
    emitter.emit(EventName.tickPrice, 7, 4, 612.5);
    await expect(probe).resolves.toBe("flowing");
  });

  it("ignores IBKR's -1 no-data price, other request ids and other error codes", async () => {
    const { ib, emitter } = fakeIb();
    const probe = probeCompetingLiveSession(ib, 7, "SPY", 50);
    emitter.emit(EventName.tickPrice, 7, 4, -1);
    emitter.emit(EventName.tickPrice, 8, 4, 612.5);
    emitter.emit(EventName.error, new Error("other"), 10197, 8);
    emitter.emit(EventName.error, new Error("delayed fallback"), 10167, 7);
    await expect(probe).resolves.toBe("unknown");
  });
});
