import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { HeldLegScore } from "../lib/rollSignalCandidates.js";
import type { PlutoSettings } from "./settingsStore.js";

// Audit C (2026-10-07): Formula P3 (earnings buyback) and its integration in buildCloseOffersForTicker, plus the
// automaticReason labels on P1/P2. DB-backed parts run on TEST_DATABASE_URL; positions are inserted closed (the
// close-offer builder does not read the position's status), so the reconcile sweep in another file never touches them.

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the close-actions audit tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true), notifyPlutoTelegram: vi.fn(async () => true) }));
// The close gate (live quotes, cycle data) as each test sets it: passing with a profitable cycle unless a test says otherwise.
const gate = vi.hoisted(() => ({ verdict: { blocked: false, reason: null as string | null, cycleTotal: 1000 as number | null } }));
vi.mock("../lib/closeGate.js", () => ({ evaluateCloseGateForPosition: vi.fn(async () => gate.verdict) }));

// Market holidays the test controls; any other weekday is an open session.
const holidays = new Set<string>();
vi.mock("../lib/marketSessionStatus.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/marketSessionStatus.js")>();
  return {
    ...original,
    resolveIsOpenDay: vi.fn(async (dateIso: string) => {
      const weekday = new Date(`${dateIso}T12:00:00Z`).getUTCDay();
      return weekday !== 0 && weekday !== 6 && !holidays.has(dateIso);
    }),
  };
});

const { db } = await import("../db/connection.js");
const testDb: Knex = db;
const closeActions = await import("./closeActions.js");
const { countSessionsLeftBeforeEarnings, evaluateEarningsBuyback, evaluateShortLegBuyback, evaluateUnstructuredClose, loadUpcomingEarnings, buildCloseOffersForTicker, earningsBuybackWindowSessions } = closeActions;

const settings = { unstructuredCloseMinPct: 1, unstructuredCloseMinDollars: 50, buybackMinDte: 2 } as PlutoSettings;

function heldLeg(overrides: Partial<HeldLegScore> = {}): HeldLegScore {
  return {
    legId: "leg1", positionId: "pos1", strategyKey: "cash_secured_put", expiry: "2031-03-21", strike: 50, right: "P", quantity: 2, entryPrice: 2.4, entryAtIso: "2031-02-20T15:00:00Z",
    dte: 11, delta: -0.1, bid: 0.5, ask: 0.55, mid: 0.525, surfaceImpliedVolatility: 0.4, midImpliedVolatility: 0.42, edge: 0.05, frictionVolatility: 0.01, vega: 0.05,
    // Positive hold edge: P2 would never offer this leg, so any offer below is P3's.
    holdEdgeDollars: 25, closeCostDollars: 5, dollarRisk: 9948, quoteSource: "day", quotedAt: "2031-03-10T15:00:00Z", flags: [], unscoredReason: null,
    ...overrides,
  };
}

