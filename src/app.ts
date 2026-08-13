import express from "express";
import cors from "cors";
import { environment } from "./config/env.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { tickersRouter } from "./routes/tickers.js";
import { shortlistRouter } from "./routes/shortlist.js";
import { screenerRouter } from "./routes/screener.js";

export const app = express();

// Heroku terminates TLS in front of the dyno and forwards over HTTP; without
// this, Express can't tell the connection was actually HTTPS, and the
// session cookie's `secure` flag would silently fail to be set.
app.set("trust proxy", 1);

app.use(
  cors({
    origin: environment.frontendOrigin,
    credentials: true,
  }),
);
app.use(express.json());
app.use(sessionMiddleware);

app.use(healthRouter);
app.use("/auth", authRouter);
app.use("/tickers", tickersRouter);
app.use("/shortlist", shortlistRouter);
app.use("/screener", screenerRouter);
