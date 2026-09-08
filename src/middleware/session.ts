import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { environment, requireEnvironmentVariable } from "../config/env.js";

const PgSessionStore = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgSessionStore({
    // Knex pools via tarn, which isn't compatible with the raw pg.Pool
    // connect-pg-simple expects — give it its own small dedicated pool
    // via connection string instead of trying to share Knex's. Heroku
    // Postgres rejects unencrypted connections, so production needs an
    // explicit ssl option (conObject), not just a bare connection string.
    ...(environment.nodeEnvironment === "production"
      ? { conObject: { connectionString: environment.databaseUrl, ssl: { rejectUnauthorized: false } } }
      : { conString: environment.databaseUrl }),
    tableName: "session",
    createTableIfMissing: false,
  }),
  // Validated here, not in the shared environment object -- session.ts is
  // web-dyno-only (never imported by the worker), and SESSION_SECRET means
  // nothing to a process that never opens an express-session. Root-caused
  // 2026-09-08: SESSION_SECRET used to be required eagerly in env.ts, which
  // every process importing that shared config module pays for even if it
  // never uses sessions -- crash-looped the VPS worker on deploy once the
  // fallback was removed, since its .env has never had this var set.
  secret: requireEnvironmentVariable("SESSION_SECRET"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: environment.nodeEnvironment === "production",
    // app.ioriore.com and api.ioriore.com share a parent domain, so this
    // counts as same-site for cookie purposes — "lax" works and is
    // stronger CSRF protection than "none". (Was "none" in production
    // while both apps lived on separate *.herokuapp.com hostnames.)
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
});

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}
