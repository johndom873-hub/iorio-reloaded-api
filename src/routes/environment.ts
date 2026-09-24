import { Router } from "express";
import { db } from "../db/connection.js";
import { environment } from "../config/env.js";
import { readAppEnvironment } from "../lib/appEnvironment.js";
import { classifyTradingStatus } from "../lib/tradingGate.js";
import { loadMarketDataLineRestriction } from "../ibkr/marketDataLineBudget.js";
import { ibkrMarketDataLinesEnabled } from "../config/env.js";
import { requireAuth } from "../middleware/requireAuth.js";

// Feeds the top-bar environment badges (PAPER / LIVE / STAGING / DEV / TRADING BLOCKED).
// GET /environment is public on purpose (the login page shows it too, so nobody signs into the
// wrong environment) and reveals only the environment name and trading mode. Everything else is
// behind login at GET /environment/details.
export const environmentRouter = Router();

environmentRouter.get("/", (_request, response) => {
  response.json({ environment: readAppEnvironment(), tradingMode: environment.ibkrTradingMode });
});

environmentRouter.get("/details", requireAuth, async (_request, response) => {
  const apiEnvironment = readAppEnvironment();
  const [workerRow, marketDataRestriction] = await Promise.all([db("worker_health").where({ process_name: "ibkr_gateway_worker" }).first(), loadMarketDataLineRestriction()]);
  const trading = classifyTradingStatus(workerRow, apiEnvironment);
  response.json({
    environment: apiEnvironment,
    tradingMode: environment.ibkrTradingMode,
    trading,
    // Non-null while the chain capture holds its priority lines — the top bar's "Live data restricted" state.
    marketDataRestriction,
    // False when IBKR_MARKET_DATA_LINES_ENABLED=false — the top bar's "Real-time data disabled" state.
    marketDataLinesEnabled: ibkrMarketDataLinesEnabled(),
    worker: workerRow
      ? {
          gitSha: workerRow.git_sha ? String(workerRow.git_sha).slice(0, 7) : null,
          accountId: workerRow.ibkr_account_ids?.[0] ?? null,
          detectedTradingMode: workerRow.detected_trading_mode ?? null,
          bindingStatus: workerRow.account_binding_status ?? null,
          heartbeatAgeSeconds: Math.max(0, Math.round((Date.now() - new Date(workerRow.updated_at).getTime()) / 1000)),
        }
      : null,
  });
});
