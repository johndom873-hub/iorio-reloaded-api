import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit B (2026-10-07): the concern alerts with the REAL throttle against alert_state (only Telegram is mocked).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
const sent = vi.hoisted(() => ({ pluto: [] as string[], ops: [] as string[] }));
vi.mock("../lib/notifyTelegram.js", () => ({ notifyPlutoTelegram: async (text: string) => { sent.pluto.push(text); return true; }, notifyTelegram: async (text: string) => { sent.ops.push(text); return true; } }));
vi.mock("../lib/undeliveredAlerts.js", () => ({ notifyTelegramTracked: async (text: string) => { sent.ops.push(text); return true; } }));

const { db } = await import("../db/connection.js");
const { concernReminderMs, updatePlutoConcernAlerts } = await import("./concernAlerts.js");
const testDb: Knex = db;
const suffix = String(Date.now() % 1_000_000);
const A = `AUDA${suffix}`;
const B = `AUDB${suffix}`;
const wholeMessageKey = "pluto-concern:message";
let savedWholeMessageRow: Record<string, unknown> | undefined;

beforeAll(async () => {
  // The whole-message key is shared: keep whatever the test database holds and put it back afterwards.
  savedWholeMessageRow = await testDb("alert_state").where({ alert_key: wholeMessageKey }).first();
  await testDb("alert_state").where({ alert_key: wholeMessageKey }).del();
});

beforeEach(() => {
  sent.pluto.length = 0;
  sent.ops.length = 0;
});

afterAll(async () => {
  await testDb("alert_state").whereIn("alert_key", [`pluto-concern:${A}`, `pluto-concern:${B}`, wholeMessageKey]).del();
  if (savedWholeMessageRow) await testDb("alert_state").insert(savedWholeMessageRow);
  await testDb.destroy();
});

const ageKey = (alertKey: string, minutes: number) => testDb("alert_state").where({ alert_key: alertKey }).update({ last_alerted_at: new Date(Date.now() - minutes * 60_000), first_alerted_at: new Date(Date.now() - minutes * 60_000) });

describe("updatePlutoConcernAlerts with the real throttle", () => {
  it("first flag, silent repeats within the hour, an hourly reminder with Pluto's wording, one cleared message", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [A, B], concerns: [{ symbol: A, concern: "one" }] });
    await updatePlutoConcernAlerts({ roundSymbols: [A, B], concerns: [{ symbol: A, concern: "worded differently" }] });
    expect(sent.pluto).toEqual([`🪐 Pluto sees a data problem on ${A} and will not trade it until it clears. The reason is on the Pluto screen.`]);

    await ageKey(`pluto-concern:${A}`, 61);
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: A, concern: "still" }] });
    expect(sent.pluto[1]).toMatch(new RegExp(`^🪐 Pluto sees a data problem on ${A} .*\\n\\n\\(Still flagged after ~.+\\. Reminders at most every .+\\.\\)$`, "s"));

    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
    expect(sent.pluto.slice(2)).toEqual([`✅ Pluto's data concern on ${A} has cleared.`]);
    expect(sent.ops).toEqual([]);
    expect(concernReminderMs).toBe(60 * 60_000);
  });

  it("two concerns on the same ticker send one message", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [B], concerns: [{ symbol: B, concern: "a" }, { symbol: B, concern: "b" }] });
    expect(sent.pluto).toHaveLength(1);
    await updatePlutoConcernAlerts({ roundSymbols: [B], concerns: [] });
  });

  it("a round that does not look at a flagged ticker neither clears nor reminds", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: A, concern: "x" }] });
    await ageKey(`pluto-concern:${A}`, 120);
    await updatePlutoConcernAlerts({ roundSymbols: [B], concerns: [] });
    expect(sent.pluto).toHaveLength(1);
    expect(await testDb("alert_state").where({ alert_key: `pluto-concern:${A}` }).first()).toBeDefined();
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
  });

  it("whole-message concern: own key, reminder after the hour, cleared once", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: null, concern: "account block" }] });
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: null, concern: "account block" }] });
    expect(sent.pluto).toEqual(["🪐 Pluto sees a problem with the data it was given and is standing aside. The reason is on the Pluto screen."]);
    await ageKey(wholeMessageKey, 61);
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: null, concern: "account block" }] });
    expect(sent.pluto).toHaveLength(2);
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
    expect(sent.pluto.slice(2)).toEqual(["✅ Pluto's concern about the data it was given has cleared."]);
  });

  it("a ticker concern and a whole-message concern in one answer send both", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [A, B], concerns: [{ symbol: B, concern: "x" }, { symbol: null, concern: "y" }] });
    expect(sent.pluto).toHaveLength(2);
    await updatePlutoConcernAlerts({ roundSymbols: [A, B], concerns: [] });
    expect(sent.pluto.slice(2).sort()).toEqual([`✅ Pluto's concern about the data it was given has cleared.`, `✅ Pluto's data concern on ${B} has cleared.`].sort());
  });

  // A whole-message concern on a TRADE verdict: the parser accepts it, passRunner's flagged_ticker gate ignores null-symbol
  // concerns, so the trade proceeds, yet Telegram says Pluto "is standing aside". The alert does not know the verdict.
  it("a whole-message concern always reads 'standing aside', whatever the verdict", async () => {
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [{ symbol: null, concern: "account block odd, trading SMCI anyway" }] });
    expect(sent.pluto[0]).toContain("is standing aside");
    await updatePlutoConcernAlerts({ roundSymbols: [A], concerns: [] });
  });
});
