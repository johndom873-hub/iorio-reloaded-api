import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { environment } from "./config/env.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { healthRouter } from "./routes/health.js";
import { screenerRouter } from "./routes/screener.js";
import { tickerDetailRouter } from "./routes/tickerDetail.js";

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
app.use("/screener", screenerRouter);
app.use("/tickers", tickerDetailRouter);

// Without this, an uncaught route error (e.g. an IBKR request that rejects)
// falls through to Express's default handler, which returns plain text
// ("Internal Server Error") instead of the { error: "..." } JSON shape
// every route and the frontend's apiRequest client otherwise expect.
const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Something went wrong. Please try again." });
};
app.use(errorHandler);
