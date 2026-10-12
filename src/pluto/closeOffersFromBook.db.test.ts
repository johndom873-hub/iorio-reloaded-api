import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { flatCommissionEstimator } from "../lib/commissionEstimate.js";
import type { HeldLegScore } from "../lib/rollSignalCandidates.js";
import { fixtureHeldLegModel } from "../lib/testSupport/valuationModelFixtures.js";
import type { CloseOffersBook, CloseOffersForTickerInput } from "./closeActions.js";
import type { PlutoSettings } from "./settingsStore.js";

// The close offers' database loader and their book-fed builder, on the same rows: loadCloseOffersBook reads from seeded
// tables the book written out here by hand, and buildCloseOffersFromBook on that hand-written book gives what
// buildCloseOffersForTicker gives from the database. Runs in a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
// The close gate passes with a cycle P&L of 1,000 for every position.
const gateVerdict = { blocked: false, reason: null, cycleTotal: 1000 };
vi.mock("../lib/closeGate.js", () => ({ evaluateCloseGateForPosition: vi.fn(async () => gateVerdict), closeGateVerdictFromQuotes: vi.fn(async () => gateVerdict) }));
// Every weekday is an open session.
vi.mock("../lib/marketSessionStatus.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/marketSessionStatus.js")>();
  return { ...original, resolveIsOpenDay: vi.fn(async (dateIso: string) => ![0, 6].includes(new Date(`${dateIso}T12:00:00Z`).getUTCDay())) };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { buildCloseOffersForTicker, buildCloseOffersFromBook, loadCloseOffersBook } = await import("./closeActions.js");
const testDb: Knex = db;

// Monday 10 March 2031; PAR reports after the close on Thursday 13 March, so sessions 10, 11, 12 and 13 are left: 4.
// The book: 150 uncovered shares; a covered call (200 shares, 2 calls $55); a put sold in a two-leg order whose own leg
// price was 2.50 against IBKR's 2.45 for the leg (recorded entry 2.40, so its premium reads 2.45); a put with an order
// still working; a put whose automatic buyback did not fill within the last hour. A second ticker's shares must stay out.
const todayIso = "2031-03-10";
const entryAt = new Date("2031-02-20T15:00:00Z");
const tickerId: string = randomUUID();
const otherTickerId: string = randomUUID();
const userId: string = randomUUID();
const positionIds: Record<"shares" | "coveredCall" | "comboPut" | "workingPut" | "retriedPut" | "otherShares", string> = { shares: randomUUID(), coveredCall: randomUUID(), comboPut: randomUUID(), workingPut: randomUUID(), retriedPut: randomUUID(), otherShares: randomUUID() };
const legIds: Record<"shares" | "coveredShares" | "call" | "comboPut" | "comboPutClosedSlice" | "workingPut" | "retriedPut" | "otherShares", string> = { shares: randomUUID(), coveredShares: randomUUID(), call: randomUUID(), comboPut: randomUUID(), comboPutClosedSlice: randomUUID(), workingPut: randomUUID(), retriedPut: randomUUID(), otherShares: randomUUID() };
const settings = { unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2 } as PlutoSettings;

function heldLeg(overrides: Partial<HeldLegScore>): HeldLegScore {
  return {
    legId: "leg", positionId: "position", strategyKey: "cash_secured_put", expiry: "2031-03-21", strike: 50, right: "P", quantity: 2, entryPrice: 2.4, entryAtIso: entryAt.toISOString(),
    dte: 11, delta: -0.1, bid: 0.5, ask: 0.55, mid: 0.525, surfaceImpliedVolatility: 0.4, midImpliedVolatility: 0.42, edge: 0.05, frictionVolatility: 0.01, vega: 0.05,
    holdEdgeDollars: 25, closeCostDollars: 5, dollarRisk: 9948, quoteSource: "day", quotedAt: "2031-03-10T15:00:00Z", flags: [], unscoredReason: null,
    model: fixtureHeldLegModel(25, 5),
    ...overrides,
  };
}
const heldLegs: HeldLegScore[] = [
  heldLeg({ legId: legIds.call, positionId: positionIds.coveredCall, right: "C", strategyKey: "covered_call", strike: 55 }),
  heldLeg({ legId: legIds.comboPut, positionId: positionIds.comboPut }),
  heldLeg({ legId: legIds.workingPut, positionId: positionIds.workingPut, strike: 45, quantity: 1 }),
  heldLeg({ legId: legIds.retriedPut, positionId: positionIds.retriedPut, strike: 40, quantity: 1 }),
];
const input: CloseOffersForTickerInput = { symbol: "PAR", heldLegs, rolls: [], settings, stockBid: 51.9, stockAsk: 52, previousSessionDateIso: "2031-03-07", todayIso, spotPrice: 51.95, forecastVolatility: 0.4, macroEvents: [], nowMs: Date.parse("2031-03-10T15:00:00Z"), openDaysIso: [], commissionEstimator: flatCommissionEstimator };

