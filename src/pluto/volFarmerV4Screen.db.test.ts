import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { newVolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import type { VolFarmerV4PendingOrder } from "./volFarmerV4LiveBook.js";

// The Pluto screen's Vol Farmer v2 card against a private copy of the test tables: an adopted ticker's two positions (a
// Call leg of the book, a Put still working), its LEAPS held short of its count and its last round; a ticker waiting to
// be adopted (a last round, no memory); a ticker not enabled in Pluto left out.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { loadVolFarmerV4LeapsLook, saveVolFarmerV4LastRound, saveVolFarmerV4Memory } = await import("./volFarmerV4LookLoader.js");
const { loadVolFarmerV4Screen } = await import("./volFarmerV4Screen.js");
const testDb: Knex = db;

const userId = randomUUID();
const adoptedId = randomUUID();
const waitingId = randomUUID();
const disabledId = randomUUID();

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "vf2-screen", display_name: "VF2 Screen", password_hash: "x" });
  await testDb("tickers").insert([
    { id: adoptedId, symbol: "VFA", company_name: "Adopted Co" },
    { id: waitingId, symbol: "VFW", company_name: "Waiting Co" },
    { id: disabledId, symbol: "VFD", company_name: "Disabled Co" },
  ]);
  await testDb("pluto_settings").insert({ id: 1 }).onConflict("id").ignore();
  await testDb("pluto_state").insert({ id: 1 }).onConflict("id").ignore();
  await testDb("shortlist_entries").insert([adoptedId, waitingId, disabledId].map((ticker_id) => ({ ticker_id, added_by_user_id: userId, bot_enabled: ticker_id !== disabledId })));
});

afterAll(async () => {
  await dropIsolatedTestDatabase(testDb);
});

