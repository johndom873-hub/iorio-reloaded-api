import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

// The real healthRouter with a stand-in database: the route's whole job is "run select 1 and say whether it worked", so the
// failing case needs a connection that can be told to fail.
const rawMock = vi.fn();
vi.mock("../db/connection.js", () => ({ db: { raw: (...args: unknown[]) => rawMock(...args) } }));

const { healthRouter } = await import("./health.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(healthRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  rawMock.mockReset().mockResolvedValue({ rows: [{ "?column?": 1 }] });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /health", () => {
  it("answers ok after one trivial query, with no session required", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(rawMock).toHaveBeenCalledTimes(1);
    expect(rawMock).toHaveBeenCalledWith("select 1");
  });

  it("answers 503 with a generic message (the database's own error text is only logged) when the query fails", async () => {
    rawMock.mockRejectedValue(new Error("connection terminated unexpectedly to db.internal:5432"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", message: "Database unavailable." });
    expect(consoleErrorSpy).toHaveBeenCalledWith("Health check: database unreachable: connection terminated unexpectedly to db.internal:5432");
    consoleErrorSpy.mockRestore();
  });

  it("recovers on the next call once the database is back", async () => {
    rawMock.mockRejectedValueOnce(new Error("temporarily down"));

    expect((await fetch(`${baseUrl}/health`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("is only served at /health", async () => {
    expect((await fetch(`${baseUrl}/`)).status).toBe(404);
  });
});
