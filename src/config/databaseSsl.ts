// Whether this process's Postgres connections use SSL: true for Heroku Postgres (it rejects unencrypted connections), false for a
// local server. An explicit per-process setting, not derived from NODE_ENV or APP_ENVIRONMENT, because it depends on where the
// database is, not on which environment the code runs in: a script on a laptop (APP_ENVIRONMENT=development) pointed at the
// staging database needs true. Standalone (no import of config/env.ts) so knexfile.ts and every process can use it without
// pulling in that module's eager validation.
export function readDatabaseSsl(): boolean {
  const value = process.env.DATABASE_SSL;
  if (value !== "true" && value !== "false") {
    throw new Error(`DATABASE_SSL must be "true" or "false", got: ${value === undefined || value === "" ? "(missing)" : value}`);
  }
  return value === "true";
}

/** The `ssl` option for pg / knex connections. */
export function postgresSslOption(): { rejectUnauthorized: false } | false {
  return readDatabaseSsl() ? { rejectUnauthorized: false } : false;
}