describe("the Vol Farmer v2 card", () => {
  it("shows each v2 ticker's positions, LEAPS, working orders and last round; a ticker v2 waits on has no positions", async () => {
    const [position] = await testDb("positions").insert({ ticker_id: adoptedId, strategy_key: "covered_call", status: "open" }).returning("id");
    const legOf = async (fields: Record<string, unknown>) => {
      const [row] = await testDb("position_legs").insert({ position_id: position.id, leg_type: "option", side: "short", quantity: 4, option_type: "call", strike_price: 114, expiry_date: "2026-10-30", multiplier: 100, entry_price: 1.2, entry_at: new Date("2026-10-26T14:00:00Z"), ...fields }).returning("id");
      return row.id as string;
    };
    const callLeg = await legOf({});
    const leapsLeg = await legOf({ side: "long", quantity: 3, strike_price: 90, expiry_date: "2027-12-17" });
    const state = newVolFarmerV4SymbolState();
    state.potDollars = 64_007;
    state.first = { shares: 500, costPerShare: 110, premiums: [{ legId: callLeg, dollars: 1_000, shares: 500 }], calls: [{ legId: callLeg, shares: 400 }], puts: [] };
    state.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "action:a7", dollars: 150, shares: 200 }], calls: [], puts: [{ legId: "action:a7", shares: 200 }] };
    state.leaps = { legIds: [leapsLeg, "action:a8"], expiry: "2027-12-17", strike: 90, intendedContracts: 5 };
    const put: VolFarmerV4PendingOrder = { ref: "action:a7", actionId: "a7", kind: "cash_secured_put", expiry: "2026-11-06", strike: 95, contracts: 2, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 150 }, leapsBeforeSale: null };
    await saveVolFarmerV4Memory(adoptedId, { state, pending: [put] }, true);
    const figures = { potDollars: 64_007, committedDollars: 40_000, freeCashDollars: 5_000, leapsCapDollars: 6_401 };
    const at = new Date("2026-10-28T14:30:00Z");
    await saveVolFarmerV4LastRound(adoptedId, { at, notes: ["first position: no Call at or above its break-even 108.00"], figures });
    await saveVolFarmerV4LastRound(waitingId, { at, notes: ["holds no shares yet: its open Puts are left to expire or be assigned before v4 adopts it"], figures: null });

    const tickers = await loadVolFarmerV4Screen();
    expect(tickers.map((ticker) => ticker.symbol)).toEqual(["VFA", "VFW"]);
    const [adopted, waiting] = tickers;
    expect(adopted).toMatchObject({
      waiting: false,
      first: { shares: 500, costPerShare: 110, breakEvenPerShare: 108, calls: [{ strike: 114, expiry: "2026-10-30", contracts: 4, working: false }], puts: [] },
      second: { shares: 0, breakEvenPerShare: null, calls: [], puts: [{ strike: 95, expiry: "2026-11-06", contracts: 2, working: true }] },
      // The top-up still working holds no contract yet.
      leaps: { strike: 90, expiry: "2027-12-17", heldContracts: 3, intendedContracts: 5 },
      workingOrders: [{ kind: "cash_secured_put", strike: 95, expiry: "2026-11-06", contracts: 2, shares: null }],
      lastRoundAt: at.toISOString(),
      lastRoundNotes: ["first position: no Call at or above its break-even 108.00"],
      lastRoundFigures: figures,
    });
    expect(adopted!.adoptedAt).not.toBeNull();
    // The Next action column is built from real inputs (not the "unavailable" stand-in), with its six actions and no order sent yet.
    expect(adopted!.nextAction.text).not.toBe("Next action unavailable");
    expect(adopted!.actions.map((action) => action.key)).toEqual(["sell_calls", "sell_puts", "buy_leaps", "buy_shares", "sell_shares", "buy_back_call"]);
    expect(adopted).toMatchObject({ lastOrder: null, cancelledToday: 0 });
    expect(waiting).toMatchObject({ waiting: true, adoptedAt: null, first: null, second: null, leaps: null, workingOrders: [], lastRoundFigures: null });

    // A memory saved after a last round keeps the round's notes, and a later round keeps the memory.
    await saveVolFarmerV4Memory(adoptedId, { state, pending: [] }, false);
    await saveVolFarmerV4LastRound(adoptedId, { at, notes: [], figures });
    const [again] = await loadVolFarmerV4Screen();
    expect(again).toMatchObject({ workingOrders: [], lastRoundNotes: [], first: { shares: 500 } });

    // The LEAPS look a round saved with its figures is read back for the day's next round, and is gone once a round saves none.
    const leapsLook = { tradingDate: "2026-10-28", quotedAt: at.toISOString(), expiry: "2027-12-17", contract: { strike: 90, bid: 13.9, ask: 14.5 }, reason: null };
    await saveVolFarmerV4LastRound(adoptedId, { at, notes: [], figures: { ...figures, leapsLook } });
    expect(await loadVolFarmerV4LeapsLook(adoptedId)).toEqual(leapsLook);
    expect((await loadVolFarmerV4Screen())[0]!.lastRoundFigures).toMatchObject({ leapsLook });
    await saveVolFarmerV4LastRound(adoptedId, { at, notes: [], figures });
    expect(await loadVolFarmerV4LeapsLook(adoptedId)).toBeNull();
    expect(await loadVolFarmerV4LeapsLook(waitingId)).toBeNull();
  });

  it("takes the pot-based figures at the ticker's pot now: raising its allocation clears a warning raised at the old pot", async () => {
    const figures = { potDollars: 56_957, committedDollars: 53_754, freeCashDollars: 5_000, leapsCapDollars: 5_696, putsDollars: 11_391 };
    await saveVolFarmerV4LastRound(adoptedId, { at: new Date("2026-10-28T14:30:00Z"), notes: [], figures });
    const [before] = await loadVolFarmerV4Screen();
    // The books not started: no Pluto book value, so the round's own pot stays.
    expect(before!.lastRoundFigures).toEqual(figures);
    // Pluto's book worth $500,000 now (its live value, not last night's snapshot) and a 20% allowance: a 10% allocation
    // is a pot of 10% × 1.2 × $500,000 = $60,000.
    const cutOverAt = new Date("2026-10-27T04:00:00Z");
    await testDb("books_cutover").insert({ id: true, cut_over_at: cutOverAt, statement_to_date: null, ibkr_cash: 500_000, pluto_starting_value: 500_000, pluto_positions_value: 0, statement_row_keys: JSON.stringify([]) });
    await testDb("book_cash_entries").insert({ book_key: "pluto", amount: 500_000, effective_at: cutOverAt, kind: "opening_balance", group_id: crypto.randomUUID(), description: "Opening cash" });
    if (!(await testDb("trading_settings").first("id"))) await testDb("trading_settings").insert({ max_order_pct_of_portfolio: 25, max_concentration_per_ticker_pct: 40, min_cash_reserve_pct: 5, delta_target_min: 0.1, delta_target_max: 0.5, recovery_dte_min: 1, recovery_dte_max: 14, commission_warn_share_of_premium_pct: 5 });
    await testDb("pluto_settings").where({ id: 1 }).update({ excess_allowance_pct: 20 });
    await testDb("pluto_ticker_settings").insert({ ticker_id: adoptedId, allocation_pct: 10 }).onConflict("ticker_id").merge();
    const firstPositionPct = Number((await testDb("pluto_settings").where({ id: 1 }).first("vol_farmer_v4_first_position_pct")).vol_farmer_v4_first_position_pct);
    const [after] = await loadVolFarmerV4Screen();
    expect(after!.lastRoundFigures).toMatchObject({ potDollars: 60_000, putsDollars: (60_000 * (100 - firstPositionPct)) / 100, committedDollars: 53_754, freeCashDollars: 5_000 });
  });
});
