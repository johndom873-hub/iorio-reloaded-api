import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real streamCloseLiveHandler on a small express app against the test database: the position, its legs and the wheel-cycle inputs are
// loaded for real by lib/closeGate.ts. The shared quote pool and the market-session lookup are mocked, so the tests drive quotes and the
// market state by hand. The settle grace is shortened so the "waiting" to "unavailable" flip is quick to observe.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run close-live route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

interface PooledQuoteSubscription {
  contract: any;
  onUpdate: (quote: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}
const subscriptions: PooledQuoteSubscription[] = [];
let subscribeBehaviour: (subscription: PooledQuoteSubscription) => void | Promise<void> = () => {};
vi.mock("../ibkr/marketDataPool.js", () => ({
  settleGraceMs: 300,
  waitForFirstReading: vi.fn(),
  subscribeToPooledQuote: async (contract: unknown, onUpdate: (quote: unknown) => void) => {
    const subscription: PooledQuoteSubscription = { contract, onUpdate, unsubscribe: vi.fn() };
    await subscribeBehaviour(subscription);
    subscriptions.push(subscription);
    return subscription.unsubscribe;
  },
}));
const computeMarketSessionStatusMock = vi.fn();
vi.mock("../lib/marketSessionStatus.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/marketSessionStatus.js")>("../lib/marketSessionStatus.js");
  return { ...actual, computeMarketSessionStatus: (...args: unknown[]) => computeMarketSessionStatusMock(...args) };
});

