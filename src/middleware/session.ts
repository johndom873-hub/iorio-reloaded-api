import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { environment } from "../config/env.js";

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
  secret: environment.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: environment.nodeEnvironment === "production",
    // App and API are on separate Heroku hostnames (no shared parent domain
    // yet), which browsers treat as cross-site — "lax" cookies are withheld
    // on cross-site fetch/XHR, so login would appear to work but every
    // following request would look logged-out. Revisit once both apps share
    // a parent domain (app.ioriore.com / api.ioriore.com).
    sameSite: environment.nodeEnvironment === "production" ? "none" : "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}
