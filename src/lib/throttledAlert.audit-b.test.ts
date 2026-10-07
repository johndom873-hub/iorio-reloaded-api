import knexLibrary, { type Knex } from "knex";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Audit B (2026-10-07): notifyDownThrottled's new options (send, reminderText) against the real alert_state table.
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 2 } }) };
});
const tracked = vi.hoisted(() => ({ messages: [] as string[] }));
vi.mock("./notifyTelegram.js", () => ({ notifyTelegram: async () => true, notifyPlutoTelegram: async () => true }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: async (text: string) => { tracked.messages.push(text); return true; } }));

const { db } = await import("../db/connection.js");
const { clearDownState, notifyDownThrottled } = await import("./throttledAlert.js");
const testDb: Knex = db;
const prefix = `audit-b-throttle-${Date.now()}`;
let counter = 0;
const key = () => `${prefix}-${(counter += 1)}`;

beforeEach(() => {
  tracked.messages.length = 0;
});

afterAll(async () => {
  await testDb("alert_state").whereLike("alert_key", `${prefix}%`).del();
  await testDb.destroy();
});

describe("notifyDownThrottled — options", () => {
  it("without options the ops path (notifyTelegramTracked) and the default reminder wording are unchanged", async () => {
    const alertKey = key();
    expect(await notifyDownThrottled(alertKey, "down", 60_000)).toBe(true);
    expect(await notifyDownThrottled(alertKey, "down", 60_000)).toBe(false);
    await testDb("alert_state").where({ alert_key: alertKey }).update({ last_alerted_at: new Date(Date.now() - 2 * 60_000), first_alerted_at: new Date(Date.now() - 2 * 60_000) });
    expect(await notifyDownThrottled(alertKey, "down", 60_000)).toBe(true);
    expect(tracked.messages[0]).toBe("down");
    expect(tracked.messages[1]).toMatch(/^down\n\n\(Still down after ~.+\. Reminders are sent at most every .+\.\)$/);
  });

  it("a custom send replaces the ops path for the first message and the reminder; reminderText shapes the reminder", async () => {
    const alertKey = key();
    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    const reminderText = (message: string, downFor: string, interval: string) => `${message} | ${downFor} | ${interval}`;
    await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send, reminderText });
    await testDb("alert_state").where({ alert_key: alertKey }).update({ last_alerted_at: new Date(Date.now() - 61 * 60_000), first_alerted_at: new Date(Date.now() - 3 * 60 * 60_000) });
    await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send, reminderText });
    expect(tracked.messages).toEqual([]);
    expect(sent[0]).toBe("flagged");
    expect(sent[1]).toMatch(/^flagged \| .*3.* \| .*1.*$/);
  });

  // RISK (characterised): the state row is written before sending, and a send that reports failure (notifyPlutoTelegram
  // returns false rather than throwing) is not retried: the first message is lost until the next reminder, an hour later
  // for Pluto concerns, and the undelivered-alerts tracking of the ops path is bypassed.
  it("a send that resolves false is not counted as sent: the next call tries again", async () => {
    const alertKey = key();
    const send = vi.fn(async () => false);
    expect(await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send })).toBe(false);
    expect(await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send })).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    send.mockResolvedValue(true as never);
    expect(await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send })).toBe(true);
    expect(await notifyDownThrottled(alertKey, "flagged", 60 * 60_000, { send })).toBe(false); // delivered: throttled now
  });

  it("a changed message goes out at once (why concern texts must stay constant)", async () => {
    const alertKey = key();
    const sent: string[] = [];
    const send = async (text: string) => { sent.push(text); };
    await notifyDownThrottled(alertKey, "a", 60 * 60_000, { send });
    await notifyDownThrottled(alertKey, "b", 60 * 60_000, { send });
    expect(sent).toHaveLength(2);
  });

  it("clearDownState returns null when nothing was open, the age otherwise, and deletes the row", async () => {
    const alertKey = key();
    expect(await clearDownState(alertKey)).toBeNull();
    await notifyDownThrottled(alertKey, "x", 60_000, { send: async () => {} });
    expect(await clearDownState(alertKey)).toEqual(expect.any(Number));
    expect(await testDb("alert_state").where({ alert_key: alertKey }).first()).toBeUndefined();
  });
});
