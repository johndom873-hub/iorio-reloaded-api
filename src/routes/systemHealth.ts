import { Router } from "express";
import { db } from "../db/connection.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { runIbkrHealthCheckJob } from "../ibkr/checkIbkrHealthJob.js";

export const systemHealthRouter = Router();
systemHealthRouter.use(requireAuth);

const defaultJobsLimit = 50;

const jobRunSelect = `
  SELECT
    id,
    job_name AS "jobName",
    started_at AS "startedAt",
    finished_at AS "finishedAt",
    status,
    error_message AS "errorMessage",
    details
  FROM job_runs
`;

systemHealthRouter.get("/jobs", async (request, response) => {
  const limit = Math.min(Number(request.query.limit) || defaultJobsLimit, 200);
  const result = await db.raw(`${jobRunSelect} ORDER BY started_at DESC LIMIT ?`, [limit]);
  response.json(result.rows);
});

// Latest run per distinct job_name — the per-module status cards.
systemHealthRouter.get("/status", async (_request, response) => {
  const result = await db.raw(`
    SELECT DISTINCT ON (job_name)
      id,
      job_name AS "jobName",
      started_at AS "startedAt",
      finished_at AS "finishedAt",
      status,
      error_message AS "errorMessage",
      details
    FROM job_runs
    ORDER BY job_name, started_at DESC
  `);
  response.json(result.rows);
});

// Runs the VPS SSH round-trip synchronously and returns the resulting
// job_runs row — fast enough (single SSH exec) not to need SSE, unlike the
// slower IBKR market-data calls elsewhere in the app.
systemHealthRouter.post("/check-ibkr", async (_request, response) => {
  try {
    await runIbkrHealthCheckJob();
  } catch {
    // runIbkrHealthCheckJob (via runJob) already logged the failure to
    // job_runs and notified Telegram — swallow here so the response below
    // still returns the logged row instead of a 500.
  }

  const result = await db.raw(`${jobRunSelect} WHERE job_name = 'ibkr_health_check' ORDER BY started_at DESC LIMIT 1`);
  response.json(result.rows[0] ?? null);
});
