import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import knexLibrary, { type Knex } from "knex";

// The real riskLimitsRouter's trading-halt routes on a small express app against the test database. The IBKR / exposure imports the
// router carries for its other routes are mocked, and so are the two outbound notifications (Telegram audit line, app notification).
vi.mock("../db/connection.js", async () => {
  const { config } = await import("dotenv");
  config();
  if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL must be set to run trading halt route tests.");
  return { db: knexLibrary({ client: "pg", connection: process.env.TEST_DATABASE_URL, pool: { min: 0, max: 4 } }) };
});
vi.mock("../ibkr/fetchAccountSummary.js", () => ({ fetchAccountSummary: vi.fn() }));
vi.mock("../lib/positionExposure.js", () => ({ computeCashLockedInCsps: vi.fn(), computePositionExposures: vi.fn(), streamPositionExposures: vi.fn() }));
const notifyTelegramMock = vi.fn();
vi.mock("../lib/notifyTelegram.js", () => ({ notifyTelegram: (...args: unknown[]) => notifyTelegramMock(...args) }));
const publishNotificationMock = vi.fn();
vi.mock("../lib/notificationChannel.js", () => ({ publishNotification: (...args: unknown[]) => publishNotificationMock(...args) }));

const { db } = await import("../db/connection.js");
const { riskLimitsRouter } = await import("./riskLimits.js");

const testDb: Knex = db;

let server: Server;
let baseUrl: string;
let userId: string;
let originalRow: Record<string, unknown> | undefined;

beforeAll(async () => {
  originalRow = await testDb("platform_controls").where({ key: "trading_halt" }).first();
  const [user] = await testDb("users").insert({ username: `halt-route-${Date.now()}`, display_name: "Halt Route Tester", password_hash: "not-a-real-hash" }).returning("id");
  userId = user.id;

  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => {
    const asUser = request.header("x-test-user-id");
    (request as unknown as { session: { userId?: string } }).session = asUser ? { userId: asUser } : {};
    next();
  });
  app.use("/risk-limits", riskLimitsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  notifyTelegramMock.mockReset();
  publishNotificationMock.mockReset();
  await testDb("platform_controls").insert({ key: "trading_halt", enabled: false, reason: null, set_by_user_id: null }).onConflict("key").merge({ enabled: false, reason: null, set_by_user_id: null });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalRow) await testDb("platform_controls").insert(originalRow).onConflict("key").merge();
  await testDb("users").where({ id: userId }).del();
  await testDb.destroy();
});

async function call(method: "GET" | "PUT", path: string, body?: unknown, options: { asUser?: string | null } = {}) {
  const asUser = options.asUser === undefined ? userId : options.asUser;
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(asUser ? { "x-test-user-id": asUser } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as any };
}

const readRow = () => testDb("platform_controls").where({ key: "trading_halt" }).first();

describe("GET /risk-limits/trading-halt", () => {
  it("reads the seeded switch as off", async () => {
    expect(await call("GET", "/risk-limits/trading-halt")).toEqual({ status: 200, json: { enabled: false, reason: null, setByDisplayName: null, setAt: expect.any(String) } });
  });

  it("is refused without a session", async () => {
    expect((await call("GET", "/risk-limits/trading-halt", undefined, { asUser: null })).status).toBe(401);
  });
});

describe("PUT /risk-limits/trading-halt", () => {
  it("halts with a reason: stores who and why, answers with the state, notifies the app and writes a Telegram audit line", async () => {
    const response = await call("PUT", "/risk-limits/trading-halt", { enabled: true, reason: "  IBKR data looks wrong  " });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ enabled: true, reason: "IBKR data looks wrong", setByDisplayName: "Halt Route Tester" });
    expect(await readRow()).toMatchObject({ enabled: true, reason: "IBKR data looks wrong", set_by_user_id: userId });
    expect(publishNotificationMock).toHaveBeenCalledWith({ type: "trading_halt_changed", enabled: true, reason: "IBKR data looks wrong", byDisplayName: "Halt Route Tester" });
    expect(notifyTelegramMock).toHaveBeenCalledTimes(1);
    expect(notifyTelegramMock.mock.calls[0]?.[0]).toContain("TRADING HALTED by Halt Route Tester: IBKR data looks wrong");
    expect((await call("GET", "/risk-limits/trading-halt")).json.enabled).toBe(true);
  });

  it("resumes without a reason and says so in the audit line", async () => {
    await call("PUT", "/risk-limits/trading-halt", { enabled: true, reason: "x" });
    notifyTelegramMock.mockReset();
    const response = await call("PUT", "/risk-limits/trading-halt", { enabled: false });
    expect(response.status).toBe(200);
    expect(response.json).toMatchObject({ enabled: false, reason: null });
    expect(await readRow()).toMatchObject({ enabled: false, reason: null });
    expect(notifyTelegramMock.mock.calls[0]?.[0]).toContain("Trading halt lifted by Halt Route Tester");
  });

  it.each([
    ["no body", undefined, "enabled must be true or false."],
    ["enabled not a boolean", { enabled: "yes", reason: "x" }, "enabled must be true or false."],
    ["a reason that is not text", { enabled: true, reason: 5 }, "reason must be text."],
    ["halting with no reason", { enabled: true }, "A reason is required to halt trading."],
    ["halting with a blank reason", { enabled: true, reason: "   " }, "A reason is required to halt trading."],
    ["a reason over 300 characters", { enabled: true, reason: "x".repeat(301) }, "reason must be at most 300 characters."],
  ])("refuses %s with a 400 and changes nothing", async (_label, body, error) => {
    const response = await call("PUT", "/risk-limits/trading-halt", body ?? {});
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error });
    expect((await readRow())?.enabled).toBe(false);
    expect(notifyTelegramMock).not.toHaveBeenCalled();
    expect(publishNotificationMock).not.toHaveBeenCalled();
  });

  it("accepts a reason of exactly 300 characters", async () => {
    expect((await call("PUT", "/risk-limits/trading-halt", { enabled: true, reason: "x".repeat(300) })).status).toBe(200);
  });

  it("is refused without a session and changes nothing", async () => {
    expect((await call("PUT", "/risk-limits/trading-halt", { enabled: true, reason: "x" }, { asUser: null })).status).toBe(401);
    expect((await readRow())?.enabled).toBe(false);
  });
});
