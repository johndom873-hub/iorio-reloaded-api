import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real riskLimitsRouter's exposure routes (the one-shot GET /exposure and the aggregation the SSE sibling sends) on a small
// express app. The IBKR account summary and the position-exposure computations are mocked, so what is asserted is the router's own
// grouping, sorting, "Unallocated" rows and its handling of an account fetch that fails.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run risk limits exposure route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
const fetchAccountSummaryMock = vi.fn();
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: (...args: unknown[]) => fetchAccountSummaryMock(...args) }));
const computePositionExposuresMock = vi.fn();
const computeCashLockedInCspsMock = vi.fn();
const streamPositionExposuresMock = vi.fn();
vi.mock("../lib/positionExposure.js", () => ({
  computePositionExposures: (...args: unknown[]) => computePositionExposuresMock(...args),
  computeCashLockedInCsps: (...args: unknown[]) => computeCashLockedInCspsMock(...args),
  streamPositionExposures: (...args: unknown[]) => streamPositionExposuresMock(...args),
}));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn() }));
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: vi.fn() }));

const { db } = await import("../db/connection.js");
const { riskLimitsRouter } = await import("./riskLimits.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/risk-limits", riskLimitsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await testDb.destroy();
});

interface ExposureRowSeed {
  positionId: string;
  symbol: string;
  sector: string;
  strategyKey: string;
  exposure: number;
}

const exposureRow = (positionId: string, symbol: string, sector: string, strategyKey: string, exposure: number): ExposureRowSeed => ({ positionId, symbol, sector, strategyKey, exposure });

beforeEach(() => {
  for (const mock of [fetchAccountSummaryMock, computePositionExposuresMock, computeCashLockedInCspsMock, streamPositionExposuresMock]) mock.mockReset();
  computePositionExposuresMock.mockResolvedValue([]);
  computeCashLockedInCspsMock.mockResolvedValue(0);
  fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 10_000, totalCashValue: 4_000 });
});

async function getExposure(options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? "user-1" : options.asUser;
  const response = await fetch(`${baseUrl}/risk-limits/exposure`, { headers: asUser ? { "x-test-user-id": asUser } : {} });
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  return { status: response.status, json: isJson ? ((await response.json()) as any) : null };
}