const handWrittenBook: CloseOffersBook = {
  sharePositions: [{ positionId: positionIds.shares, symbol: "PAR", legId: legIds.shares, shares: 150, entryPrice: 48, entryAtIso: entryAt.toISOString() }],
  openLegsByPositionId: new Map([
    [positionIds.coveredCall, [{ id: legIds.coveredShares, legType: "stock", side: "long", quantity: 200 }, { id: legIds.call, legType: "option", side: "short", quantity: 2 }]],
    [positionIds.comboPut, [{ id: legIds.comboPut, legType: "option", side: "short", quantity: 2 }]],
    [positionIds.workingPut, [{ id: legIds.workingPut, legType: "option", side: "short", quantity: 1 }]],
    [positionIds.retriedPut, [{ id: legIds.retriedPut, legType: "option", side: "short", quantity: 1 }]],
  ]),
  recentUnfilledAutomaticAttemptPositionIds: new Set([positionIds.retriedPut]),
  activeOrderPositionIds: new Set([positionIds.workingPut]),
  openingTradesByLegId: new Map([
    [legIds.comboPut, [{ quantity: 2, price: 2.45, orderedLegPrice: 2.5 }]],
    [legIds.workingPut, [{ quantity: 1, price: 1.1, orderedLegPrice: null }]],
  ]),
  earnings: { dateIso: "2031-03-13", time: "1" },
  sessionsLeftBeforeEarnings: 4,
  heldShareCallPositionIds: new Set(),
};

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "close-offers-parity", display_name: "Close offers parity", password_hash: "x" });
  await testDb("tickers").insert([
    { id: tickerId, symbol: "PAR", company_name: "Parity Co", sector: "Technology" },
    { id: otherTickerId, symbol: "OTH", company_name: "Other Co", sector: "Technology" },
  ]);
  await testDb("ticker_calendar_events").insert([
    { ticker_id: tickerId, event_type: "earnings", event_date: "2031-03-13", event_time: "1", raw: "{}" },
    { ticker_id: tickerId, event_type: "earnings", event_date: "2031-06-12", event_time: "-1", raw: "{}" },
  ]);
  const position = (id: string, strategyKey: string, ticker = tickerId) => ({ id, strategy_key: strategyKey, ticker_id: ticker, status: "open", opened_at: entryAt });
  await testDb("positions").insert([position(positionIds.shares, "unstructured"), position(positionIds.coveredCall, "covered_call"), position(positionIds.comboPut, "cash_secured_put"), position(positionIds.workingPut, "cash_secured_put"), position(positionIds.retriedPut, "cash_secured_put"), position(positionIds.otherShares, "unstructured", otherTickerId)]);
  const stockLeg = (id: string, positionId: string, quantity: number) => ({ id, position_id: positionId, leg_type: "stock", side: "long", quantity, multiplier: 1, entry_price: 48, entry_at: entryAt });
  const optionLeg = (id: string, positionId: string, optionType: string, strike: number, quantity: number, exit: { price: number; at: Date } | null = null) => ({ id, position_id: positionId, leg_type: "option", side: "short", quantity, option_type: optionType, strike_price: strike, expiry_date: "2031-03-21", multiplier: 100, entry_price: 2.4, entry_at: entryAt, exit_price: exit?.price ?? null, exit_at: exit?.at ?? null });
  await testDb("position_legs").insert([
    stockLeg(legIds.shares, positionIds.shares, 150),
    stockLeg(legIds.coveredShares, positionIds.coveredCall, 200),
    optionLeg(legIds.call, positionIds.coveredCall, "call", 55, 2),
    optionLeg(legIds.comboPut, positionIds.comboPut, "put", 50, 2),
    optionLeg(legIds.comboPutClosedSlice, positionIds.comboPut, "put", 50, 1, { price: 1, at: new Date("2031-03-03T15:00:00Z") }),
    optionLeg(legIds.workingPut, positionIds.workingPut, "put", 45, 1),
    optionLeg(legIds.retriedPut, positionIds.retriedPut, "put", 40, 1),
    stockLeg(legIds.otherShares, positionIds.otherShares, 300),
  ]);
  const order = (requestType: string, legs: unknown[], status: string, relatedPositionId: string | null) => ({ requested_by_user_id: userId, request_type: requestType, payload: JSON.stringify({ symbol: "PAR", strategyKey: "cash_secured_put", legs }), status, related_position_id: relatedPositionId });
  const [comboOrder] = await testDb("order_requests")
    .insert(order("roll_leg", [{ role: "option", action: "BUY", strike: 52, expiry: "20310314", right: "P", unitPrice: 1.2 }, { role: "option", action: "SELL", strike: 50, expiry: "20310321", right: "P", unitPrice: 2.5 }], "filled", null))
    .returning(["id"]);
  const [singleOrder] = await testDb("order_requests").insert(order("open_cash_secured_put", [{ role: "option", action: "SELL", strike: 45, expiry: "20310321", right: "P", unitPrice: 1.1 }], "filled", null)).returning(["id"]);
  await testDb("order_requests").insert(order("close_position", [], "submitted", positionIds.workingPut));
  const trade = (legId: string, side: string, quantity: number, price: number, isClosingTrade: boolean, orderId: string | null) => ({ position_leg_id: legId, side, quantity, price, commission: 0.68, executed_at: entryAt, is_closing_trade: isClosingTrade, source_order_request_id: orderId });
  await testDb("trades").insert([
    trade(legIds.comboPut, "sell", 2, 2.45, false, comboOrder.id),
    trade(legIds.comboPutClosedSlice, "buy", 1, 1, true, null),
    trade(legIds.workingPut, "sell", 1, 1.1, false, singleOrder.id),
  ]);
  const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}" }).returning(["id"]);
  const automaticAttempt = (positionId: string, legId: string, outcome: string) => ({ pass_id: pass.id, kind: "close_leg", symbol: "PAR", contract: JSON.stringify({ positionId, legIds: [legId] }), gate_results: JSON.stringify([{ gate: "automatic_close", ok: true, detail: "P3" }]), outcome });
  await testDb("pluto_actions").insert([automaticAttempt(positionIds.retriedPut, legIds.retriedPut, "cancelled"), automaticAttempt(positionIds.comboPut, legIds.comboPut, "filled")]);
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

