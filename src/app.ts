import express, { type ErrorRequestHandler } from "express";
import cors from "cors";
import { environment } from "./config/env.js";
import { handleGenosukeWebhook } from "./genosuke/bot.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { healthRouter } from "./routes/health.js";
import { positionsRouter } from "./routes/positions.js";
import { riskLimitsRouter } from "./routes/riskLimits.js";
import { screenerRouter } from "./routes/screener.js";
import { systemHealthRouter } from "./routes/systemHealth.js";
import { tickerDetailRouter } from "./routes/tickerDetail.js";
import { tradeAlertsRouter } from "./routes/tradeAlerts.js";
import { tradeBlotterRouter } from "./routes/tradeBlotter.js";

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
// Telegram calls this directly (no session) — authenticated by the shared
// secret header checked inside the handler instead.
app.post("/genosuke/webhook", handleGenosukeWebhook);
// TEMPORARY diagnostic — replays apiClient.ts's exact internal self-call to
// /auth/login and reports what actually came back, to root-cause Genosuke's
// "no session cookie was returned" failure without guessing further.
// Remove once that's fixed. Gated on the webhook secret so it isn't a public
// login-status oracle.
app.get("/genosuke/debug-login", async (request, response) => {
  if (request.get("X-Debug-Secret") !== process.env.GENOSUKE_WEBHOOK_SECRET) {
    response.sendStatus(404);
    return;
  }
  const loginResponse = await fetch(`http://127.0.0.1:${process.env.PORT}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: process.env.GENOSUKE_SERVICE_USERNAME, password: process.env.GENOSUKE_SERVICE_USER_PASSWORD }),
  });
  response.json({
    status: loginResponse.status,
    ok: loginResponse.ok,
    headerNames: [...loginResponse.headers.keys()],
    getSetCookie: loginResponse.headers.getSetCookie(),
    getHeader: loginResponse.headers.get("set-cookie"),
    bodyPreview: (await loginResponse.text()).slice(0, 300),
  });
});
app.use("/auth", authRouter);
app.use("/screener", screenerRouter);
app.use("/tickers", tickerDetailRouter);
app.use("/risk-limits", riskLimitsRouter);
app.use("/positions", positionsRouter);
app.use("/trade-blotter", tradeBlotterRouter);
app.use("/trade-alerts", tradeAlertsRouter);
app.use("/system-health", systemHealthRouter);
app.use("/dashboard", dashboardRouter);

// Without this, an uncaught route error (e.g. an IBKR request that rejects)
// falls through to Express's default handler, which returns plain text
// ("Internal Server Error") instead of the { error: "..." } JSON shape
// every route and the frontend's apiRequest client otherwise expect.
const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Something went wrong. Please try again." });
};
app.use(errorHandler);
