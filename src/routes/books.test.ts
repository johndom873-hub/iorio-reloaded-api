import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";

// The books' routes (Marcelo 2026-11-05) against a private copy of the test tables: splitting a deposit waiting in
// Unallocated, moving cash between the books (the source's available cash mocked), and the ticker switch's writes.
const sessionAccess = vi.hoisted(() => ({ level: "admin" as "admin" | "trader", manualAvailable: 65_000 as number | null }));
vi.mock("../lib/sessionUser.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/sessionUser.js")>()),
  loadSessionUser: async (userId: string) => ({ id: userId, displayName: "Books Tester", accessLevel: sessionAccess.level, disabledAt: null }),
}));
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
vi.mock("../books/bookFigures.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../books/bookFigures.js")>()),
  loadBooksLiveState: async () => ({
    ready: true,
    books: { pluto: { availableCash: 110_000 }, manual: { availableCash: sessionAccess.manualAvailable } },
    unallocatedCash: 0,
    ibkrTotalCash: 0,
    ibkrNetLiquidationValue: 0,
    cashGapAgainstIbkr: 0,
    confirmedThrough: new Date(),
    minCashReservePct: 5,
  }),
}));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { booksRouter } = await import("./books.js");
const { applyTickerSwitch, legTransferFigures } = await import("../books/tickerSwitch.js");

let server: Server;
let baseUrl: string;
const userId = randomUUID();

beforeAll(async () => {
  await db("users").insert({ id: userId, username: "books-tester", display_name: "Books Tester", password_hash: "x" });
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    (request as unknown as { session: { userId?: string } }).session = { userId };
    next();
  });
  app.use("/books", booksRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db("book_cash_entries").whereNotNull("allocates_entry_id").del();
  await db("book_cash_entries").del();
  sessionAccess.level = "admin";
  sessionAccess.manualAvailable = 65_000;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await dropIsolatedTestDatabase(db);
});

