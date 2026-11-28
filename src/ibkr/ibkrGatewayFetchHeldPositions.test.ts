import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { EventName, OptionType, SecType } from "@stoqey/ib";
import type { Contract, IBApi } from "@stoqey/ib";
import { fetchIbkrHeldPositions } from "./ibkrGatewayFetchHeldPositions.js";

type PositionMessage = [account: string, contract: Contract, pos: number, avgCost: number];

/** An IBApi whose reqPositions() sends these position messages, then positionEnd. */
function connectionSending(messages: PositionMessage[]): IBApi {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    reqPositions: () => {
      for (const message of messages) emitter.emit(EventName.position, ...message);
      emitter.emit(EventName.positionEnd);
    },
  }) as unknown as IBApi;
}

const account = "U1234567";
const shares: Contract = { conId: 890493863, symbol: "SPCX", secType: SecType.STK };
const call: Contract = { conId: 932633160, symbol: "SPCX", secType: SecType.OPT, right: OptionType.Call, strike: 130, lastTradeDateOrContractMonth: "20261127", multiplier: 100 };
const otherShares: Contract = { conId: 4815747, symbol: "NVDA", secType: SecType.STK };

describe("fetchIbkrHeldPositions", () => {
  it("a combo filling inside the reply: each contract once, at its last quantity (prod SPCX 2026-11-27)", async () => {
    const held = await fetchIbkrHeldPositions(
      connectionSending([
        [account, otherShares, 900, 169.85],
        [account, shares, 100, 129.32],
        [account, call, -1, 85],
        [account, call, -2, 84.5],
        [account, shares, 200, 129.315],
        [account, call, -3, 84.33],
        [account, shares, 300, 129.3188],
      ]),
    );
    expect(held.map((position) => [position.contract.conId, position.quantity, position.avgCost])).toEqual([
      [4815747, 900, 169.85],
      [890493863, 300, 129.3188],
      [932633160, -3, 84.33],
    ]);
  });

  it("a contract whose last message is 0 is not held, though an earlier message had it", async () => {
    const held = await fetchIbkrHeldPositions(
      connectionSending([
        [account, call, -3, 84.33],
        [account, otherShares, 900, 169.85],
        [account, call, 0, 0],
      ]),
    );
    expect(held.map((position) => position.contract.conId)).toEqual([4815747]);
  });

  it("the same contract in two accounts stays two holdings", async () => {
    const held = await fetchIbkrHeldPositions(
      connectionSending([
        [account, shares, 300, 129.32],
        ["U7654321", shares, 100, 131],
      ]),
    );
    expect(held.map((position) => position.quantity)).toEqual([300, 100]);
  });
});
