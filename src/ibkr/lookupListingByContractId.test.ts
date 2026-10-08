import { EventEmitter } from "node:events";
import { EventName, SecType, type Contract, type IBApi } from "@stoqey/ib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupListingByContractId } from "./lookupListingByContractId.js";

function fakeGateway() {
  const emitter = new EventEmitter() as EventEmitter & { reqContractDetails: (reqId: number, contract: Contract) => void; requested: { reqId: number; contract: Contract }[] };
  emitter.requested = [];
  emitter.reqContractDetails = (reqId, contract) => {
    emitter.requested.push({ reqId, contract });
  };
  return emitter;
}

afterEach(() => vi.useRealTimers());

describe("lookupListingByContractId", () => {
  it("asks IBKR for the stock by contract id alone", () => {
    const gateway = fakeGateway();
    void lookupListingByContractId(gateway as unknown as IBApi, 554208351, 80_000);
    expect(gateway.requested).toEqual([{ reqId: 80_000, contract: { conId: 554208351, secType: SecType.STK } }]);
  });

  it("resolves with the symbol and primary exchange IBKR files the contract under", async () => {
    const gateway = fakeGateway();
    const delisted = lookupListingByContractId(gateway as unknown as IBApi, 554208351, 80_001);
    const renamed = lookupListingByContractId(gateway as unknown as IBApi, 804144296, 80_002);
    gateway.emit(EventName.contractDetails, 80_002, { contract: { symbol: "SKYD", primaryExch: "NYSE" } });
    gateway.emit(EventName.contractDetails, 80_001, { contract: { symbol: "WBD", primaryExch: "VALUE" } });
    expect(await delisted).toEqual({ symbol: "WBD", primaryExchange: "VALUE" });
    expect(await renamed).toEqual({ symbol: "SKYD", primaryExchange: "NYSE" });
  });

  it("resolves null on an error, an empty list, or details without a symbol", async () => {
    const gateway = fakeGateway();
    const ib = gateway as unknown as IBApi;
    const errored = lookupListingByContractId(ib, 1, 80_003);
    const emptyList = lookupListingByContractId(ib, 2, 80_004);
    const noSymbol = lookupListingByContractId(ib, 3, 80_005);
    gateway.emit(EventName.error, new Error("No security definition has been found for the request"), 200, 80_003);
    gateway.emit(EventName.contractDetailsEnd, 80_004);
    gateway.emit(EventName.contractDetails, 80_005, { contract: { primaryExch: "NYSE" } });
    expect(await errored).toBeNull();
    expect(await emptyList).toBeNull();
    expect(await noSymbol).toBeNull();
  });

  it("resolves null after 10 s of silence and leaves no listeners or timers behind", async () => {
    vi.useFakeTimers();
    const gateway = fakeGateway();
    const lookup = lookupListingByContractId(gateway as unknown as IBApi, 1, 80_006);
    gateway.emit(EventName.contractDetails, 80_999, { contract: { symbol: "OTHER" } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await lookup).toBeNull();
    for (const eventName of [EventName.contractDetails, EventName.contractDetailsEnd, EventName.error]) expect(gateway.listenerCount(eventName)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
