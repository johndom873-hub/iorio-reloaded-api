import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { newVolFarmerV2SymbolState } from "../backtest/engine/volFarmerV2Steps.js";
import type { VolFarmerV2PendingOrder } from "./volFarmerV2LiveBook.js";

// The Pluto screen's Vol Farmer v2 card against a private copy of the test tables: an adopted ticker's two positions (a
// Call leg of the book, a Put still working), its LEAPS held short of its count and its last round; a ticker waiting to
// be adopted (a last round, no memory); a ticker on the ladder left out.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { saveVolFarmerV2LastRound, saveVolFarmerV2Memory } = await import("./volFarmerV2LookLoader.js");
const { loadVolFarmerV2Screen } = await import("./volFarmerV2Screen.js");
const testDb: Knex = db;

const userId = randomUUID();
const adoptedId = randomUUID();
const waitingId = randomUUID();
const ladderId = randomUUID();

beforeAll(async () => {
  await testDb("users").insert({ id: userId, username: "vf2-screen", display_name: "VF2 Screen", password_hash: "x" });
  await testDb("tickers").insert([
    { id: adoptedId, symbol: "VFA", company_name: "Adopted Co" },
    { id: waitingId, symbol: "VFW", company_name: "Waiting Co" },
    { id: ladderId, symbol: "VFL", company_name: "Ladder Co" },
  ]);
  await testDb("shortlist_entries").insert([adoptedId, waitingId, ladderId].map((ticker_id) => ({ ticker_id, added_by_user_id: userId, bot_enabled: true })));
  await testDb("pluto_ticker_settings").insert({ ticker_id: ladderId, strategy: "cc_put_ladder" });
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
    const state = newVolFarmerV2SymbolState();
    state.potDollars = 64_007;
    state.first = { shares: 500, costPerShare: 110, premiums: [{ legId: callLeg, dollars: 1_000, shares: 500 }], calls: [{ legId: callLeg, shares: 400 }], puts: [] };
    state.second = { shares: 0, costPerShare: 0, premiums: [{ legId: "action:a7", dollars: 150, shares: 200 }], calls: [], puts: [{ legId: "action:a7", shares: 200 }] };
    state.leaps = { legIds: [leapsLeg, "action:a8"], expiry: "2027-12-17", strike: 90, intendedContracts: 5 };
    const put: VolFarmerV2PendingOrder = { ref: "action:a7", actionId: "a7", kind: "cash_secured_put", expiry: "2026-11-06", strike: 95, contracts: 2, startsCycle: false, contractsByPosition: { first: 0, second: 0 }, plannedPremiumByPosition: { first: 0, second: 150 }, leapsBeforeSale: null };
    await saveVolFarmerV2Memory(adoptedId, { state, pending: [put] }, true);
    const figures = { potDollars: 64_007, committedDollars: 40_000, freeCashDollars: 5_000, leapsCapDollars: 6_401 };
    const at = new Date("2026-10-28T14:30:00Z");
    await saveVolFarmerV2LastRound(adoptedId, { at, notes: ["first position: no Call at or above its break-even 108.00"], figures });
    await saveVolFarmerV2LastRound(waitingId, { at, notes: ["holds no shares yet: its open Puts are left to expire or be assigned before v2 adopts it"], figures: null });

    const tickers = await loadVolFarmerV2Screen();
    expect(tickers.map((ticker) => ticker.symbol)).toEqual(["VFA", "VFW"]);
    const [adopted, waiting] = tickers;
    expect(adopted).toMatchObject({
      waiting: false,
      first: { shares: 500, costPerShare: 110, breakEvenPerShare: 108, calls: [{ strike: 114, expiry: "2026-10-30", contracts: 4, working: false }], puts: [] },
      second: { shares: 0, breakEvenPerShare: null, calls: [], puts: [{ strike: 95, expiry: "2026-11-06", contracts: 2, working: true }] },
      // The top-up still working holds no contract yet.
      leaps: { strike: 90, expiry: "2027-12-17", heldContracts: 3, intendedContracts: 5 },
      workingOrders: [{ kind: "cash_secured_put", strike: 95, expiry: "2026-11-06", contracts: 2 }],
      lastRoundAt: at.toISOString(),
      lastRoundNotes: ["first position: no Call at or above its break-even 108.00"],
      lastRoundFigures: figures,
    });
    expect(adopted!.adoptedAt).not.toBeNull();
    expect(waiting).toMatchObject({ waiting: true, adoptedAt: null, first: null, second: null, leaps: null, workingOrders: [], lastRoundFigures: null });

    // A memory saved after a last round keeps the round's notes, and a later round keeps the memory.
    await saveVolFarmerV2Memory(adoptedId, { state, pending: [] }, false);
    await saveVolFarmerV2LastRound(adoptedId, { at, notes: [], figures });
    const [again] = await loadVolFarmerV2Screen();
    expect(again).toMatchObject({ workingOrders: [], lastRoundNotes: [], first: { shares: 500 } });
  });
});
