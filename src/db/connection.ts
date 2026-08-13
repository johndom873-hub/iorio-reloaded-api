import knexLibrary from "knex";
import { environment } from "../config/env.js";

export const db = knexLibrary({
  client: "pg",
  // Heroku Postgres rejects unencrypted connections outright ("no pg_hba.conf
  // entry ... no encryption"). Local Postgres.app doesn't require or support
  // SSL, so this only applies in production, mirroring knexfile.ts's config.
  connection:
    environment.nodeEnvironment === "production"
      ? { connectionString: environment.databaseUrl, ssl: { rejectUnauthorized: false } }
      : environment.databaseUrl,
});
