import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The Day Signals tables against the real test database. The day tables are wiped wholesale by the seed itself and are empty
// between test files, so each test starts from empty ones.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the Day Signals store tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});

const { db } = await import("../db/connection.js");
const store = await import("./daySignalsStore.js");
const testDb: Knex = db;

const createdTickerIds: string[] = [];
const createdSnapshotIds: string[] = [];
const createdPositionIds: string[] = [];
let counter = Date.now() % 100_000;
const tradingDate = "2031-03-03";
const seededAt = new Date("2031-03-03T15:00:00Z");

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `DS${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Day Signals Store Test Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return { id: ticker.id, symbol };
}

async function createSnapshot(tickerId: string, contracts: { expiry: string; strike: number; right: "C" | "P" }[] = []): Promise<string> {
  const [snapshot] = await testDb("option_chain_snapshots").insert({ ticker_id: tickerId, trading_date: tradingDate, captured_at: seededAt, status: "complete" }).returning(["id"]);
  createdSnapshotIds.push(snapshot.id);
  if (contracts.length > 0) await testDb("option_quote_snapshots").insert(contracts.map((contract) => ({ snapshot_id: snapshot.id, expiry: contract.expiry, strike: contract.strike, option_right: contract.right })));
  return snapshot.id;
}

const seedExpiry = (expiry: string, rank: number) => ({ expiry, rank, seedBestEdgeDollars: 100 * rank, seedBestNetEdge: 0.01 * rank });
const quoteWrite = (tickerId: string, overrides: Partial<Parameters<typeof store.upsertDayQuotes>[0][number]> = {}) => ({
  tickerId,
  expiry: "2031-03-21",
  strike: 100,
  right: "P" as const,
  tradingDateIso: tradingDate,
  bid: 1.1,
  ask: 1.3,
  last: 1.2,
  errorCode: null,
  quotedAt: new Date("2031-03-03T15:30:00Z"),
  cycleNumber: 1,
  ...overrides,
});

async function createHeldOptionLeg(tickerId: string): Promise<{ positionId: string; legId: string }> {
  const [position] = await testDb("positions").insert({ strategy_key: "covered_call", ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning(["id"]);
  createdPositionIds.push(position.id);
  const [leg] = await testDb("position_legs")
    .insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 1, multiplier: 100, option_type: "call", strike_price: 110, expiry_date: "2031-03-21", entry_price: 2, entry_at: new Date() })
    .returning(["id"]);
  return { positionId: position.id, legId: leg.id };
}

async function wipeDayTables() {
  await testDb("day_signal_rerank_state").del();
  await testDb("day_signal_roll_grades").del();
  await testDb("day_signal_quotes").del();
  await testDb("day_signal_expiries").del();
}

beforeEach(wipeDayTables);

afterAll(async () => {
  await wipeDayTables();
  await testDb("position_legs").whereIn("position_id", createdPositionIds).del();
  await testDb("positions").whereIn("id", createdPositionIds).del();
  await testDb("option_chain_snapshots").whereIn("id", createdSnapshotIds).del();
  await testDb("tickers").whereIn("id", createdTickerIds).del();
  await testDb.destroy();
});

describe("replaceDaySignalPool and loadDaySignalExpiries", () => {
  it("writes the pool and reads it back ordered by symbol then rank", async () => {
    const [first, second] = [await createTicker(), await createTicker()];
    const [firstSnapshot, secondSnapshot] = [await createSnapshot(first.id), await createSnapshot(second.id)];
    await store.replaceDaySignalPool(
      tradingDate,
      [
        { tickerId: second.id, snapshotId: secondSnapshot, expiries: [seedExpiry("2031-03-28", 2), seedExpiry("2031-03-21", 1)] },
        { tickerId: first.id, snapshotId: firstSnapshot, expiries: [seedExpiry("2031-03-21", 1)] },
      ],
      seededAt,
    );
    const rows = await store.loadDaySignalExpiries(tradingDate);
    expect(rows).toEqual([
      { tickerId: first.id, symbol: first.symbol, expiry: "2031-03-21", tradingDateIso: tradingDate, snapshotId: firstSnapshot, rank: 1 },
      { tickerId: second.id, symbol: second.symbol, expiry: "2031-03-21", tradingDateIso: tradingDate, snapshotId: secondSnapshot, rank: 1 },
      { tickerId: second.id, symbol: second.symbol, expiry: "2031-03-28", tradingDateIso: tradingDate, snapshotId: secondSnapshot, rank: 2 },
    ]);
    expect(await store.loadDaySignalExpiries("2031-03-04")).toEqual([]);
  });

  it("wipes every day table first, including quotes, roll grades and re-rank state", async () => {
    const ticker = await createTicker();
    const snapshotId = await createSnapshot(ticker.id);
    const { legId } = await createHeldOptionLeg(ticker.id);
    await store.upsertDayQuotes([quoteWrite(ticker.id)]);
    await store.upsertDayRollGrades(ticker.id, tradingDate, [{ legId, expiry: "2031-03-28", strike: 105, right: "C", grade: "good" }]);
    await store.saveDayRerankState(ticker.id, tradingDate, { referenceSpotPrice: 99, reranks: 2 });

    await store.replaceDaySignalPool(tradingDate, [{ tickerId: ticker.id, snapshotId, expiries: [seedExpiry("2031-03-21", 1)] }], seededAt);

    expect(await store.loadDayQuotesForTicker(ticker.id, tradingDate)).toEqual([]);
    expect(await store.loadDayRollGrades(ticker.id, tradingDate)).toEqual([]);
    expect((await store.loadDayRerankStates(tradingDate)).size).toBe(0);
    expect(await store.loadDaySignalExpiries(tradingDate)).toHaveLength(1);
  });

  it("an empty seed just clears the pool", async () => {
    const ticker = await createTicker();
    const snapshotId = await createSnapshot(ticker.id);
    await store.replaceDaySignalPool(tradingDate, [{ tickerId: ticker.id, snapshotId, expiries: [seedExpiry("2031-03-21", 1)] }], seededAt);
    await store.replaceDaySignalPool(tradingDate, [], seededAt);
    expect(await store.loadDaySignalExpiries(tradingDate)).toEqual([]);
  });
});

describe("replaceTickerPoolExpiries (a mid-day re-rank)", () => {
  it("returns false and changes nothing for an empty expiry list", async () => {
    const ticker = await createTicker();
    const snapshotId = await createSnapshot(ticker.id);
    await store.replaceDaySignalPool(tradingDate, [{ tickerId: ticker.id, snapshotId, expiries: [seedExpiry("2031-03-21", 1)] }], seededAt);
    expect(await store.replaceTickerPoolExpiries(ticker.id, tradingDate, snapshotId, [], seededAt)).toBe(false);
    expect(await store.loadDaySignalExpiries(tradingDate)).toHaveLength(1);
  });

  it("replaces only that ticker's pooled expiries and deletes its quotes of expiries that dropped out", async () => {
    const [target, other] = [await createTicker(), await createTicker()];
    const [targetSnapshot, otherSnapshot] = [await createSnapshot(target.id), await createSnapshot(other.id)];
    await store.replaceDaySignalPool(
      tradingDate,
      [
        { tickerId: target.id, snapshotId: targetSnapshot, expiries: [seedExpiry("2031-03-21", 1), seedExpiry("2031-03-28", 2)] },
        { tickerId: other.id, snapshotId: otherSnapshot, expiries: [seedExpiry("2031-03-21", 1)] },
      ],
      seededAt,
    );
    await store.upsertDayQuotes([quoteWrite(target.id, { expiry: "2031-03-21" }), quoteWrite(target.id, { expiry: "2031-03-28" }), quoteWrite(other.id, { expiry: "2031-03-21" })]);

    expect(await store.replaceTickerPoolExpiries(target.id, tradingDate, targetSnapshot, [seedExpiry("2031-04-04", 1), seedExpiry("2031-03-28", 2)], seededAt)).toBe(true);

    const expiries = await store.loadDaySignalExpiries(tradingDate);
    expect(expiries.filter((row) => row.tickerId === target.id).map((row) => row.expiry).sort()).toEqual(["2031-03-28", "2031-04-04"]);
    expect(expiries.filter((row) => row.tickerId === other.id)).toHaveLength(1);
    expect((await store.loadDayQuotesForTicker(target.id, tradingDate)).map((row) => row.expiry)).toEqual(["2031-03-28"]);
    expect(await store.loadDayQuotesForTicker(other.id, tradingDate)).toHaveLength(1);
  });

  it("creates the pool for a ticker the morning seed left out", async () => {
    const ticker = await createTicker();
    const snapshotId = await createSnapshot(ticker.id);
    expect(await store.replaceTickerPoolExpiries(ticker.id, tradingDate, snapshotId, [seedExpiry("2031-03-21", 1)], seededAt)).toBe(true);
    expect(await store.loadDaySignalExpiries(tradingDate)).toHaveLength(1);
  });
});

describe("re-rank state", () => {
  it("saves, updates in place, and only loads the asked trading date", async () => {
    const ticker = await createTicker();
    await store.saveDayRerankState(ticker.id, tradingDate, { referenceSpotPrice: 101.5, reranks: 1 });
    await store.saveDayRerankState(ticker.id, tradingDate, { referenceSpotPrice: 104.25, reranks: 2 });
    expect([...(await store.loadDayRerankStates(tradingDate))]).toEqual([[ticker.id, { referenceSpotPrice: 104.25, reranks: 2 }]]);
    expect((await store.loadDayRerankStates("2031-03-04")).size).toBe(0);
  });

  it("a new day's save replaces the old day's row for the ticker", async () => {
    const ticker = await createTicker();
    await store.saveDayRerankState(ticker.id, tradingDate, { referenceSpotPrice: 100, reranks: 3 });
    await store.saveDayRerankState(ticker.id, "2031-03-04", { referenceSpotPrice: 90, reranks: 1 });
    expect((await store.loadDayRerankStates(tradingDate)).size).toBe(0);
    expect((await store.loadDayRerankStates("2031-03-04")).get(ticker.id)).toEqual({ referenceSpotPrice: 90, reranks: 1 });
  });
});

describe("loadDaySignalUniverse", () => {
  it("lists the captured contracts of pooled expiries only, in ticker, expiry, strike, right order", async () => {
    const ticker = await createTicker();
    const snapshotId = await createSnapshot(ticker.id, [
      { expiry: "2031-03-28", strike: 95, right: "P" },
      { expiry: "2031-03-21", strike: 105, right: "C" },
      { expiry: "2031-03-21", strike: 95, right: "P" },
      { expiry: "2031-03-21", strike: 95, right: "C" },
    ]);
    await store.replaceDaySignalPool(tradingDate, [{ tickerId: ticker.id, snapshotId, expiries: [seedExpiry("2031-03-21", 1)] }], seededAt);

    expect(await store.loadDaySignalUniverse(tradingDate)).toEqual([
      { tickerId: ticker.id, symbol: ticker.symbol, expiry: "2031-03-21", strike: 95, right: "C" },
      { tickerId: ticker.id, symbol: ticker.symbol, expiry: "2031-03-21", strike: 95, right: "P" },
      { tickerId: ticker.id, symbol: ticker.symbol, expiry: "2031-03-21", strike: 105, right: "C" },
    ]);
    expect(await store.loadDaySignalUniverse("2031-03-04")).toEqual([]);
  });
});

describe("day quotes", () => {
  it("writes quotes and reads them back with numbers, nulls and an ISO time", async () => {
    const ticker = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id), quoteWrite(ticker.id, { strike: 105, bid: null, ask: null, last: null, errorCode: 200 })]);
    const rows = await store.loadDayQuotesForTicker(ticker.id, tradingDate);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.strike === 100)).toEqual({
      tickerId: ticker.id,
      expiry: "2031-03-21",
      strike: 100,
      right: "P",
      tradingDateIso: tradingDate,
      bid: 1.1,
      ask: 1.3,
      last: 1.2,
      errorCode: null,
      quotedAt: "2031-03-03T15:30:00.000Z",
      cycleNumber: 1,
      lastGrade: null,
    });
    expect(rows.find((row) => row.strike === 105)).toMatchObject({ bid: null, ask: null, last: null, errorCode: 200 });
  });

  it("an empty write list is a no-op", async () => {
    await expect(store.upsertDayQuotes([])).resolves.toBeUndefined();
  });

  it("a re-quote of the same contract updates the quote in place and keeps its last grade", async () => {
    const ticker = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id)]);
    await store.updateDayQuoteGrades(ticker.id, [{ expiry: "2031-03-21", strike: 100, right: "P", grade: "good" }]);
    await store.upsertDayQuotes([quoteWrite(ticker.id, { bid: 1.4, ask: 1.6, cycleNumber: 2, quotedAt: new Date("2031-03-03T15:31:00Z") })]);

    const [row] = await store.loadDayQuotesForTicker(ticker.id, tradingDate);
    expect(row).toMatchObject({ bid: 1.4, ask: 1.6, cycleNumber: 2, quotedAt: "2031-03-03T15:31:00.000Z", lastGrade: "good" });
  });

  it("only returns quotes of the asked trading date", async () => {
    const ticker = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id, { tradingDateIso: "2031-03-02" })]);
    expect(await store.loadDayQuotesForTicker(ticker.id, tradingDate)).toEqual([]);
  });

  it("updates grades only for the named contracts, and an empty list does nothing", async () => {
    const ticker = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id), quoteWrite(ticker.id, { strike: 105 }), quoteWrite(ticker.id, { strike: 100, right: "C" })]);
    await store.updateDayQuoteGrades(ticker.id, []);
    await store.updateDayQuoteGrades(ticker.id, [
      { expiry: "2031-03-21", strike: 100, right: "P", grade: "strong" },
      { expiry: "2031-03-21", strike: 100, right: "C", grade: "avoid" },
    ]);
    const gradeOf = async (strike: number, right: "C" | "P") => (await store.loadDayQuotesForTicker(ticker.id, tradingDate)).find((row) => row.strike === strike && row.right === right)!.lastGrade;
    expect(await gradeOf(100, "P")).toBe("strong");
    expect(await gradeOf(100, "C")).toBe("avoid");
    expect(await gradeOf(105, "P")).toBeNull();
  });

  it("prunes quotes outside the kept contracts, but never wipes on an empty keep list", async () => {
    const ticker = await createTicker();
    const other = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id), quoteWrite(ticker.id, { strike: 105 }), quoteWrite(ticker.id, { strike: 100, right: "C" }), quoteWrite(other.id)]);

    await store.pruneDayQuotesOutsideSet(ticker.id, []);
    expect(await store.loadDayQuotesForTicker(ticker.id, tradingDate)).toHaveLength(3);

    await store.pruneDayQuotesOutsideSet(ticker.id, [{ expiry: "2031-03-21", strike: 100, right: "P" }]);
    const remaining = await store.loadDayQuotesForTicker(ticker.id, tradingDate);
    expect(remaining.map((row) => [row.strike, row.right])).toEqual([[100, "P"]]);
    expect(await store.loadDayQuotesForTicker(other.id, tradingDate)).toHaveLength(1);
  });
});

describe("loadDayQuotesStatus", () => {
  it("is all zeros and nulls when nothing is stored", async () => {
    expect(await store.loadDayQuotesStatus()).toEqual({ tradingDateIso: null, quoteCount: 0, oldestQuotedAt: null, newestQuotedAt: null, expiryCount: 0, tickerCount: 0 });
  });

  it("counts quotes, expiries and tickers and reports the oldest and newest quote", async () => {
    const [first, second] = [await createTicker(), await createTicker()];
    const [firstSnapshot, secondSnapshot] = [await createSnapshot(first.id), await createSnapshot(second.id)];
    await store.replaceDaySignalPool(
      tradingDate,
      [
        { tickerId: first.id, snapshotId: firstSnapshot, expiries: [seedExpiry("2031-03-21", 1), seedExpiry("2031-03-28", 2)] },
        { tickerId: second.id, snapshotId: secondSnapshot, expiries: [seedExpiry("2031-03-21", 1)] },
      ],
      seededAt,
    );
    await store.upsertDayQuotes([
      quoteWrite(first.id, { quotedAt: new Date("2031-03-03T15:30:00Z") }),
      quoteWrite(first.id, { strike: 105, quotedAt: new Date("2031-03-03T15:45:00Z") }),
      quoteWrite(second.id, { quotedAt: new Date("2031-03-03T15:35:00Z") }),
    ]);
    expect(await store.loadDayQuotesStatus()).toEqual({
      tradingDateIso: tradingDate,
      quoteCount: 3,
      oldestQuotedAt: "2031-03-03T15:30:00.000Z",
      newestQuotedAt: "2031-03-03T15:45:00.000Z",
      expiryCount: 3,
      tickerCount: 2,
    });
  });

  it("falls back to the quotes' trading date when no expiry is pooled", async () => {
    const ticker = await createTicker();
    await store.upsertDayQuotes([quoteWrite(ticker.id)]);
    expect(await store.loadDayQuotesStatus()).toMatchObject({ tradingDateIso: tradingDate, quoteCount: 1, expiryCount: 0, tickerCount: 0 });
  });
});

describe("roll grades", () => {
  it("saves each (leg, replacement) grade, updates it on a re-score, and scopes by ticker and date", async () => {
    const ticker = await createTicker();
    const { legId } = await createHeldOptionLeg(ticker.id);
    const replacement = { legId, expiry: "2031-03-28", strike: 105, right: "C" as const };
    await store.upsertDayRollGrades(ticker.id, tradingDate, []);
    await store.upsertDayRollGrades(ticker.id, tradingDate, [{ ...replacement, grade: "weak" }]);
    await store.upsertDayRollGrades(ticker.id, tradingDate, [{ ...replacement, grade: "strong" }]);

    expect(await store.loadDayRollGrades(ticker.id, tradingDate)).toEqual([{ ...replacement, lastGrade: "strong" }]);
    expect(await store.loadDayRollGrades(ticker.id, "2031-03-04")).toEqual([]);
    expect(await store.loadDayRollGrades((await createTicker()).id, tradingDate)).toEqual([]);
  });
});

describe("assignment-risk alert state", () => {
  it("is empty for no legs and absent for unknown legs", async () => {
    expect((await store.loadAssignmentRiskAlertStates([])).size).toBe(0);
    expect((await store.loadAssignmentRiskAlertStates(["00000000-0000-0000-0000-000000000000"])).size).toBe(0);
  });

  it("starts armed, records an alert with its trading date, and re-arming keeps the last alert date for the once-a-day rule", async () => {
    const ticker = await createTicker();
    const { legId } = await createHeldOptionLeg(ticker.id);
    expect((await store.loadAssignmentRiskAlertStates([legId])).get(legId)).toEqual({ notifiedAt: null, lastAlertTradingDateIso: null });

    await store.recordAssignmentRiskAlert(legId, tradingDate);
    const flagged = (await store.loadAssignmentRiskAlertStates([legId])).get(legId)!;
    expect(flagged.lastAlertTradingDateIso).toBe(tradingDate);
    expect(flagged.notifiedAt).not.toBeNull();
    expect(Math.abs(Date.now() - new Date(flagged.notifiedAt!).getTime())).toBeLessThan(60_000);

    await store.rearmAssignmentRiskAlert(legId);
    expect((await store.loadAssignmentRiskAlertStates([legId])).get(legId)).toEqual({ notifiedAt: null, lastAlertTradingDateIso: tradingDate });
  });

  it("loads several legs at once", async () => {
    const ticker = await createTicker();
    const [first, second] = [await createHeldOptionLeg(ticker.id), await createHeldOptionLeg(ticker.id)];
    await store.recordAssignmentRiskAlert(second.legId, tradingDate);
    const states = await store.loadAssignmentRiskAlertStates([first.legId, second.legId]);
    expect(states.get(first.legId)!.notifiedAt).toBeNull();
    expect(states.get(second.legId)!.notifiedAt).not.toBeNull();
  });
});
