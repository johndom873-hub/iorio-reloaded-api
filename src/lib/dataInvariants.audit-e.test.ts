import type { Knex } from "knex";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DataInvariantInputs } from "./dataInvariants.js";

// Audit E (2026-10-07): the new "Earnings dates" invariant (pure edges) and its loader, plus the major-macro-events
// staleness figure, against the real test database inside one transaction rolled back at the end.
const holder = vi.hoisted(() => ({ root: null as unknown as Knex, current: null as unknown as Knex, universe: [] as { tickerId: string; symbol: string; contractId: number | null }[] }));
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the audit tests.");
  const knexLibrary = (await import("knex")).default;
  holder.root = knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } });
  holder.current = holder.root;
  return {
    get db() {
      return holder.current;
    },
  };
});
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: vi.fn(async () => true) }));
vi.mock("../ibkr/runOptionChainCapture.js", () => ({ loadCaptureUniverse: async () => holder.universe }));

const { evaluateDataInvariants, loadDataInvariantInputs, earningsDatesMinGapDays, earningsDatesLookbackDays } = await import("./dataInvariants.js");

const now = new Date("2026-10-07T13:30:00Z");
const base = (earningsDatesBySymbol: Record<string, string[]>): DataInvariantInputs => ({
  now,
  universeSymbols: [],
  snapshots: [],
  dayPoolExpiryCount: 5,
  lastCompletedSession: "2026-10-06",
  latestBarDateBySymbol: {},
  riskFreeRateFetchedAt: new Date("2026-10-01T12:00:00Z"),
  marketCalendarDaysAhead: 14,
  latestTickerCalendarCapturedAt: new Date("2026-10-06T20:00:00Z"),
  latestMajorMacroEventsCapturedAt: new Date("2026-10-06T20:00:00Z"),
  earningsDatesBySymbol,
  todayEasternIso: "2026-10-07",
});
const earningsCheck = (dates: Record<string, string[]>) => evaluateDataInvariants(base(dates)).find((result) => result.name === "Earnings dates")!;

describe("Earnings dates invariant (pure)", () => {
  it("uses the approved constants", () => {
    expect(earningsDatesMinGapDays).toBe(45);
    expect(earningsDatesLookbackDays).toBe(30);
  });

  it("passes at exactly 45 days apart, fails at 44, across a DST change and a year end", () => {
    expect(earningsCheck({ AAA: ["2026-10-01", "2026-11-15"] }).ok).toBe(true); // 45 days, crosses Nov 1
    expect(earningsCheck({ AAA: ["2026-10-01", "2026-11-14"] }).ok).toBe(false);
    expect(earningsCheck({ AAA: ["2026-12-20", "2027-02-02"] }).ok).toBe(false); // 44 days
  });

  it("sorts each ticker's dates and names the first close pair of every failing ticker, ignoring pairs wholly in the past", () => {
    const result = earningsCheck({ AAA: ["2027-01-20", "2026-10-22", "2026-10-29"], BBB: ["2026-10-28"], CCC: ["2026-09-10", "2026-09-11"], DDD: ["2026-09-20", "2026-10-07"] });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("two earnings dates within 45 days: AAA (2026-10-22 and 2026-10-29), DDD (2026-09-20 and 2026-10-07)");
  });

  it("passes with no dates at all, or one date per ticker", () => {
    expect(earningsCheck({}).ok).toBe(true);
    expect(earningsCheck({ AAA: ["2026-10-22"] }).ok).toBe(true);
  });
});

describe("loadDataInvariantInputs earnings and macro figures (real DB, rolled back)", () => {
  let transaction: Knex.Transaction;
  const symbols = { inUniverse: `AUEI${Date.now() % 100_000}`, outside: `AUEO${Date.now() % 100_000}` };

  beforeAll(async () => {
    transaction = await holder.root.transaction();
    holder.current = transaction;
    const [inUniverse] = await transaction("tickers").insert({ symbol: symbols.inUniverse, company_name: "Audit E" }).returning(["id"]);
    const [outside] = await transaction("tickers").insert({ symbol: symbols.outside, company_name: "Audit E" }).returning(["id"]);
    holder.universe = [{ tickerId: inUniverse.id, symbol: symbols.inUniverse, contractId: null }];
    const row = (tickerId: string, eventDate: string) => ({ ticker_id: tickerId, event_type: "earnings", event_date: eventDate, raw: "{}" });
    await transaction("ticker_calendar_events").insert([
      row(inUniverse.id, "2026-09-05"), // 31 days before 10-06: outside the lookback
      row(inUniverse.id, "2026-09-06"), // exactly 30 days before: inside
      row(inUniverse.id, "2026-10-22"),
      row(outside.id, "2026-10-20"),
      row(outside.id, "2026-10-22"),
    ]);
    await transaction("major_macro_events").insert([
      { event_key: "audit_e_fresh", title: "audit-e fresh", event_at: new Date("2034-01-01T13:30:00Z"), source: "fred", captured_at: new Date("2026-10-06T20:00:00Z") },
      { event_key: "audit_e_stale", title: "audit-e stale", event_at: new Date("2034-01-02T13:30:00Z"), source: "fred", captured_at: new Date("2026-10-01T20:00:00Z") },
    ]);
  });
  afterAll(async () => {
    await transaction.rollback();
    holder.current = holder.root;
    await holder.root.destroy();
  });

  it("collects the universe tickers' earnings dates from 30 days before the data session on", async () => {
    const inputs = await loadDataInvariantInputs(now, "2026-10-06");
    expect(inputs.earningsDatesBySymbol[symbols.inUniverse]?.sort()).toEqual(["2026-09-06", "2026-10-22"]);
    expect(inputs.earningsDatesBySymbol[symbols.outside]).toBeUndefined();
  });

  it("reports the stalest event key's latest capture as the macro figure", async () => {
    const inputs = await loadDataInvariantInputs(now, "2026-10-06");
    expect(inputs.latestMajorMacroEventsCapturedAt?.toISOString()).toBe("2026-10-01T20:00:00.000Z");
  });
});
