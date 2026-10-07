import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real calendarEventsRouter on a small express app against the test database. Only the TradingView fetch behind the on-demand
// capture is mocked: its stand-in stores calendar rows for the ticker the way the real capture does.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run calendar events route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
const captureTickerCalendarEventsMock = vi.fn();
vi.mock("../lib/tradingviewCalendarService.js", () => ({ captureTickerCalendarEvents: (...args: unknown[]) => captureTickerCalendarEventsMock(...args) }));

const { db } = await import("../db/connection.js");
const { calendarEventsRouter } = await import("./calendarEvents.js");

const testDb: Knex = db;

const runTag = String(Date.now() % 100_000_000);
const symbolPrefix = `CAL${runTag}`;
const titlePrefix = `calendar-route-${runTag}`;

let server: Server;
let baseUrl: string;
const tickerIdBySymbol = new Map<string, string>();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/calendar-events", calendarEventsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  captureTickerCalendarEventsMock.mockReset();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const tickerIds = [...tickerIdBySymbol.values()];
  await testDb("ticker_calendar_events").whereIn("ticker_id", tickerIds).del();
  await testDb("tickers").whereIn("id", tickerIds).del();
  await testDb("major_macro_events").where("event_key", "like", `${titlePrefix}%`).del();
  await testDb.destroy();
});

async function createTicker(letter: string): Promise<string> {
  const symbol = `${symbolPrefix}${letter}`;
  const [ticker] = await testDb("tickers").insert({ symbol }).returning("id");
  tickerIdBySymbol.set(symbol, ticker.id);
  return ticker.id;
}

/** A calendar date relative to the database's own CURRENT_DATE, which is what the routes compare against. */
const relativeDate = (daysFromToday: number) => testDb.raw("CURRENT_DATE + ?::int", [daysFromToday]);

async function readRelativeDateIso(daysFromToday: number): Promise<string> {
  const result = await testDb.raw("SELECT to_char(CURRENT_DATE + ?::int, 'YYYY-MM-DD') AS iso", [daysFromToday]);
  return result.rows[0].iso;
}

async function insertTickerEvent(tickerId: string, eventType: string, daysFromToday: number, extra: { eventTime?: string | null; amount?: number | null } = {}) {
  await testDb("ticker_calendar_events").insert({
    ticker_id: tickerId,
    event_type: eventType,
    event_date: relativeDate(daysFromToday),
    event_time: extra.eventTime ?? null,
    amount: extra.amount ?? null,
    raw: {},
  });
}

/** A major macro event `minutesFromEasternMidnight` after 00:00 ET today (negative = an earlier day). */
async function insertMacroEvent(slug: string, minutesFromEasternMidnight: number) {
  await testDb("major_macro_events").insert({
    event_key: `${titlePrefix}-${slug}`,
    title: `${titlePrefix}-${slug}`,
    source: "fred",
    event_at: testDb.raw("((CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date::timestamp AT TIME ZONE 'America/New_York') + (?::int * interval '1 minute')", [minutesFromEasternMidnight]),
  });
}

async function readEasternDateIso(daysFromToday: number): Promise<string> {
  const result = await testDb.raw("SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')::date + ?::int, 'YYYY-MM-DD') AS iso", [daysFromToday]);
  return result.rows[0].iso;
}

async function call(path: string, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? "user-1" : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, { headers: asUser ? { "x-test-user-id": asUser } : {} });
  return { status: response.status, json: (await response.json()) as any };
}

describe("auth", () => {
  it.each(["/calendar-events", "/calendar-events/next/AAPL"])("%s is refused without a session", async (path) => {
    expect(await call(path, { asUser: null })).toEqual({ status: 401, json: { error: "Not logged in." } });
  });
});

