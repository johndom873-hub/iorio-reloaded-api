import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accountReads = vi.hoisted(() => ({ count: 0 }));
const stream = vi.hoisted(() => ({ run: null as null | ((onUpdate: (rows: unknown[]) => Promise<void> | void, signal: AbortSignal) => Promise<void>) }));

vi.mock("../ibkr/fetchAccountSummary.js", () => ({
  fetchAccountSummary: async () => {
    accountReads.count += 1;
    return { netLiquidationValue: 1000 + accountReads.count, totalCashValue: 500 };
  },
}));
vi.mock("../lib/positionExposure.js", () => ({
  computeCashLockedInCsps: async () => 100,
  computePositionExposures: async () => [],
  streamPositionExposures: (onUpdate: (rows: unknown[]) => Promise<void> | void, signal: AbortSignal) => stream.run!(onUpdate, signal),
}));

import { streamExposureHandler } from "./riskLimits.js";

// The handler queues each reading (serializeAsyncCalls) without the producer waiting for it, as the real producers do.
const settleQueuedReadings = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeRequestAndResponse() {
  const request = Object.assign(new EventEmitter(), {}) as unknown as Request;
  const frames: { totalAccountValue: number | null }[] = [];
  const response = Object.assign(new EventEmitter(), {
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(chunk: string) {
      if (chunk.startsWith("data: ")) frames.push(JSON.parse(chunk.slice(6)));
      return true;
    },
    end() {
      (this as { writableEnded: boolean }).writableEnded = true;
    },
  }) as unknown as Response;
  return { request, response, frames };
}

beforeEach(() => {
  accountReads.count = 0;
});

describe("exposure stream with no open positions", () => {
  it("re-reads the account figures for every empty reading and the first reading after a position opens, not for later ones", async () => {
    stream.run = async (onUpdate) => {
      await onUpdate([]);
      await onUpdate([]);
      await onUpdate([{ positionId: "p", symbol: "AAA", sector: "Tech", strategyKey: "covered_call", exposure: 10, notionalValue: 10 }]);
      await onUpdate([{ positionId: "p", symbol: "AAA", sector: "Tech", strategyKey: "covered_call", exposure: 11, notionalValue: 11 }]);
      await settleQueuedReadings();
    };
    const { request, response, frames } = fakeRequestAndResponse();
    await streamExposureHandler(request, response);

    expect(frames.map((frame) => frame.totalAccountValue)).toEqual([1001, 1002, 1003, 1003]);
    expect(accountReads.count).toBe(3);
  });

  it("reads the account once up front when the first reading has positions", async () => {
    stream.run = async (onUpdate) => {
      await onUpdate([{ positionId: "p", symbol: "AAA", sector: "Tech", strategyKey: "covered_call", exposure: 10, notionalValue: 10 }]);
      await onUpdate([{ positionId: "p", symbol: "AAA", sector: "Tech", strategyKey: "covered_call", exposure: 12, notionalValue: 12 }]);
      await settleQueuedReadings();
    };
    const { request, response, frames } = fakeRequestAndResponse();
    await streamExposureHandler(request, response);

    expect(frames).toHaveLength(2);
    expect(accountReads.count).toBe(1);
  });
});