const sortedBook = (book: CloseOffersBook) => ({
  ...book,
  openLegsByPositionId: new Map([...book.openLegsByPositionId].sort(([a], [b]) => a.localeCompare(b)).map(([positionId, legs]) => [positionId, [...legs].sort((a, b) => a.id.localeCompare(b.id))])),
  openingTradesByLegId: new Map([...book.openingTradesByLegId].sort(([a], [b]) => a.localeCompare(b))),
});

describe("the close offers' loader and builder", () => {
  it("loads the book the offers are built from", async () => {
    expect(sortedBook(await loadCloseOffersBook(input))).toEqual(sortedBook(handWrittenBook));
  });

  it("reads only the share positions when no short leg is held", async () => {
    expect(await loadCloseOffersBook({ ...input, heldLegs: [] })).toEqual({ ...handWrittenBook, openLegsByPositionId: new Map(), recentUnfilledAutomaticAttemptPositionIds: new Set(), activeOrderPositionIds: new Set(), openingTradesByLegId: new Map(), earnings: null, sessionsLeftBeforeEarnings: null });
  });

  it("builds from the hand-written book what buildCloseOffersForTicker builds from the database", async () => {
    const fromDatabase = await buildCloseOffersForTicker(input);
    const fromBook = await buildCloseOffersFromBook(input, handWrittenBook, { forPosition: () => gateVerdict, fromQuotes: () => gateVerdict });
    expect(fromBook).toEqual(fromDatabase);

    // 150 shares at 48 with the cycle up 1,000 against a floor of max(1% × 7,200, 50): offered to the model, not an odd lot.
    // The covered call closes whole before the report (P3b); the two-leg put is bought back at a profit on its own 2.45
    // premium, (2.45 − 0.55) × 2 × 100 = 380 (P3). Nothing on the put with a working order, nor on the one retried too soon.
    expect(fromDatabase.offers.map((offer) => [offer.kind, offer.positionId, offer.automatic])).toEqual([
      ["close_shares", positionIds.shares, false],
      ["close_position", positionIds.coveredCall, true],
      ["close_leg", positionIds.comboPut, true],
    ]);
    expect(fromDatabase.offers[2]!.cycle_pnl).toBeCloseTo(380, 6);
    expect(fromDatabase.offers[2]!.detail).toMatchObject({ recorded_entry_credit: 2.4, sessions_left: 4 });
    expect(fromDatabase.offers[2]!.detail.entry_credit).toBeCloseTo(2.45, 10);
    expect(fromDatabase.skipped).toContainEqual({ id: `PAR:close_leg:${legIds.workingPut}`, reason: "an order on this position is still working" });
    expect(fromDatabase.skipped).toContainEqual({ id: `PAR:earnings_close:${legIds.retriedPut}`, reason: "an automatic buyback of this leg did not fill within the last hour" });
    expect(fromDatabase.heldPositions.map((entry) => entry.legId)).toEqual(heldLegs.map((leg) => leg.legId));
  });

  it("leaves a covered call written on shares already held through earnings (no P3b close); the rest is unchanged", async () => {
    await testDb("position_share_sources").insert({ position_id: positionIds.coveredCall, source_position_id: positionIds.otherShares });
    try {
      const book = await loadCloseOffersBook(input);
      expect(book.heldShareCallPositionIds).toEqual(new Set([positionIds.coveredCall]));
      const built = await buildCloseOffersForTicker(input);
      expect(built.offers.map((offer) => [offer.kind, offer.positionId])).toEqual([
        ["close_shares", positionIds.shares],
        ["close_leg", positionIds.comboPut],
      ]);
      expect(built.skipped).toContainEqual({ id: `PAR:close_position:${positionIds.coveredCall}`, reason: "a call written on shares already held rides through earnings: no automatic close before the report" });
    } finally {
      await testDb("position_share_sources").where({ position_id: positionIds.coveredCall }).delete();
    }
  });
});