async function call(method: "GET" | "POST", path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function waitingTransfer(amount: number): Promise<string> {
  const [row] = await db("book_cash_entries").insert({ book_key: "unallocated", amount, effective_at: new Date(), kind: "external_transfer", group_id: randomUUID(), description: "TRANSFER FROM U9813636" }).returning("id");
  return row.id;
}

const totalsByBook = async () => Object.fromEntries((await db("book_cash_entries").groupBy("book_key").select("book_key", db.raw("SUM(amount)::float AS total"))).map((row: { book_key: string; total: number }) => [row.book_key, row.total]));

describe("POST /books/pending-transfers/:entryId/split", () => {
  it("splits a $50,000 deposit 30,000 / 20,000, empties Unallocated, and refuses a second split", async () => {
    const entryId = await waitingTransfer(50_000);
    expect(await call("POST", `/books/pending-transfers/${entryId}/split`, { plutoDollars: 30_000, manualDollars: 20_000 })).toEqual({ status: 200, json: { split: true } });
    expect(await totalsByBook()).toEqual({ unallocated: 0, pluto: 30_000, manual: 20_000 });
    expect((await call("POST", `/books/pending-transfers/${entryId}/split`, { plutoDollars: 50_000, manualDollars: 0 })).status).toBe(409);
  });

  it("refuses parts that do not add up to the amount, or a withdrawal part above 0", async () => {
    const deposit = await waitingTransfer(50_000);
    expect(await call("POST", `/books/pending-transfers/${deposit}/split`, { plutoDollars: 30_000, manualDollars: 19_999 })).toEqual({ status: 400, json: { error: "The two parts must add up to $50,000." } });
    const withdrawal = await waitingTransfer(-10_000);
    expect(await call("POST", `/books/pending-transfers/${withdrawal}/split`, { plutoDollars: 5_000, manualDollars: -15_000 })).toEqual({ status: 400, json: { error: "A withdrawal's parts cannot be positive." } });
    expect((await call("POST", `/books/pending-transfers/${withdrawal}/split`, { plutoDollars: -4_000, manualDollars: -6_000 })).status).toBe(200);
  });

  it("is an admin's", async () => {
    const entryId = await waitingTransfer(1_000);
    sessionAccess.level = "trader";
    expect((await call("POST", `/books/pending-transfers/${entryId}/split`, { plutoDollars: 1_000, manualDollars: 0 })).status).toBe(403);
  });
});

describe("POST /books/moves", () => {
  it("moves up to the source's available cash, and refuses a dollar more", async () => {
    expect(await call("POST", "/books/moves", { fromBook: "manual", toBook: "pluto", amountDollars: 10_000 })).toEqual({ status: 200, json: { moved: true } });
    expect(await totalsByBook()).toEqual({ manual: -10_000, pluto: 10_000 });
    expect(await call("POST", "/books/moves", { fromBook: "manual", toBook: "pluto", amountDollars: 65_000.01 })).toEqual({ status: 409, json: { error: "Manual can move up to $65,000, its available cash." } });
  });

  it("refuses when IBKR's cash is unknown, a book moving to itself, and a trader", async () => {
    sessionAccess.manualAvailable = null;
    expect((await call("POST", "/books/moves", { fromBook: "manual", toBook: "pluto", amountDollars: 1 })).status).toBe(503);
    expect((await call("POST", "/books/moves", { fromBook: "pluto", toBook: "pluto", amountDollars: 1 })).status).toBe(400);
    sessionAccess.level = "trader";
    expect((await call("POST", "/books/moves", { fromBook: "pluto", toBook: "manual", amountDollars: 1 })).status).toBe(403);
  });
});

describe("the ticker switch", () => {
  it("prices the mockup's AMD legs: Manual realises +$2,480 and +$170, Pluto pays $32,290", () => {
    const shares = legTransferFigures({ side: "long", quantity: 200, multiplier: 1 }, 150, 162.4);
    const call = legTransferFigures({ side: "short", quantity: 2, multiplier: 100 }, 1.8, 0.95);
    expect(shares.valueDollars).toBeCloseTo(32_480, 9);
    expect(shares.realizedDollars).toBeCloseTo(2_480, 9);
    expect(call.valueDollars).toBeCloseTo(-190, 9);
    expect(call.realizedDollars).toBeCloseTo(170, 9);
  });

  it("opens Pluto's period and records each leg and the cash between the books, Pluto paying the legs' value", async () => {
    const [ticker] = await db("tickers").insert({ symbol: "ZZSWITCH" }).returning("id");
    const [position] = await db("positions").insert({ ticker_id: ticker.id, strategy_key: "unstructured", status: "open" }).returning("id");
    const [leg] = await db("position_legs").insert({ position_id: position.id, leg_type: "stock", side: "long", quantity: 200, multiplier: 1, entry_price: 150, entry_at: new Date() }).returning("id");
    const plan = {
      symbol: "ZZSWITCH",
      fromBook: "manual" as const,
      toBook: "pluto" as const,
      legs: [{ legId: leg.id, label: "200 ZZSWITCH shares", side: "long" as const, quantity: 200, multiplier: 1, costBasisPrice: 150, markPrice: 162.4, markSource: "live" as const, valueDollars: 32_480, realizedDollars: 2_480 }],
      totalValueDollars: 32_480,
      realizedDollars: 2_480,
    };
    await db.transaction((trx) => applyTickerSwitch(trx, ticker.id, plan, userId));
    expect(await db("ticker_book_periods").where({ ticker_id: ticker.id }).whereNull("ended_at").first("book_key")).toEqual({ book_key: "pluto" });
    expect(await db("book_leg_transfers").where({ position_leg_id: leg.id }).first("from_book", "to_book", db.raw("mark_price::float AS mark"), db.raw("realized_dollars::float AS realized"))).toEqual({ from_book: "manual", to_book: "pluto", mark: 162.4, realized: 2_480 });
    expect(await totalsByBook()).toEqual({ pluto: -32_480, manual: 32_480 });
  });
});