describe("Formula P3 — pure edge cases", () => {
  const earnings = { dateIso: "2031-03-13", time: "1" as string | null };
  const base = { symbol: "AUD", leg: heldLeg(), singleLegPosition: true, earnings, sessionsLeft: 3 };

  it("is automatic, labelled, priced at the rounded mid, and P&L is (entry − ask) × qty × 100", () => {
    const { offer } = evaluateEarningsBuyback(base);
    expect(offer).toMatchObject({ kind: "close_leg", automatic: true, side: "buy", multiplier: 100, quantity: 2, limitPrice: 0.53, legIds: ["leg1"], positionId: "pos1" });
    expect(offer!.automaticReason).toMatch(/Formula P3/);
    expect(offer!.cycle_pnl).toBeCloseTo((2.4 - 0.55) * 200, 9);
    expect(offer!.contract).toEqual({ strategyKey: "cash_secured_put", expiry: "2031-03-21", strike: 50, right: "P" });
  });

  it("uses the same offer id as P2 for the same leg (runChosenClose matches fresh offers by id)", () => {
    const p3 = evaluateEarningsBuyback(base).offer!;
    const p2 = evaluateShortLegBuyback({ symbol: "AUD", leg: heldLeg({ holdEdgeDollars: -25 }), rolls: [], settings, singleLegPosition: true }).offer!;
    expect(p3.id).toBe(p2.id);
  });

  it("ignores P2's hold-edge, roll and minimum-DTE conditions", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ dte: 0, holdEdgeDollars: 500 }) }).offer).not.toBeNull();
  });

  it("the window edge: exactly earningsBuybackWindowSessions sessions left is in, one more is out", () => {
    expect(earningsBuybackWindowSessions).toBe(5);
    expect(evaluateEarningsBuyback({ ...base, sessionsLeft: 5 }).offer).not.toBeNull();
    expect(evaluateEarningsBuyback({ ...base, sessionsLeft: 6 }).reason).toMatch(/last 5 sessions/);
  });

  it("never at break-even or a loss, including when the combo-split premium is lower than the recorded entry", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ bid: 2.3, ask: 2.4 }) }).reason).toMatch(/only break even, so it stays open$/);
    expect(evaluateEarningsBuyback({ ...base, orderedEntryPremium: 0.5 }).reason).toMatch(/would lose \$10, so it stays open$/);
    expect(evaluateEarningsBuyback({ ...base, orderedEntryPremium: 0.6 }).offer).not.toBeNull();
  });

  it("refuses a crossed, one-sided or zero-ask quote", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ bid: 0.6, ask: 0.55 }) }).reason).toMatch(/two-sided quote/);
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ bid: null }) }).reason).toMatch(/two-sided quote/);
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ bid: 0, ask: 0 }) }).reason).toMatch(/two-sided quote/);
    // A zero bid with a positive ask is a valid quote (a far-OTM put): mid is half the ask.
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ bid: 0, ask: 0.05 }) }).offer?.limitPrice).toBe(0.03);
  });

  it("a before-open or unknown-time report on the expiry date still spans the leg", () => {
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ expiry: "2031-03-13" }), earnings: { dateIso: "2031-03-13", time: "-1" } }).offer).not.toBeNull();
    expect(evaluateEarningsBuyback({ ...base, leg: heldLeg({ expiry: "2031-03-13" }), earnings: { dateIso: "2031-03-13", time: null } }).offer).not.toBeNull();
  });

  // An option settles at 16:00 ET on its expiry date, so a report after the close on that date comes after the leg is
  // gone; the leg never carries the event (the same distinction as expirySpansMacroEvent).
  it("an after-close report on the expiry date does not span the leg (the option has settled)", () => {
    const result = evaluateEarningsBuyback({ ...base, leg: heldLeg({ expiry: "2031-03-13" }), earnings: { dateIso: "2031-03-13", time: "1" }, sessionsLeft: 1 });
    expect(result.offer).toBeNull();
  });

  // A covered-call position whose only open leg is the call (stock leg exited) is not bought back alone by P3.
  it("a single open call leg is not bought back alone (cash-secured puts only)", () => {
    const { offer, reason } = evaluateEarningsBuyback({ ...base, leg: heldLeg({ right: "C", strategyKey: "covered_call" }) });
    expect(offer).toBeNull();
    expect(reason).toMatch(/only a cash-secured put is bought back on its own/);
  });
});

describe("countSessionsLeftBeforeEarnings — calendar edge cases", () => {
  it("a holiday on the session before a before-open report moves the last session back", () => {
    // Mon 2031-03-17 before the open; Fri 03-14 a holiday → last session Thu 03-13.
    const openDays = ["2031-03-10", "2031-03-11", "2031-03-12", "2031-03-13"];
    expect(countSessionsLeftBeforeEarnings("2031-03-10", { dateIso: "2031-03-17", time: "-1" }, openDays)).toBe(4);
  });
  it("an after-close report on a closed day counts only up to the last open day before it", () => {
    // Saturday report: the announcement day is not a session.
    expect(countSessionsLeftBeforeEarnings("2031-03-12", { dateIso: "2031-03-15", time: "1" }, ["2031-03-12", "2031-03-13", "2031-03-14"])).toBe(3);
  });
  it("is 1 on the session before a before-open report, never 0", () => {
    expect(countSessionsLeftBeforeEarnings("2031-03-12", { dateIso: "2031-03-13", time: "-1" }, ["2031-03-12", "2031-03-13"])).toBe(1);
    expect(countSessionsLeftBeforeEarnings("2031-03-13", { dateIso: "2031-03-13", time: null }, ["2031-03-13"])).toBe(1);
  });
  it("does not depend on the order of the open days", () => {
    expect(countSessionsLeftBeforeEarnings("2031-03-10", { dateIso: "2031-03-13", time: "1" }, ["2031-03-13", "2031-03-10", "2031-03-12", "2031-03-11"])).toBe(4);
  });
});

