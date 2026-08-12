import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { environment } from "../config/env.js";

const PgSessionStore = connectPgSimple(session);

export const sessionMiddleware = session({
  store: new PgSessionStore({
    // Knex pools via tarn, which isn't compatible with the raw pg.Pool
    // connect-pg-simple expects — give it its own small dedicated pool
    // via connection string instead of trying to share Knex's.
    conString: environment.databaseUrl,
    tableName: "session",
    createTableIfMissing: false,
  }),
  secret: environment.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: environment.nodeEnvironment === "production",
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

declare module "express-session" {
  interface SessionData {
    userId: string;
  }
}