describe("GET /risk-limits/exposure", () => {
  it("is refused without a session and computes nothing", async () => {
    expect(await getExposure({ asUser: null })).toEqual({ status: 401, json: { error: "Not logged in." } });
    expect(computePositionExposuresMock).not.toHaveBeenCalled();
    expect(fetchAccountSummaryMock).not.toHaveBeenCalled();
  });

  it("groups exposure by ticker, sector and strategy, largest first, and adds what is not in any position as Unallocated", async () => {
    computePositionExposuresMock.mockResolvedValue([
      exposureRow("p1", "AAA", "Technology", "covered_call", 300),
      exposureRow("p2", "BBB", "Technology", "cash_secured_put", 500),
      exposureRow("p3", "CCC", "Energy", "covered_call", 200),
    ]);
    computeCashLockedInCspsMock.mockResolvedValue(250);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 2_000, totalCashValue: 900 });

    const response = await getExposure();

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      account: { netLiquidationValue: 2_000, totalCashValue: 900 },
      accountDataError: null,
      totalAccountValue: 2_000,
      availableCash: 650,
      concentrationByTicker: [
        { symbol: "BBB", notionalValue: "500" },
        { symbol: "AAA", notionalValue: "300" },
        { symbol: "CCC", notionalValue: "200" },
      ],
      concentrationBySector: [
        { sector: "Technology", notionalValue: "800" },
        { sector: "Energy", notionalValue: "200" },
        { sector: "Unallocated", notionalValue: "1000" },
      ],
      strategyAllocation: [
        { strategyKey: "covered_call", notionalValue: "500" },
        { strategyKey: "cash_secured_put", notionalValue: "500" },
        { strategyKey: "unallocated", notionalValue: "1000" },
      ],
      topPositions: [
        { positionId: "p2", symbol: "BBB", strategyKey: "cash_secured_put", notionalValue: "500" },
        { positionId: "p1", symbol: "AAA", strategyKey: "covered_call", notionalValue: "300" },
        { positionId: "p3", symbol: "CCC", strategyKey: "covered_call", notionalValue: "200" },
      ],
    });
  });

  it("adds up the positions of one symbol into a single ticker row but lists them separately among the top positions", async () => {
    computePositionExposuresMock.mockResolvedValue([
      exposureRow("p1", "AAA", "Technology", "covered_call", 100.5),
      exposureRow("p2", "AAA", "Technology", "cash_secured_put", 250),
      exposureRow("p3", "BBB", "Energy", "covered_call", 300),
    ]);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 100, totalCashValue: 100 });

    const { json } = await getExposure();

    expect(json.concentrationByTicker).toEqual([
      { symbol: "AAA", notionalValue: "350.5" },
      { symbol: "BBB", notionalValue: "300" },
    ]);
    expect(json.topPositions.map((row: { positionId: string }) => row.positionId)).toEqual(["p3", "p2", "p1"]);
  });

  it("keeps only the five largest positions in topPositions, while the groupings still count all of them", async () => {
    computePositionExposuresMock.mockResolvedValue(
      [10, 70, 30, 60, 20, 50, 40].map((exposure, index) => exposureRow(`p${index}`, `T${index}`, "Technology", "covered_call", exposure)),
    );

    const { json } = await getExposure();

    expect(json.topPositions.map((row: { notionalValue: string }) => row.notionalValue)).toEqual(["70", "60", "50", "40", "30"]);
    expect(json.concentrationByTicker).toHaveLength(7);
    expect(json.concentrationBySector[0]).toEqual({ sector: "Technology", notionalValue: "280" });
  });

  it.each([
    ["equal to the account value", 1_000],
    ["above the account value", 800],
  ])("adds no Unallocated row when the positions total is %s", async (_label, accountValue) => {
    computePositionExposuresMock.mockResolvedValue([exposureRow("p1", "AAA", "Technology", "covered_call", 600), exposureRow("p2", "BBB", "Energy", "covered_call", 400)]);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: accountValue, totalCashValue: 100 });

    const { json } = await getExposure();

    expect(json.concentrationBySector).toEqual([
      { sector: "Technology", notionalValue: "600" },
      { sector: "Energy", notionalValue: "400" },
    ]);
    expect(json.strategyAllocation).toEqual([{ strategyKey: "covered_call", notionalValue: "1000" }]);
  });

  it("with no open positions the whole account value is Unallocated and the lists of positions are empty", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 5_000, totalCashValue: 5_000 });

    const { json } = await getExposure();

    expect(json.concentrationByTicker).toEqual([]);
    expect(json.topPositions).toEqual([]);
    expect(json.concentrationBySector).toEqual([{ sector: "Unallocated", notionalValue: "5000" }]);
    expect(json.strategyAllocation).toEqual([{ strategyKey: "unallocated", notionalValue: "5000" }]);
    expect(json.availableCash).toBe(5_000);
  });

  it("an account fetch that fails with an Error still answers 200: the groupings, the error text, no account figures and no Unallocated rows", async () => {
    computePositionExposuresMock.mockResolvedValue([exposureRow("p1", "AAA", "Technology", "covered_call", 300)]);
    computeCashLockedInCspsMock.mockResolvedValue(100);
    fetchAccountSummaryMock.mockRejectedValue(new Error("IBKR gateway is not connected"));

    const response = await getExposure();

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      account: null,
      accountDataError: "IBKR gateway is not connected",
      totalAccountValue: null,
      availableCash: null,
      concentrationByTicker: [{ symbol: "AAA", notionalValue: "300" }],
      concentrationBySector: [{ sector: "Technology", notionalValue: "300" }],
      strategyAllocation: [{ strategyKey: "covered_call", notionalValue: "300" }],
      topPositions: [{ positionId: "p1", symbol: "AAA", strategyKey: "covered_call", notionalValue: "300" }],
    });
  });

  it("an account fetch that rejects with something other than an Error gets the generic message", async () => {
    fetchAccountSummaryMock.mockRejectedValue("timeout");
    expect((await getExposure()).json).toMatchObject({ account: null, accountDataError: "Failed to fetch live account data from IBKR.", availableCash: null });
  });

  it("subtracts the cash locked in cash-secured puts from the account's cash", async () => {
    computeCashLockedInCspsMock.mockResolvedValue(1_500);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 10_000, totalCashValue: 4_000 });
    expect((await getExposure()).json.availableCash).toBe(2_500);
  });

  it("a cash balance of 0 is a balance, not a missing one: available cash goes negative by what is locked", async () => {
    computeCashLockedInCspsMock.mockResolvedValue(300);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 10_000, totalCashValue: 0 });
    expect((await getExposure()).json.availableCash).toBe(-300);
  });

  it("a missing cash balance gives no available cash, while the account value still drives the Unallocated rows", async () => {
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 7_000, totalCashValue: null });
    const { json } = await getExposure();
    expect(json.availableCash).toBeNull();
    expect(json.totalAccountValue).toBe(7_000);
    expect(json.concentrationBySector).toEqual([{ sector: "Unallocated", notionalValue: "7000" }]);
  });

  it("a missing account value gives no total and no Unallocated rows", async () => {
    computePositionExposuresMock.mockResolvedValue([exposureRow("p1", "AAA", "Technology", "covered_call", 300)]);
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: null, totalCashValue: 100 });
    const { json } = await getExposure();
    expect(json.totalAccountValue).toBeNull();
    expect(json.concentrationBySector).toEqual([{ sector: "Technology", notionalValue: "300" }]);
    expect(json.availableCash).toBe(100);
  });

  it("a failure computing the exposures is a 500", async () => {
    computePositionExposuresMock.mockRejectedValue(new Error("database down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await getExposure()).status).toBe(500);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe("GET /risk-limits/exposure/stream", () => {
  const settleQueuedReadings = () => new Promise((resolve) => setTimeout(resolve, 20));

  async function readStream(options: { asUser?: string | null } = {}) {
    const asUser = options.asUser === undefined ? "user-1" : options.asUser;
    const response = await fetch(`${baseUrl}/risk-limits/exposure/stream`, { headers: asUser ? { "x-test-user-id": asUser } : {} });
    const text = await response.text();
    const frames = text
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)));
    return { status: response.status, contentType: response.headers.get("content-type"), frames };
  }

  it("is refused without a session and starts no stream", async () => {
    const response = await fetch(`${baseUrl}/risk-limits/exposure/stream`);
    expect(response.status).toBe(401);
    expect(streamPositionExposuresMock).not.toHaveBeenCalled();
  });

  it("sends each reading as an event-stream frame with the same aggregation as the one-shot route, then ends when the stream ends", async () => {
    const readings = [
      [exposureRow("p1", "AAA", "Technology", "covered_call", 300)],
      [exposureRow("p1", "AAA", "Technology", "covered_call", 350), exposureRow("p2", "BBB", "Energy", "cash_secured_put", 100)],
    ];
    streamPositionExposuresMock.mockImplementation(async (onUpdate: (rows: unknown[]) => Promise<void> | void) => {
      for (const reading of readings) await onUpdate(reading);
      await settleQueuedReadings();
    });
    fetchAccountSummaryMock.mockResolvedValue({ netLiquidationValue: 1_000, totalCashValue: 600 });
    computeCashLockedInCspsMock.mockResolvedValue(100);

    const { status, contentType, frames } = await readStream();

    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      accountDataError: null,
      totalAccountValue: 1_000,
      availableCash: 500,
      concentrationByTicker: [{ symbol: "AAA", notionalValue: "300" }],
      concentrationBySector: [
        { sector: "Technology", notionalValue: "300" },
        { sector: "Unallocated", notionalValue: "700" },
      ],
      strategyAllocation: [
        { strategyKey: "covered_call", notionalValue: "300" },
        { strategyKey: "unallocated", notionalValue: "700" },
      ],
      topPositions: [{ positionId: "p1", symbol: "AAA", strategyKey: "covered_call", notionalValue: "300" }],
    });
    expect(frames[1].concentrationByTicker).toEqual([
      { symbol: "AAA", notionalValue: "350" },
      { symbol: "BBB", notionalValue: "100" },
    ]);
    expect(frames[1].concentrationBySector.at(-1)).toEqual({ sector: "Unallocated", notionalValue: "550" });
  });

  it("an account fetch that fails still sends readings, carrying the error text", async () => {
    fetchAccountSummaryMock.mockRejectedValue(new Error("gateway down"));
    streamPositionExposuresMock.mockImplementation(async (onUpdate: (rows: unknown[]) => Promise<void> | void) => {
      await onUpdate([exposureRow("p1", "AAA", "Technology", "covered_call", 300)]);
      await settleQueuedReadings();
    });

    const { frames } = await readStream();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ account: null, accountDataError: "gateway down", totalAccountValue: null, availableCash: null, concentrationBySector: [{ sector: "Technology", notionalValue: "300" }] });
  });

  it("a stream that fails is logged and the response is still ended", async () => {
    streamPositionExposuresMock.mockRejectedValue(new Error("price feed down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { status, frames } = await readStream();
      expect(status).toBe(200);
      expect(frames).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalledWith("risk-limits/exposure/stream: streamPositionExposures failed", expect.any(Error));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("aborts the price stream when the client disconnects", async () => {
    let receivedSignal: AbortSignal | undefined;
    streamPositionExposuresMock.mockImplementation(
      (_onUpdate: unknown, signal: AbortSignal) =>
        new Promise<void>((resolve) => {
          receivedSignal = signal;
          signal.addEventListener("abort", () => resolve());
        }),
    );
    const abortController = new AbortController();
    const response = await fetch(`${baseUrl}/risk-limits/exposure/stream`, { headers: { "x-test-user-id": "user-1" }, signal: abortController.signal });
    expect(response.status).toBe(200);
    expect(receivedSignal?.aborted).toBe(false);

    abortController.abort();
    await vi.waitFor(() => expect(receivedSignal?.aborted).toBe(true));
  });
});
