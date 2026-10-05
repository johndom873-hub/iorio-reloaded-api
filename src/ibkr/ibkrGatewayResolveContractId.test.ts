import { EventEmitter } from "node:events";
import { EventName, type Contract, type IBApi } from "@stoqey/ib";
import { describe, expect, it } from "vitest";
import { resolveContractId } from "./ibkrGatewayResolveContractId.js";

function fakeGateway() {
  const emitter = new EventEmitter() as EventEmitter & { reqContractDetails: (reqId: number, contract: Contract) => void; requested: number[] };
  emitter.requested = [];
  emitter.reqContractDetails = (reqId) => {
    emitter.requested.push(reqId);
  };
  return emitter;
}

describe("resolveContractId with several lookups in flight", () => {
  it("gives each lookup its own contract when the answers arrive interleaved", async () => {
    const gateway = fakeGateway();
    const ib = gateway as unknown as IBApi;
    const first = resolveContractId(ib, { symbol: "AAA" }, 70_000);
    const second = resolveContractId(ib, { symbol: "BBB" }, 70_001);
    gateway.emit(EventName.contractDetails, 70_001, { contract: { conId: 222 } });
    gateway.emit(EventName.contractDetails, 70_000, { contract: { conId: 111 } });
    expect(await first).toBe(111);
    expect(await second).toBe(222);
  });

  it("settles a not-found lookup from its own end event even when another lookup's end arrives first", async () => {
    const gateway = fakeGateway();
    const ib = gateway as unknown as IBApi;
    const unknownContract = resolveContractId(ib, { symbol: "NONE" }, 70_002);
    const knownContract = resolveContractId(ib, { symbol: "CCC" }, 70_003);
    gateway.emit(EventName.contractDetails, 70_003, { contract: { conId: 333 } });
    gateway.emit(EventName.contractDetailsEnd, 70_003);
    gateway.emit(EventName.contractDetailsEnd, 70_002);
    expect(await knownContract).toBe(333);
    expect(await unknownContract).toBeNull();
  });

  it("leaves no listeners behind once every lookup has settled", async () => {
    const gateway = fakeGateway();
    const ib = gateway as unknown as IBApi;
    const lookup = resolveContractId(ib, { symbol: "DDD" }, 70_004);
    gateway.emit(EventName.contractDetails, 70_004, { contract: { conId: 444 } });
    await lookup;
    expect(gateway.listenerCount(EventName.contractDetails)).toBe(0);
    expect(gateway.listenerCount(EventName.contractDetailsEnd)).toBe(0);
    expect(gateway.listenerCount(EventName.error)).toBe(0);
  });
});