describe("GET /calendar-events: ticker events", () => {
  let earlierIso: string;
  let laterIso: string;

  beforeAll(async () => {
    const tickerZulu = await createTicker("Z");
    const tickerAlpha = await createTicker("A");
    const tickerPast = await createTicker("P");
    await insertTickerEvent(tickerZulu, "earnings", 5, { eventTime: "amc", amount: 1.25 });
    await insertTickerEvent(tickerAlpha, "ex_dividend", 5, { amount: 0.25 });
    await insertTickerEvent(tickerAlpha, "earnings", 3);
    await insertTickerEvent(tickerZulu, "ex_dividend", 0, { amount: 0.5 });
    await insertTickerEvent(tickerPast, "earnings", -1);
    await insertTickerEvent(tickerPast, "ex_dividend", -30);
    earlierIso = await readRelativeDateIso(3);
    laterIso = await readRelativeDateIso(5);
  });

  const mine = async () => {
    const { json } = await call("/calendar-events");
    return (json.tickerEvents as { symbol: string }[]).filter((event) => event.symbol.startsWith(symbolPrefix));
  };

  it("lists today's and later events, soonest first and by symbol within a day, without yesterday's or older ones", async () => {
    const todayIso = await readRelativeDateIso(0);
    expect((await mine()).map((event: any) => [event.symbol.slice(symbolPrefix.length), event.eventType, event.eventDate])).toEqual([
      ["Z", "ex_dividend", todayIso],
      ["A", "earnings", earlierIso],
      ["A", "ex_dividend", laterIso],
      ["Z", "earnings", laterIso],
    ]);
  });

  it("returns each event with its id, a plain YYYY-MM-DD date, the time label and the amount (numerics arrive as text)", async () => {
    const events = (await mine()) as any[];
    const zuluEarnings = events.find((event) => event.symbol === `${symbolPrefix}Z` && event.eventType === "earnings");
    expect(zuluEarnings).toEqual({ id: expect.any(String), symbol: `${symbolPrefix}Z`, eventType: "earnings", eventDate: laterIso, eventTime: "amc", amount: "1.2500" });
    const alphaEarnings = events.find((event) => event.symbol === `${symbolPrefix}A` && event.eventType === "earnings");
    expect(alphaEarnings).toMatchObject({ eventTime: null, amount: null });
  });

  it("does not list a ticker that has only past events", async () => {
    expect((await mine()).some((event) => event.symbol === `${symbolPrefix}P`)).toBe(false);
  });
});

describe("GET /calendar-events: major macro events", () => {
  beforeAll(async () => {
    await insertMacroEvent("later", 3 * 24 * 60 + 14 * 60);
    await insertMacroEvent("sooner", 24 * 60 + 8 * 60 + 30);
    await insertMacroEvent("yesterday", -24 * 60 + 8 * 60 + 30);
    await insertMacroEvent("earlier-today", 1);
  });

  const mine = async () => {
    const { json } = await call("/calendar-events");
    return (json.macroEvents as { title: string }[]).filter((event) => event.title.startsWith(titlePrefix));
  };

  it("lists the events from the start of today (Eastern) on, soonest first", async () => {
    expect((await mine()).map((event) => event.title.slice(titlePrefix.length + 1))).toEqual(["earlier-today", "sooner", "later"]);
  });

  it("returns each event's Eastern date, release instant and title", async () => {
    const event = ((await mine()) as any[]).find((row) => row.title === `${titlePrefix}-sooner`);
    expect(event).toEqual({ dateIso: await readEasternDateIso(1), eventAtIso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T(12|13):30:00Z$/), title: `${titlePrefix}-sooner` });
  });

  it("answers with both lists as arrays", async () => {
    const { status, json } = await call("/calendar-events");
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(["macroEvents", "tickerEvents"]);
    expect(Array.isArray(json.tickerEvents)).toBe(true);
    expect(Array.isArray(json.macroEvents)).toBe(true);
  });
});

