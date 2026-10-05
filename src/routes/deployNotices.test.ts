import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDeployNoticeHandler } from "./deployNotices.js";

const announced: { subject: string; current: unknown }[] = [];
let expectedSecret: string | undefined;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/deploy-notices",
    createDeployNoticeHandler({
      readExpectedSecret: () => expectedSecret,
      announce: async (input) => {
        announced.push(input);
      },
    }),
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  announced.length = 0;
  expectedSecret = "the-shared-secret";
});

function post(body: unknown, secret?: string): Promise<Response> {
  return fetch(`${baseUrl}/deploy-notices`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret === undefined ? {} : { "X-Deploy-Notice-Secret": secret }) },
    body: JSON.stringify(body),
  });
}

describe("POST /deploy-notices", () => {
  it("announces the App's release with the right secret", async () => {
    const response = await post({ releaseVersion: "v70", commitSha: "986951b5aaaa" }, "the-shared-secret");
    expect(response.status).toBe(204);
    expect(announced).toEqual([{ subject: "App", current: { releaseVersion: "v70", commitSha: "986951b5aaaa" } }]);
  });

  it("announces a start without release metadata as unknown instead of failing", async () => {
    const response = await post({}, "the-shared-secret");
    expect(response.status).toBe(204);
    expect(announced[0]?.current).toBeNull();
  });

  it("rejects a wrong or missing secret and announces nothing", async () => {
    expect((await post({ releaseVersion: "v70", commitSha: "x" }, "wrong")).status).toBe(401);
    expect((await post({ releaseVersion: "v70", commitSha: "x" })).status).toBe(401);
    expect(announced).toEqual([]);
  });

  it("fails closed with 503 when the API has no secret configured", async () => {
    expectedSecret = undefined;
    expect((await post({ releaseVersion: "v70", commitSha: "x" }, "")).status).toBe(503);
    expect(announced).toEqual([]);
  });
});
