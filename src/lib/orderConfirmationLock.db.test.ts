import knexLibrary, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run the confirmation lock tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 8 } }) };
});

const { db } = await import("../db/connection.js");
const { withOrderConfirmationLock } = await import("./orderConfirmationLock.js");
const testDb: Knex = db;

afterAll(async () => {
  await testDb.destroy();
});

const pause = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

describe("withOrderConfirmationLock", () => {
  it("returns what the work returns", async () => {
    expect(await withOrderConfirmationLock(async () => "done")).toBe("done");
  });

  it("hands the work a live transaction on the database", async () => {
    const answer = await withOrderConfirmationLock(async (transaction) => (await transaction.raw("select 41 + 1 as answer")).rows[0].answer);
    expect(answer).toBe(42);
  });

  it("makes simultaneous work take turns: no overlap, in the order they arrived", async () => {
    const events: string[] = [];
    const run = (name: string, milliseconds: number) =>
      withOrderConfirmationLock(async () => {
        events.push(`${name} start`);
        await pause(milliseconds);
        events.push(`${name} end`);
      });
    const first = run("first", 120);
    await pause(30);
    const second = run("second", 10);
    await pause(30);
    const third = run("third", 10);
    await Promise.all([first, second, third]);
    expect(events).toEqual(["first start", "first end", "second start", "second end", "third start", "third end"]);
  });

  it("releases the lock when the work throws, and passes the error on", async () => {
    await expect(
      withOrderConfirmationLock(async () => {
        throw new Error("gate exploded");
      }),
    ).rejects.toThrow("gate exploded");
    expect(await withOrderConfirmationLock(async () => "next one runs")).toBe("next one runs");
  });

  it("rolls back what the work wrote when it throws, and commits it otherwise", async () => {
    // A real throwaway table, because the check spans connections.
    await testDb.raw("drop table if exists order_confirmation_lock_test");
    await testDb.raw("create table order_confirmation_lock_test (value text)");
    try {
      await expect(
        withOrderConfirmationLock(async (transaction) => {
          await transaction.raw("insert into order_confirmation_lock_test values ('rolled back')");
          throw new Error("fail after writing");
        }),
      ).rejects.toThrow("fail after writing");
      await withOrderConfirmationLock(async (transaction) => {
        await transaction.raw("insert into order_confirmation_lock_test values ('committed')");
      });
      const rows = await testDb("order_confirmation_lock_test").pluck("value");
      expect(rows).toEqual(["committed"]);
    } finally {
      await testDb.raw("drop table if exists order_confirmation_lock_test");
    }
  });

  it("is held until the work finishes even when the caller keeps working after an early return value", async () => {
    let holderFinished = false;
    const holder = withOrderConfirmationLock(async () => {
      await pause(80);
      holderFinished = true;
    });
    await pause(20);
    let waiterStartedBeforeHolderFinished: boolean | null = null;
    await withOrderConfirmationLock(async () => {
      waiterStartedBeforeHolderFinished = !holderFinished;
    });
    await holder;
    expect(waiterStartedBeforeHolderFinished).toBe(false);
  });
});
