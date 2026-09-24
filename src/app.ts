import { environmentRouter } from "./routes/environment.js";
import express from "express";
import cors from "cors";
import { environment } from "./config/env.js";
import { handleGenosukeWebhook } from "./genosuke/bot.js";
import { sessionMiddleware } from "./middleware/session.js";
import { authRouter } from "./routes/auth.js";
import { calendarEventsRouter } from "./routes/calendarEvents.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { genosukePreferencesRouter } from "./routes/genosukePreferences.js";
import { healthRouter } from "./routes/health.js";
import { notificationsRouter } from "./routes/notifications.js";
import { createStreamMultiplexerRouter } from "./routes/streamMultiplexer.js";
import { streamProducers } from "./streams/streamProducers.js";
import { positionsRouter } from "./routes/positions.js";
import { pricePerformanceRouter } from "./routes/pricePerformance.js";
import { riskLimitsRouter } from "./routes/riskLimits.js";
import { screenerRouter } from "./routes/screener.js";
import { shortlistRouter } from "./routes/shortlist.js";
import { signalsRouter } from "./routes/signals.js";
import { signalSettingsRouter } from "./routes/signalSettings.js";
import { systemHealthRouter } from "./routes/systemHealth.js";
import { tickerDetailRouter } from "./routes/tickerDetail.js";
import { tradeAlertsRouter } from "./routes/tradeAlerts.js";
import { tradeBlotterRouter } from "./routes/tradeBlotter.js";
import { requestRateMiddleware } from "./lib/requestRateTracker.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { installDbQueryTimingTracker } from "./lib/dbQueryTimingTracker.js";
import { emitPulse, pulseOnRequestMiddleware } from "./lib/pulseEmitter.js";
import { db } from "./db/connection.js";

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
// For Iorio Pulse's Heroku node — see requestRateTracker.ts.
installDbQueryTimingTracker(db);
db.on("query", () => emitPulse("heroku-db"));
app.use(requestRateMiddleware);
app.use(pulseOnRequestMiddleware);

app.use(healthRouter);
app.use("/environment", environmentRouter);
// Telegram calls this directly (no session) — authenticated by the shared
// secret header checked inside the handler instead.
app.post("/genosuke/webhook", handleGenosukeWebhook);
app.use("/genosuke/preferences", genosukePreferencesRouter);
app.use("/auth", authRouter);
app.use("/screener", screenerRouter);
app.use("/shortlist", shortlistRouter);
app.use("/price-performance", pricePerformanceRouter);
app.use("/tickers", tickerDetailRouter);
app.use("/risk-limits", riskLimitsRouter);
app.use("/positions", positionsRouter);
app.use("/notifications", notificationsRouter);
app.use("/stream", createStreamMultiplexerRouter({ producers: streamProducers }));
app.use("/trade-blotter", tradeBlotterRouter);
app.use("/trade-alerts", tradeAlertsRouter);
app.use("/signals", signalsRouter);
app.use("/signal-settings", signalSettingsRouter);
app.use("/system-health", systemHealthRouter);
app.use("/calendar-events", calendarEventsRouter);
app.use("/dashboard", dashboardRouter);

// Without this, an uncaught route error (e.g. an IBKR request that rejects)
// falls through to Express's default handler, which returns plain text
// ("Internal Server Error") instead of the { error: "..." } JSON shape
// every route and the frontend's apiRequest client otherwise expect.
app.use(errorHandler);
