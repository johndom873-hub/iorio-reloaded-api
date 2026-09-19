import knexLibrary from "knex";
import { environment } from "../config/env.js";
import { databaseConnectionBudget } from "../config/databaseConnectionBudget.js";

export const db = knexLibrary({
  client: "pg",
  // Explicit ceiling instead of tarn's default 10 — see databaseConnectionBudget.ts.
  pool: { min: 2, max: databaseConnectionBudget.knexPoolMax },
  // Heroku Postgres rejects unencrypted connections outright ("no pg_hba.conf
  // entry ... no encryption"). Local Postgres.app doesn't require or support
  // SSL, so this only applies in production, mirroring knexfile.ts's config.
  connection:
    environment.nodeEnvironment === "production"
      ? { connectionString: environment.databaseUrl, ssl: { rejectUnauthorized: false } }
      : environment.databaseUrl,
});