describe("automaticReason on P1 and P2", () => {
  const position = { positionId: "p", symbol: "AUD", legId: "l", shares: 300, entryPrice: 30, entryAtIso: "2031-02-01T15:00:00Z" };
  const p1 = { position, cycleTotal: 400, cycleBlockReason: null, stockBid: 31.1, stockAsk: 31.14, settings, previousSessionDateIso: "2031-03-07" };
  it("P1: only odd lots are automatic, and only they carry a reason", () => {
    expect(evaluateUnstructuredClose(p1).offer).toMatchObject({ automatic: false, automaticReason: null });
    const odd = evaluateUnstructuredClose({ ...p1, position: { ...position, shares: 99 }, cycleTotal: 60 }).offer!;
    expect(odd.automatic).toBe(true);
    expect(odd.automaticReason).toMatch(/Formula P1/);
  });
  it("P2 is never automatic", () => {
    expect(evaluateShortLegBuyback({ symbol: "AUD", leg: heldLeg({ holdEdgeDollars: -25 }), rolls: [], settings, singleLegPosition: true }).offer).toMatchObject({ automatic: false, automaticReason: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DB-backed: loadUpcomingEarnings and buildCloseOffersForTicker.

let counter = Date.now() % 100_000;
let userId: string;
const createdTickerIds: string[] = [];
const createdPositionIds: string[] = [];
const createdOrderIds: string[] = [];

async function createTicker(): Promise<{ id: string; symbol: string }> {
  const symbol = `AC${(counter += 1)}`;
  const [ticker] = await testDb("tickers").insert({ symbol, company_name: "Audit C Close Co", sector: "Technology" }).returning(["id"]);
  createdTickerIds.push(ticker.id);
  return { id: ticker.id, symbol };
}

async function addEarnings(tickerId: string, dateIso: string, time: string | null): Promise<void> {
  await testDb("ticker_calendar_events").insert({ ticker_id: tickerId, event_type: "earnings", event_date: dateIso, event_time: time, raw: JSON.stringify({ audit: "c" }) });
}

/** A position with the given legs, inserted closed so a reconcile sweep elsewhere never touches it. */
async function createPosition(tickerId: string, strategyKey: string, legs: Record<string, unknown>[]): Promise<{ positionId: string; legIds: string[] }> {
  const [position] = await testDb("positions").insert({ strategy_key: strategyKey, ticker_id: tickerId, status: "closed", closed_at: new Date() }).returning(["id"]);
  createdPositionIds.push(position.id);
  const legIds: string[] = [];
  for (const leg of legs) {
    const [row] = await testDb("position_legs").insert({ position_id: position.id, multiplier: 100, entry_at: new Date("2031-02-20T15:00:00Z"), ...leg }).returning(["id"]);
    legIds.push(row.id);
  }
  return { positionId: position.id, legIds };
}

const putLeg = (expiry: string) => ({ leg_type: "option", side: "short", quantity: 2, option_type: "put", strike_price: 50, expiry_date: expiry, entry_price: 2.4 });

beforeAll(async () => {
  const [user] = await testDb("users").insert({ username: `audit-c-close-${Date.now()}`, display_name: "Audit C close", password_hash: "x" }).returning(["id"]);
  userId = user.id;
});

afterAll(async () => {
  if (createdOrderIds.length > 0) await testDb("trades").whereIn("source_order_request_id", createdOrderIds).delete();
  if (createdPositionIds.length > 0) {
    await testDb("trades").whereIn("position_leg_id", testDb("position_legs").whereIn("position_id", createdPositionIds).select("id")).delete();
    await testDb("order_requests").whereIn("related_position_id", createdPositionIds).delete();
  }
  if (createdOrderIds.length > 0) await testDb("order_requests").whereIn("id", createdOrderIds).delete();
  if (createdPositionIds.length > 0) {
    await testDb("position_legs").whereIn("position_id", createdPositionIds).delete();
    await testDb("positions").whereIn("id", createdPositionIds).delete();
  }
  if (createdTickerIds.length > 0) {
    await testDb("ticker_calendar_events").whereIn("ticker_id", createdTickerIds).delete();
    await testDb("tickers").whereIn("id", createdTickerIds).delete();
  }
  if (userId) await testDb("users").where({ id: userId }).delete();
  await testDb.destroy();
});

beforeEach(() => {
  holidays.clear();
  gate.verdict = { blocked: false, reason: null, cycleTotal: 1000 };
});

describe("loadUpcomingEarnings (test DB)", () => {
  it("returns the nearest announcement still ahead, as YYYY-MM-DD with its time", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-03", "1"); // past
    await addEarnings(ticker.id, "2031-06-12", "-1");
    await addEarnings(ticker.id, "2031-03-20", "1");
    await testDb("ticker_calendar_events").insert({ ticker_id: ticker.id, event_type: "dividend", event_date: "2031-03-12", raw: "{}" });
    expect(await loadUpcomingEarnings(ticker.symbol, "2031-03-10")).toEqual({ dateIso: "2031-03-20", time: "1" });
  });

  it("today's before-the-open report is already out; today's after-close or unknown-time report is still ahead", async () => {
    const beforeOpen = await createTicker();
    await addEarnings(beforeOpen.id, "2031-03-10", "-1");
    expect(await loadUpcomingEarnings(beforeOpen.symbol, "2031-03-10")).toBeNull();
    await addEarnings(beforeOpen.id, "2031-06-10", "1");
    expect(await loadUpcomingEarnings(beforeOpen.symbol, "2031-03-10")).toEqual({ dateIso: "2031-06-10", time: "1" });

    const afterClose = await createTicker();
    await addEarnings(afterClose.id, "2031-03-10", "1");
    expect(await loadUpcomingEarnings(afterClose.symbol, "2031-03-10")).toEqual({ dateIso: "2031-03-10", time: "1" });

    const unknown = await createTicker();
    await addEarnings(unknown.id, "2031-03-10", null);
    expect(await loadUpcomingEarnings(unknown.symbol, "2031-03-10")).toEqual({ dateIso: "2031-03-10", time: null });
  });

  it("null for a ticker with no announcement ahead or an unknown symbol", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-03", "1");
    expect(await loadUpcomingEarnings(ticker.symbol, "2031-03-10")).toBeNull();
    expect(await loadUpcomingEarnings("NO-SUCH-AUDIT-SYMBOL", "2031-03-10")).toBeNull();
  });
});

describe("buildCloseOffersForTicker with Formula P3 (test DB)", () => {
  // Mon 2031-03-10; an after-close report Thu 2031-03-13 → sessions 10, 11, 12, 13 = 4 (in the window).
  const todayIso = "2031-03-10";
  const build = (symbol: string, heldLegs: HeldLegScore[]) => buildCloseOffersForTicker({ symbol, heldLegs, rolls: [], settings, stockBid: null, stockAsk: null, previousSessionDateIso: "2031-03-07", todayIso });

  it("a single-leg put spanning the report inside the window is bought back automatically", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const { offers, skipped } = await build(ticker.symbol, [heldLeg({ legId: legIds[0]!, positionId })]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ id: `${ticker.symbol}:close_leg:${legIds[0]}`, automatic: true, positionId, legIds: [legIds[0]] });
    expect(offers[0]!.detail).toMatchObject({ sessions_left: 4, earnings_date: "2031-03-13", earnings_time: "1" });
    expect(skipped).toEqual([]);
  });

  it("an active order on the position withholds every close on it (P3 and P2) with a reason", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "close_position", payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [] }), status: "submitted", related_position_id: positionId }).returning(["id"]);
    createdOrderIds.push(order.id);
    const leg = heldLeg({ legId: legIds[0]!, positionId });
    const withheld = await build(ticker.symbol, [leg]);
    expect(withheld.offers).toEqual([]);
    expect(withheld.skipped).toEqual([{ id: `${ticker.symbol}:close_leg:${legIds[0]}`, reason: "an order on this position is still working" }]);
    // Nor is P2 offered to the model while the order works.
    expect((await build(ticker.symbol, [{ ...leg, holdEdgeDollars: -25 }])).offers).toEqual([]);

    // Once the order is final, P3 takes over again.
    await testDb("order_requests").where({ id: order.id }).update({ status: "cancelled" });
    expect((await build(ticker.symbol, [leg])).offers[0]?.automatic).toBe(true);
  });

  it("a pending_confirmation order counts as active too", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const [order] = await testDb("order_requests").insert({ requested_by_user_id: userId, request_type: "roll_leg", payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [] }), status: "pending_confirmation", related_position_id: positionId }).returning(["id"]);
    createdOrderIds.push(order.id);
    expect((await build(ticker.symbol, [heldLeg({ legId: legIds[0]!, positionId })])).offers).toEqual([]);
  });

  it("a covered call (stock + call open) is closed whole by P3b, never the call alone", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "covered_call", [
      { leg_type: "stock", side: "long", quantity: 200, multiplier: 1, entry_price: 48 },
      { leg_type: "option", side: "short", quantity: 2, option_type: "call", strike_price: 55, expiry_date: "2031-03-21", entry_price: 2.4 },
    ]);
    const callLeg = heldLeg({ legId: legIds[1]!, positionId, right: "C", strategyKey: "covered_call", strike: 55 });
    // No stock quote: not closed, with the reason.
    const noQuote = await build(ticker.symbol, [callLeg]);
    expect(noQuote.offers).toEqual([]);
    expect(noQuote.skipped).toEqual([{ id: `${ticker.symbol}:close_position:${positionId}`, reason: expect.stringMatching(/no live two-sided quote on the call or the shares/) }]);
    // With quotes and a profitable cycle (1000 at mids; half spreads 0.025 × 200 + 0.05 × 200 = 15): one combo close.
    const { offers } = await buildCloseOffersForTicker({ symbol: ticker.symbol, heldLegs: [callLeg], rolls: [], settings, stockBid: 51.9, stockAsk: 52.0, previousSessionDateIso: "2031-03-07", todayIso });
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ kind: "close_position", automatic: true, positionId, legIds: [legIds[1], legIds[0]], side: "sell", multiplier: 1, quantity: 200, limitPrice: 51.95, legLimitPrices: { [legIds[1]!]: 0.53, [legIds[0]!]: 51.95 }, otherReferenceLegs: [{ side: "buy", price: 0.53, multiplier: 100 }] });
    expect(offers[0]!.cycle_pnl).toBeCloseTo(1000 - (0.55 - 0.525) * 200 - (51.95 - 51.9) * 200, 6);
    expect(offers[0]!.automaticReason).toMatch(/Formula P3b/);
    // Not in profit after half the spreads: stays open.
    gate.verdict = { blocked: false, reason: null, cycleTotal: 10 };
    const unprofitable = await buildCloseOffersForTicker({ symbol: ticker.symbol, heldLegs: [callLeg], rolls: [], settings, stockBid: 51.9, stockAsk: 52.0, previousSessionDateIso: "2031-03-07", todayIso });
    expect(unprofitable.offers).toEqual([]);
    expect(unprofitable.skipped[0]!.reason).toMatch(/would lose \$5 after half the spreads, so it stays open/);
  });

  it("P3 needs the close gate to pass, and is not retried within an hour of an automatic attempt that did not fill", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const leg = heldLeg({ legId: legIds[0]!, positionId });
    gate.verdict = { blocked: true, reason: "Live bid/ask is unavailable for the put.", cycleTotal: null };
    const blocked = await build(ticker.symbol, [leg]);
    expect(blocked.offers).toEqual([]);
    expect(blocked.skipped.find((entry) => entry.id.includes(":earnings_close:"))?.reason).toBe("Live bid/ask is unavailable for the put.");
    gate.verdict = { blocked: false, reason: null, cycleTotal: 1000 };
    const [pass] = await testDb("pluto_passes").insert({ trigger: "manual", trigger_detail: "{}" }).returning(["id"]);
    await testDb("pluto_actions").insert({ pass_id: pass.id, kind: "close_leg", symbol: ticker.symbol, contract: JSON.stringify({ positionId, legIds }), gate_results: JSON.stringify([{ gate: "automatic_close", ok: true, detail: "P3" }]), outcome: "cancelled" });
    try {
      const retried = await build(ticker.symbol, [leg]);
      expect(retried.offers.filter((offer) => offer.automatic)).toEqual([]);
      expect(retried.skipped.find((entry) => entry.id.includes(":earnings_close:"))?.reason).toMatch(/did not fill within the last hour/);
    } finally {
      await testDb("pluto_actions").where({ pass_id: pass.id }).delete();
      await testDb("pluto_passes").where({ id: pass.id }).delete();
    }
  });

  it("an exited carved slice does not make a put multi-leg", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [
      { ...putLeg("2031-03-21"), quantity: 1, exit_price: 0.8, exit_at: new Date("2031-03-03T15:00:00Z") },
      putLeg("2031-03-21"),
    ]);
    const { offers } = await build(ticker.symbol, [heldLeg({ legId: legIds[1]!, positionId })]);
    expect(offers.map((offer) => offer.automatic)).toEqual([true]);
  });

  it("a leg that expires before the report gets no P3 entry at all", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-12")]);
    const { offers, skipped } = await build(ticker.symbol, [heldLeg({ legId: legIds[0]!, positionId, expiry: "2031-03-12" })]);
    expect(offers).toEqual([]);
    expect(skipped.some((entry) => entry.id.includes(":earnings_close:"))).toBe(false);
  });

  it("today's before-open report is out: no P3", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, todayIso, "-1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const { offers, skipped } = await build(ticker.symbol, [heldLeg({ legId: legIds[0]!, positionId })]);
    expect(offers).toEqual([]);
    expect(skipped.some((entry) => entry.id.includes(":earnings_close:"))).toBe(false);
  });

  it("an announcement beyond the window is skipped with the window reason (far off, and just outside)", async () => {
    const far = await createTicker();
    await addEarnings(far.id, "2031-04-03", "1");
    const farPosition = await createPosition(far.id, "cash_secured_put", [putLeg("2031-04-17")]);
    const farResult = await build(far.symbol, [heldLeg({ legId: farPosition.legIds[0]!, positionId: farPosition.positionId, expiry: "2031-04-17" })]);
    expect(farResult.offers).toEqual([]);
    expect(farResult.skipped.find((entry) => entry.id.includes(":earnings_close:"))?.reason).toMatch(/last 5 sessions/);

    // Tue 2031-03-18 before the open: sessions 10–14 and 17 = 6, one too many.
    const near = await createTicker();
    await addEarnings(near.id, "2031-03-18", "-1");
    const nearPosition = await createPosition(near.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const nearLeg = heldLeg({ legId: nearPosition.legIds[0]!, positionId: nearPosition.positionId });
    expect((await build(near.symbol, [nearLeg])).offers).toEqual([]);
    // A holiday on Wed 2031-03-12 brings it to 5: inside.
    holidays.add("2031-03-12");
    const withHoliday = await build(near.symbol, [nearLeg]);
    expect(withHoliday.offers).toHaveLength(1);
    expect(withHoliday.offers[0]!.detail.sessions_left).toBe(5);
  });

  it("uses the combo-split premium: a leg whose ordered price is below the ask is not bought back at a loss", async () => {
    const ticker = await createTicker();
    await addEarnings(ticker.id, "2031-03-13", "1");
    const { positionId, legIds } = await createPosition(ticker.id, "cash_secured_put", [putLeg("2031-03-21")]);
    const [order] = await testDb("order_requests")
      .insert({
        requested_by_user_id: userId,
        request_type: "roll_leg",
        payload: JSON.stringify({ symbol: ticker.symbol, strategyKey: "cash_secured_put", legs: [{ role: "option", action: "BUY", strike: 45, expiry: "20310314", right: "P", unitPrice: 1 }, { role: "option", action: "SELL", strike: 50, expiry: "20310321", right: "P", unitPrice: 0.5 }] }),
        status: "filled",
      })
      .returning(["id"]);
    createdOrderIds.push(order.id);
    await testDb("trades").insert({ position_leg_id: legIds[0], ibkr_exec_id: `audit-c-${legIds[0]}`, side: "sell", quantity: 2, price: 2.4, executed_at: new Date("2031-02-20T15:00:00Z"), is_closing_trade: false, source_order_request_id: order.id });
    const { offers, skipped } = await build(ticker.symbol, [heldLeg({ legId: legIds[0]!, positionId })]);
    expect(offers).toEqual([]);
    expect(skipped.find((entry) => entry.id.includes(":earnings_close:"))?.reason).toMatch(/would lose \$10/);
  });
});