describe("GET /calendar-events/next/:symbol", () => {
  it("answers with the soonest upcoming earnings date and ex-dividend date, ignoring past ones, and does not call TradingView", async () => {
    const tickerId = await createTicker("N1");
    await insertTickerEvent(tickerId, "earnings", -10);
    await insertTickerEvent(tickerId, "earnings", 40);
    await insertTickerEvent(tickerId, "earnings", 12);
    await insertTickerEvent(tickerId, "ex_dividend", 7);
    await insertTickerEvent(tickerId, "ex_dividend", 90);
    await insertTickerEvent(tickerId, "ex_dividend", -1);

    const response = await call(`/calendar-events/next/${symbolPrefix}N1`);

    expect(response).toEqual({ status: 200, json: { nextEarningsDate: await readRelativeDateIso(12), nextExDividendDate: await readRelativeDateIso(7) } });
    expect(captureTickerCalendarEventsMock).not.toHaveBeenCalled();
  });

  it("counts an event dated today as upcoming", async () => {
    const tickerId = await createTicker("N2");
    await insertTickerEvent(tickerId, "earnings", 0);
    await insertTickerEvent(tickerId, "ex_dividend", 1);
    expect((await call(`/calendar-events/next/${symbolPrefix}N2`)).json).toEqual({ nextEarningsDate: await readRelativeDateIso(0), nextExDividendDate: await readRelativeDateIso(1) });
  });

  it("looks the symbol up in upper case", async () => {
    const tickerId = await createTicker("N3");
    await insertTickerEvent(tickerId, "earnings", 4);
    const response = await call(`/calendar-events/next/${symbolPrefix.toLowerCase()}n3`);
    expect(response.status).toBe(200);
    expect(response.json.nextEarningsDate).toBe(await readRelativeDateIso(4));
  });

  it("an unknown ticker is a 404 naming it in upper case, with no capture attempt", async () => {
    expect(await call(`/calendar-events/next/${symbolPrefix.toLowerCase()}nobody`)).toEqual({ status: 404, json: { error: `Unknown ticker ${symbolPrefix}NOBODY` } });
    expect(captureTickerCalendarEventsMock).not.toHaveBeenCalled();
  });

  it("one date known and the other not does not trigger a capture", async () => {
    const tickerId = await createTicker("N4");
    await insertTickerEvent(tickerId, "earnings", 20);
    const response = await call(`/calendar-events/next/${symbolPrefix}N4`);
    expect(response.json).toEqual({ nextEarningsDate: await readRelativeDateIso(20), nextExDividendDate: null });
    expect(captureTickerCalendarEventsMock).not.toHaveBeenCalled();
  });

  it("a ticker with only past events has nothing upcoming, so it is captured on the spot", async () => {
    const tickerId = await createTicker("N5");
    await insertTickerEvent(tickerId, "earnings", -5);
    captureTickerCalendarEventsMock.mockResolvedValue(undefined);
    const response = await call(`/calendar-events/next/${symbolPrefix}N5`);
    expect(response).toEqual({ status: 200, json: { nextEarningsDate: null, nextExDividendDate: null } });
    expect(captureTickerCalendarEventsMock).toHaveBeenCalledWith(tickerId, `${symbolPrefix}N5`);
  });

  it("a ticker with no captured rows is captured on the spot and the response carries what the capture stored", async () => {
    const tickerId = await createTicker("N6");
    captureTickerCalendarEventsMock.mockImplementation(async (capturedTickerId: string) => {
      await insertTickerEvent(capturedTickerId, "earnings", 33);
      await insertTickerEvent(capturedTickerId, "ex_dividend", 21);
    });

    const response = await call(`/calendar-events/next/${symbolPrefix}N6`);

    expect(captureTickerCalendarEventsMock).toHaveBeenCalledTimes(1);
    expect(captureTickerCalendarEventsMock).toHaveBeenCalledWith(tickerId, `${symbolPrefix}N6`);
    expect(response).toEqual({ status: 200, json: { nextEarningsDate: await readRelativeDateIso(33), nextExDividendDate: await readRelativeDateIso(21) } });
  });

  it("a capture that finds nothing leaves both dates null", async () => {
    await createTicker("N7");
    captureTickerCalendarEventsMock.mockResolvedValue(undefined);
    expect((await call(`/calendar-events/next/${symbolPrefix}N7`)).json).toEqual({ nextEarningsDate: null, nextExDividendDate: null });
  });

  it("a capture that fails is logged and the answer is still a 200 with null dates", async () => {
    await createTicker("N8");
    captureTickerCalendarEventsMock.mockRejectedValue(new Error("TradingView unreachable"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await call(`/calendar-events/next/${symbolPrefix}N8`)).toEqual({ status: 200, json: { nextEarningsDate: null, nextExDividendDate: null } });
      expect(consoleErrorSpy).toHaveBeenCalledWith(`GET /calendar-events/next: on-demand capture failed for ${symbolPrefix}N8`, expect.any(Error));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
