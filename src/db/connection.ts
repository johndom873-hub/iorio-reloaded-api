import knexLibrary from "knex";
import { environment } from "../config/env.js";
import { databaseConnectionBudget } from "../config/databaseConnectionBudget.js";
import { postgresSslOption } from "../config/databaseSsl.js";

// One-off job scripts (Heroku Scheduler entries and `npm run` scripts all
// live under scripts/) get the smaller job pool — see databaseConnectionBudget.ts.
const isOneOffJobProcess = /[\\/]scripts[\\/]/.test(process.argv[1] ?? "");
// The Pluto agent (npm run agent / agent:dev) has its own, smaller pool.
const isPlutoAgentProcess = /[\\/]plutoAgent(\.(js|ts))?$/.test(process.argv[1] ?? "");

export const db = knexLibrary({
  client: "pg",
  // Explicit ceiling instead of tarn's default 10 — see databaseConnectionBudget.ts.
  pool: isOneOffJobProcess ? { min: 0, max: databaseConnectionBudget.jobKnexPoolMax } : isPlutoAgentProcess ? { min: 1, max: databaseConnectionBudget.agentKnexPoolMax } : { min: 2, max: databaseConnectionBudget.knexPoolMax },
  // Heroku Postgres rejects unencrypted connections outright ("no pg_hba.conf
  // entry ... no encryption"); Postgres.app doesn't support SSL. Explicit per process
  // (DATABASE_SSL), see config/databaseSsl.ts.
  connection: { connectionString: environment.databaseUrl, ssl: postgresSslOption() },
});
