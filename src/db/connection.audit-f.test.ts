import { afterEach, describe, expect, it, vi } from "vitest";

// Audit F (2026-10-07): which pool db/connection.ts picks from process.argv[1]. knex is replaced so nothing connects.

const recordedConfigs = vi.hoisted(() => [] as { pool: { min: number; max: number } }[]);
vi.mock("knex", () => ({ default: (config: { pool: { min: number; max: number } }) => { recordedConfigs.push(config); return {}; } }));

const originalArgv1 = process.argv[1];

afterEach(() => {
  process.argv[1] = originalArgv1!;
  recordedConfigs.length = 0;
  vi.resetModules();
});

async function poolFor(argv1: string | undefined): Promise<{ min: number; max: number }> {
  if (argv1 === undefined) process.argv.splice(1, 1, undefined as unknown as string);
  else process.argv[1] = argv1;
  vi.resetModules();
  await import("./connection.js");
  return recordedConfigs.at(-1)!.pool;
}

describe("db pool by process", () => {
  it.each([
    ["Heroku agent dyno (npm run agent)", "/app/dist/src/plutoAgent.js", { min: 1, max: 2 }],
    ["agent:dev under tsx (absolute path)", "/Users/marcelo/Sites/iorio-reloaded-api/src/plutoAgent.ts", { min: 1, max: 2 }],
    ["Heroku web dyno", "/app/dist/src/server.js", { min: 2, max: 4 }],
    ["VPS worker", "/opt/iorio/dist/src/ibkrGatewayWorker.js", { min: 2, max: 4 }],
    ["Heroku Scheduler job (compiled)", "/app/dist/scripts/run-option-chain-capture-job.js", { min: 0, max: 2 }],
    ["npm run script under tsx", "/Users/marcelo/Sites/iorio-reloaded-api/scripts/pluto-replay.ts", { min: 0, max: 2 }],
    ["Windows-style agent path", "C:\\app\\dist\\src\\plutoAgent.js", { min: 1, max: 2 }],
    ["a file that only contains the name", "/app/dist/src/notPlutoAgent.js", { min: 2, max: 4 }],
  ])("%s", async (_label, argv1, expected) => {
    expect(await poolFor(argv1)).toEqual(expected);
  });

  it("an entry started without its extension (`node dist/src/plutoAgent`) still gets the agent pool", async () => {
    expect(await poolFor("/app/dist/src/plutoAgent")).toEqual({ min: 1, max: 2 });
  });

  it("the budget still sums to the role's 20-connection limit", async () => {
    const { databaseConnectionBudget: budget } = await import("../config/databaseConnectionBudget.js");
    const webDyno = budget.knexPoolMax + budget.sessionStorePoolMax + 1;
    const vpsWorker = budget.knexPoolMax + 2;
    const twoJobs = 2 * budget.jobKnexPoolMax;
    const plutoAgent = budget.agentKnexPoolMax + 1;
    expect(webDyno + vpsWorker + twoJobs + plutoAgent).toBe(20);
  });
});
