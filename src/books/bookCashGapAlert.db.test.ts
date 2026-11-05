import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// The books' cash-gap alert (Marcelo 2026-11-05: above $500 for 30 minutes, hourly reminders, prod only) and the start's
// baseline night, against a private copy of the test tables.
vi.mock("../db/connection.js", async () => {
  const { createIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
  return { db: await createIsolatedTestDatabase() };
});
const environment = vi.hoisted(() => ({ name: "production" }));
vi.mock("../lib/appEnvironment.js", async (importOriginal) => ({ ...(await importOriginal<object>()), readAppEnvironment: () => environment.name }));
const telegram = vi.hoisted(() => ({ sent: [] as string[] }));
vi.mock("../lib/notifyTelegram.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyTelegram: async (message: string) => {
    telegram.sent.push(message);
    return true;
  },
}));
const live = vi.hoisted(() => ({ gap: 0 as number | null }));
vi.mock("./bookFigures.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadBooksLiveState: async () => ({ ready: true, cashGapAgainstIbkr: live.gap }) }));

const { db } = await import("../db/connection.js");
const { dropIsolatedTestDatabase } = await import("../lib/testSupport/isolatedTestSchema.js");
const { bookCashGapClearedMessage, bookCashGapMessage, checkBooksCashGap } = await import("./bookCashGapAlert.js");
const { applyBooksCutover } = await import("./cutover.js");
const { writeBookValueSnapshots } = await import("./bookSnapshots.js");

const start = new Date("2026-11-05T15:00:00Z");
const minutesLater = (minutes: number) => new Date(start.getTime() + minutes * 60_000);

beforeEach(async () => {
  telegram.sent.length = 0;
  environment.name = "production";
  live.gap = 0;
  await db("alert_state").whereIn("alert_key", ["books_cash_gap", "books_cash_gap_over_since"]).del();
});
afterAll(async () => {
  await dropIsolatedTestDatabase(db);
});

describe("the books' cash-gap alert", () => {
  it("alerts only once a gap above $500 has lasted 30 minutes, then hourly, and says when it clears", async () => {
    live.gap = -650;
    expect(await checkBooksCashGap(start)).toBe("the books' cash differs from IBKR's by -650.00 (for 0 min)");
    await checkBooksCashGap(minutesLater(20));
    expect(telegram.sent).toEqual([]);
    await checkBooksCashGap(minutesLater(30));
    expect(telegram.sent).toEqual([bookCashGapMessage]);
    await checkBooksCashGap(minutesLater(40));
    expect(telegram.sent).toHaveLength(1);
    live.gap = 12;
    expect(await checkBooksCashGap(minutesLater(50))).toBeNull();
    expect(telegram.sent).toEqual([bookCashGapMessage, bookCashGapClearedMessage]);
  });

  it("restarts the 30 minutes when the gap comes back within $500 before alerting, with no message", async () => {
    live.gap = 900;
    await checkBooksCashGap(start);
    live.gap = 500;
    await checkBooksCashGap(minutesLater(20));
    live.gap = 900;
    await checkBooksCashGap(minutesLater(40));
    expect(telegram.sent).toEqual([]);
  });

  it("leaves the state alone when IBKR's cash is unknown, and does nothing outside prod", async () => {
    live.gap = 900;
    await checkBooksCashGap(start);
    live.gap = null;
    expect(await checkBooksCashGap(minutesLater(20))).toBeNull();
    live.gap = 900;
    await checkBooksCashGap(minutesLater(30));
    expect(telegram.sent).toEqual([bookCashGapMessage]);
    environment.name = "staging";
    telegram.sent.length = 0;
    await db("alert_state").whereIn("alert_key", ["books_cash_gap", "books_cash_gap_over_since"]).del();
    expect(await checkBooksCashGap(minutesLater(200))).toBeNull();
    expect(await db("alert_state").where({ alert_key: "books_cash_gap_over_since" }).first()).toBeUndefined();
  });
});

describe("the start's baseline night", () => {
  it("dates a live start before the open to the previous close, and tonight's values never overwrite it", async () => {
    await db("book_cash_entries").whereNotNull("allocates_entry_id").del();
    for (const table of ["book_cash_entries", "book_leg_transfers", "ticker_book_periods", "book_value_snapshots", "book_statement_imports", "books_cutover"]) await db(table).del();
    await db("market_calendar").whereIn("calendar_date", ["2026-11-04", "2026-11-05"]).del();
    await applyBooksCutover(
      { mode: "live", cutOverAt: new Date("2026-11-05T05:24:26Z"), statementToDate: null, ibkrCash: 278_678, plutoStartingValue: 500_000, plutoPositionsValue: 224_274, manualPositionsValue: 260_758, plutoOpeningCash: 275_726, manualOpeningCash: 2_952, plutoSymbols: [], statementRowKeys: [], legsWithoutClosingPrice: [] },
      null,
    );
    const dates = await db("book_value_snapshots").distinct(db.raw("snapshot_date::text AS d"));
    expect(dates.map((row: { d: string }) => row.d)).toEqual(["2026-11-04"]);
    expect(await writeBookValueSnapshots("2026-11-04", [], new Date("2026-11-05T21:30:00Z"))).toBeNull();
    expect(Number((await db("book_value_snapshots").where({ snapshot_date: "2026-11-04", book_key: "pluto" }).first("book_value")).book_value)).toBe(500_000);
    expect(await writeBookValueSnapshots("2026-11-05", [], new Date("2026-11-05T21:30:00Z"))).not.toBeNull();
  });
});