const { db } = await import("../db/connection.js");
const { streamCloseLiveHandler } = await import("./positionCloseLive.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
const openClients: AbortController[] = [];
let symbolCounter = Date.now() % 100_000;

const shortPutExpiry = "2027-06-18";
const shortPutStrike = 100;
const shortPutEntryPrice = 2;

beforeAll(async () => {
  const app = express();
  app.get("/positions/:id/close-live/stream", streamCloseLiveHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  await cleanRows();
  await testDb.destroy();
});

async function cleanRows(): Promise<void> {
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  createdPositionIds.length = 0;
  createdTickerIds.length = 0;
}

beforeEach(() => {
  subscriptions.length = 0;
  subscribeBehaviour = () => {};
  computeMarketSessionStatusMock.mockReset().mockResolvedValue({ state: "open" });
});

afterEach(async () => {
  for (const client of openClients) client.abort();
  openClients.length = 0;
  await cleanRows();
});

async function createTicker(): Promise<{ tickerId: string; symbol: string }> {
  const symbol = `CLV${(symbolCounter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Close Live Route Test Co" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return { tickerId: ticker.id, symbol };
}

// Inserted as closed first and flipped to open only once its leg exists: the reconciliation tests share this database and their pass
// closes any open position that has no open leg.
async function createOpenShortPutPosition(): Promise<{ positionId: string; legId: string; symbol: string }> {
  const { tickerId, symbol } = await createTicker();
  const [position] = await testDb("positions").insert({ strategy_key: "cash_secured_put", ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning(["id"]);
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({
      position_id: position.id,
      leg_type: "option",
      side: "short",
      quantity: 2,
      option_type: "put",
      strike_price: shortPutStrike,
      expiry_date: shortPutExpiry,
      multiplier: 100,
      entry_price: shortPutEntryPrice,
      entry_at: new Date(Date.now() - 86_400_000),
    })
    .returning(["id"]);
  await testDb("positions").where({ id: position.id }).update({ status: "open", closed_at: null });
  return { positionId: position.id, legId: leg.id, symbol };
}

async function getJson(path: string) {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as any, contentType: response.headers.get("content-type") };
}

/** An open event stream: frames are pulled one at a time, so a test can act between them. */
async function openStream(positionId: string) {
  const abortController = new AbortController();
  openClients.push(abortController);
  const response = await fetch(`${baseUrl}/positions/${positionId}/close-live/stream`, { signal: abortController.signal });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let ended = false;
  async function nextFrame(): Promise<any | null> {
    for (;;) {
      const separatorIndex = buffered.indexOf("\n\n");
      if (separatorIndex >= 0) {
        const block = buffered.slice(0, separatorIndex);
        buffered = buffered.slice(separatorIndex + 2);
        if (block.startsWith("data: ")) return JSON.parse(block.slice("data: ".length));
        continue;
      }
      if (ended) return null;
      const chunk = await reader.read();
      if (chunk.done) ended = true;
      else buffered += decoder.decode(chunk.value, { stream: true });
    }
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    cacheControl: response.headers.get("cache-control"),
    nextFrame,
    close: () => abortController.abort(),
  };
}

/** The pooled subscription of the position's option leg (the other one is the ticker's stock, which a position with no shares does not need quoted). */
const optionSubscription = () => subscriptions.find((subscription) => subscription.contract.legType === "option")!;
const quote = (bid: number | null, ask: number | null, last: number | null = null) => ({ bid, ask, last, delta: null, gamma: null });

async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the condition.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GET /positions/:id/close-live/stream: refusing before the stream opens", () => {
  it.each([
    ["text that is not an id", "not-a-uuid"],
    ["an id one character short", "00000000-0000-0000-0000-00000000000"],
    ["an id with trailing text", "00000000-0000-0000-0000-000000000000x"],
    ["an id with non-hex characters", "g0000000-0000-0000-0000-000000000000"],
  ])("answers a plain 404 JSON for %s and loads nothing", async (_label, id) => {
    const response = await getJson(`/positions/${id}/close-live/stream`);
    expect(response).toEqual({ status: 404, json: { error: "Position not found." }, contentType: expect.stringContaining("application/json") });
    expect(subscriptions).toHaveLength(0);
    expect(computeMarketSessionStatusMock).not.toHaveBeenCalled();
  });

  it("answers 404 for a well-formed id no position has, accepting upper-case hex", async () => {
    const response = await getJson("/positions/ABCDEF00-1111-2222-3333-ABCDEF000000/close-live/stream");
    expect(response).toEqual({ status: 404, json: { error: "Open position not found." }, contentType: expect.stringContaining("application/json") });
    expect(subscriptions).toHaveLength(0);
  });

  it("answers 404 for a closed position", async () => {
    const { positionId } = await createOpenShortPutPosition();
    await testDb("positions").where({ id: positionId }).update({ status: "closed", closed_at: new Date() });

    expect(await getJson(`/positions/${positionId}/close-live/stream`)).toMatchObject({ status: 404, json: { error: "Open position not found." } });
    expect(subscriptions).toHaveLength(0);
  });
});

describe("GET /positions/:id/close-live/stream: the stream", () => {
  it("opens an event stream, subscribes the stock and each open option leg on the pool, and sends a first state frame", async () => {
    const { positionId, legId, symbol } = await createOpenShortPutPosition();
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") subscription.onUpdate(quote(1.4, 1.6));
    };

    const stream = await openStream(positionId);
    const firstFrame = await stream.nextFrame();

    expect(stream.status).toBe(200);
    expect(stream.contentType).toBe("text/event-stream");
    expect(stream.cacheControl).toBe("no-cache");
    expect(subscriptions.map((subscription) => subscription.contract)).toEqual([
      { key: "stock", legType: "stock", symbol },
      { key: legId, legType: "option", symbol, expiry: "20270618", strike: shortPutStrike, right: "P" },
    ]);
    expect(firstFrame.type).toBe("state");
    expect(firstFrame.data).toMatchObject({ marketOpen: true, blockReason: null, pending: false });
    expect(firstFrame.data.legQuotes[legId]).toEqual({ bid: 1.4, ask: 1.6, last: null, mid: 1.5 });
  });

  it("derives live: market open, a two-sided quote on every leg and a consistent open cycle; the cycle total carries the live premium P&L", async () => {
    const { positionId } = await createOpenShortPutPosition();
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") subscription.onUpdate(quote(1.4, 1.6));
    };

    const frame = await (await openStream(positionId)).nextFrame();

    // Short 2 contracts x 100 at 2.00 entry, live mid 1.50: (1.5 - 2) x 2 x 100 x -1 = +100.
    expect(frame.data.live).toBe(true);
    expect(frame.data.cycleTotal).toBeCloseTo(100, 6);
  });

  it("is blocked outside regular trading hours, naming the market state, even with quotes", async () => {
    const { positionId } = await createOpenShortPutPosition();
    computeMarketSessionStatusMock.mockResolvedValue({ state: "after-hours" });
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") subscription.onUpdate(quote(1.4, 1.6));
    };

    const frame = await (await openStream(positionId)).nextFrame();

    expect(frame.data).toMatchObject({
      live: false,
      pending: false,
      marketOpen: false,
      cycleTotal: null,
      blockReason: "Closing is only available during regular trading hours (9:30 AM – 4:00 PM ET). The market is in after-hours trading right now.",
    });
  });

  it("treats a failed market-session lookup as closed, so the form fails closed", async () => {
    const { positionId } = await createOpenShortPutPosition();
    computeMarketSessionStatusMock.mockRejectedValue(new Error("calendar unavailable"));

    const frame = await (await openStream(positionId)).nextFrame();

    expect(frame.data).toMatchObject({ live: false, marketOpen: false });
    expect(frame.data.blockReason).toContain("The market is closed right now.");
  });

  it("says it is waiting for quotes while inside the settle grace, then flips to unavailable naming the leg once it passes", async () => {
    const { positionId } = await createOpenShortPutPosition();

    const stream = await openStream(positionId);
    const waitingFrame = await stream.nextFrame();
    const unavailableFrame = await stream.nextFrame();

    expect(waitingFrame.data).toMatchObject({ live: false, pending: true, blockReason: "Waiting for live quotes…", cycleTotal: null });
    expect(unavailableFrame.data).toMatchObject({
      live: false,
      pending: false,
      blockReason: `Live bid/ask is unavailable for $${shortPutStrike}P ${shortPutExpiry}. Closing needs live prices.`,
    });
  });

  it("treats a one-sided option quote (no ask) as unavailable", async () => {
    const { positionId } = await createOpenShortPutPosition();
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") subscription.onUpdate(quote(1.4, null));
    };

    const stream = await openStream(positionId);
    const firstFrame = await stream.nextFrame();
    const settledFrame = await stream.nextFrame();

    expect(firstFrame.data).toMatchObject({ live: false, pending: true });
    expect(settledFrame.data).toMatchObject({ live: false, pending: false });
    expect(settledFrame.data.blockReason).toContain(`$${shortPutStrike}P ${shortPutExpiry}`);
    expect(settledFrame.data.legQuotes[Object.keys(settledFrame.data.legQuotes)[0]!]).toEqual({ bid: 1.4, ask: null, last: null, mid: null });
  });

  it("sends a new state frame after a later quote update (throttled), reflecting the new mid", async () => {
    const { positionId, legId } = await createOpenShortPutPosition();
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") subscription.onUpdate(quote(1.4, 1.6));
    };

    const stream = await openStream(positionId);
    const firstFrame = await stream.nextFrame();
    expect(firstFrame.data.legQuotes[legId].mid).toBe(1.5);

    // The subscribe-time update scheduled a throttled emit as well; read past it to the frame that carries the new quote.
    optionSubscription().onUpdate(quote(0.9, 1.1));
    let frame = await stream.nextFrame();
    while (frame.data.legQuotes[legId].mid !== 1) frame = await stream.nextFrame();

    expect(frame.data.live).toBe(true);
    // (1.0 - 2) x 2 x 100 x -1 = +200.
    expect(frame.data.cycleTotal).toBeCloseTo(200, 6);
  });

  it("answers with a streamError frame and ends the stream when a pool subscription fails, releasing the ones already taken", async () => {
    const { positionId } = await createOpenShortPutPosition();
    subscribeBehaviour = (subscription) => {
      if (subscription.contract.legType === "option") throw new Error("market data lines exhausted");
    };

    const stream = await openStream(positionId);
    const errorFrame = await stream.nextFrame();
    const afterError = await stream.nextFrame();

    expect(errorFrame).toEqual({ type: "streamError", message: "market data lines exhausted" });
    expect(afterError).toBeNull();
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.contract.legType).toBe("stock");
    expect(subscriptions[0]!.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releases every pool subscription when the client disconnects", async () => {
    const { positionId } = await createOpenShortPutPosition();
    const stream = await openStream(positionId);
    await stream.nextFrame();
    expect(subscriptions).toHaveLength(2);
    for (const subscription of subscriptions) expect(subscription.unsubscribe).not.toHaveBeenCalled();

    stream.close();

    await until(() => subscriptions.every((subscription) => subscription.unsubscribe.mock.calls.length === 1));
    for (const subscription of subscriptions) expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releases a subscription that was still being taken when the client disconnected, and sends no state frame", async () => {
    const { positionId } = await createOpenShortPutPosition();
    let releaseSubscribe!: () => void;
    const subscribeGate = new Promise<void>((resolve) => (releaseSubscribe = resolve));
    let subscribeEntered!: () => void;
    const entered = new Promise<void>((resolve) => (subscribeEntered = resolve));
    subscribeBehaviour = async () => {
      subscribeEntered();
      await subscribeGate;
    };

    const stream = await openStream(positionId);
    await entered;
    stream.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseSubscribe();

    await until(() => subscriptions.length === 2 && subscriptions.every((subscription) => subscription.unsubscribe.mock.calls.length === 1));
    expect(subscriptions).toHaveLength(2);
  });
});
