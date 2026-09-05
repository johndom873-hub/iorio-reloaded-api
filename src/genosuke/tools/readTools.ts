// Read-only tools — safe to call speculatively, no confirmation needed.
// Each maps to an existing GET route; Genosuke is just another authenticated
// client of the same API the frontend uses (see apiClient.ts).
//
// The two SSE live-data routes (GET /tickers/:symbol/detail/stream and
// /tickers/:symbol/position-quote/stream) still aren't exposed directly —
// SSE doesn't fit a simple request/response tool call. get_ticker_quote
// below closes the gap this used to leave (a ticker with no open position
// had no price data source at all, hit in practice 2026-08-24) via a
// dedicated blocking route, GET /tickers/:symbol/quote, rather than the SSE
// ones — see fetchTickerQuoteSnapshot.ts.
import { listWafRules } from "../../lib/cloudflareService.js";
import { fetchLogsFromBetterStack, type LogSourceApp } from "../../lib/betterstackService.js";
import type { GenosukeTool } from "./types.js";

const strategyKeyEnum = { type: "string", enum: ["covered_call", "cash_secured_put"] };

export const readTools: GenosukeTool[] = [
  {
    name: "get_dashboard_summary",
    description: "Account-level P&L summary: day/week/month/year P&L, net liquidation value, cumulative realized/unrealized P&L, per-strategy breakdown.",
    tier: "read",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.get("/dashboard/summary"),
  },
  {
    name: "get_pnl_history",
    description: "Daily P&L / net liquidation value history, most recent first.",
    tier: "read",
    parameters: { type: "object", properties: { days: { type: "number", description: "How many days back, max 365. Defaults to a reasonable window if omitted." } } },
    execute: (input, api) => api.get(`/dashboard/history${input.days ? `?days=${input.days}` : ""}`),
  },
  {
    name: "list_positions",
    description: "List open or closed positions, optionally filtered by strategy. Each includes its legs (entry/exit prices, strike, expiry) and computed realizedPnl/capitalAtRisk.",
    tier: "read",
    parameters: {
      type: "object",
      properties: { status: { type: "string", enum: ["open", "closed"] }, strategyKey: strategyKeyEnum },
      required: ["status"],
    },
    execute: (input, api) => {
      const params = new URLSearchParams({ status: String(input.status) });
      if (input.strategyKey) params.set("strategy", String(input.strategyKey));
      return api.get(`/positions?${params.toString()}`);
    },
  },
  {
    name: "get_position",
    description: "Full detail for a single position by id, including all legs.",
    tier: "read",
    parameters: { type: "object", properties: { positionId: { type: "string" } }, required: ["positionId"] },
    execute: (input, api) => api.get(`/positions/${input.positionId}`),
  },
  {
    name: "get_position_live_pnl_and_greeks",
    description: "Live-priced unrealized P&L and current Greeks (delta/gamma/vega/theta) for an OPEN position's option leg(s) — makes a real IBKR round-trip, only works during US market hours. For closed positions, realizedPnl from get_position/list_positions is already final and doesn't need this.",
    tier: "read",
    parameters: { type: "object", properties: { positionId: { type: "string" } }, required: ["positionId"] },
    execute: async (input, api) => {
      const position = await api.get<{ legs: { id: string; legType: string; exitAt: string | null }[] }>(`/positions/${input.positionId}`);
      const optionLegIds = position.legs.filter((leg) => leg.legType === "option" && !leg.exitAt).map((leg) => leg.id);
      const [greeks, pnl] = await Promise.all([
        optionLegIds.length > 0 ? api.get(`/positions/greeks?legIds=${optionLegIds.join(",")}`) : Promise.resolve({}),
        api.get(`/positions/pnl?positionIds=${input.positionId}`),
      ]);
      return { greeksByLegId: greeks, unrealizedPnl: (pnl as Record<string, unknown>)[String(input.positionId)] };
    },
  },
  {
    name: "get_ticker_quote",
    description:
      "Stock price and option chain for a symbol — including one with no open position and no trade alert (e.g. picking parameters for a manual order). Always returns lastKnownClose (yesterday's-or-earlier daily close, works anytime). live.pricing/live.optionChain (bid/ask/strikes/premiums) are only populated during US market hours — check liveUnavailableReason before assuming live data exists, and never invent a bid/ask/premium if live is null.",
    tier: "read",
    parameters: { type: "object", properties: { symbol: { type: "string" } }, required: ["symbol"] },
    execute: (input, api) => api.get(`/tickers/${String(input.symbol).toUpperCase()}/quote`),
  },
  {
    name: "list_trade_alerts",
    description: "List trade alert suggestions (new_trade or roll) by status.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["pending", "approved", "rejected", "modified", "expired"], description: "Defaults to pending if omitted." },
        strategyKey: strategyKeyEnum,
      },
    },
    execute: (input, api) => {
      const params = new URLSearchParams();
      if (input.status) params.set("status", String(input.status));
      if (input.strategyKey) params.set("strategy", String(input.strategyKey));
      const query = params.toString();
      return api.get(`/trade-alerts${query ? `?${query}` : ""}`);
    },
  },
  {
    name: "list_trades",
    description:
      "The Trade Blotter — real fills (`trades`, with computed P&L on closing trades) AND any order that hasn't reached a terminal state yet (`pendingOrders`: pending_confirmation/confirmed/submitted/cancel_requested, one row per leg, includes ibkrOrderId and errorMessage). This is the tool to check the status of an order that was just placed/confirmed — a submitted order won't show up anywhere else (not in list_positions, not in get_position) until it fills. Filterable by strategy, symbol, and date range.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        strategyKey: strategyKeyEnum,
        symbol: { type: "string" },
        from: { type: "string", description: "ISO date, inclusive." },
        to: { type: "string", description: "ISO date, inclusive." },
      },
    },
    execute: (input, api) => {
      const params = new URLSearchParams();
      if (input.strategyKey) params.set("strategy", String(input.strategyKey));
      if (input.symbol) params.set("symbol", String(input.symbol));
      if (input.from) params.set("from", String(input.from));
      if (input.to) params.set("to", String(input.to));
      const query = params.toString();
      return api.get(`/trade-blotter${query ? `?${query}` : ""}`);
    },
  },
  {
    name: "get_risk_limits_settings",
    description: "Per-strategy risk settings: delta/DTE targets, position/collateral/concentration caps, minimum cash reserve.",
    tier: "read",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.get("/risk-limits/settings"),
  },
  {
    name: "get_risk_exposure",
    description: "Current exposure vs. the risk settings above — concentration by ticker/sector and live account summary from IBKR.",
    tier: "read",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.get("/risk-limits/exposure"),
  },
  {
    name: "list_shortlist",
    description: "The monitored-ticker shortlist for one strategy, with each ticker's latest IV, IV Rank, and avg option volume snapshot.",
    tier: "read",
    parameters: { type: "object", properties: { strategyKey: strategyKeyEnum }, required: ["strategyKey"] },
    execute: (input, api) => api.get(`/shortlist?strategy=${input.strategyKey}`),
  },
  {
    name: "search_tickers",
    description: "Live IBKR search-as-you-type for US-listed optionable tickers, by symbol or company name.",
    tier: "read",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: (input, api) => api.get(`/shortlist/search?q=${encodeURIComponent(String(input.query))}`),
  },
  {
    name: "get_system_health_status",
    description: "Latest run status per scheduled job (daily market data, P&L snapshot, trade alerts, IBKR health check, watchdog).",
    tier: "read",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.get("/system-health/status"),
  },
  {
    name: "list_job_runs",
    description: "Recent scheduled job run history (most recent first), across all jobs.",
    tier: "read",
    parameters: { type: "object", properties: { limit: { type: "number", description: "Max rows, defaults to a reasonable window, capped at 200." } } },
    execute: (input, api) => api.get(`/system-health/jobs${input.limit ? `?limit=${input.limit}` : ""}`),
  },
  {
    name: "list_waf_rules",
    description: "List all current Cloudflare WAF custom rules on the ioriore.com zone, including blocked IPs/paths and their rule IDs (needed for remove_waf_rule).",
    tier: "read",
    parameters: { type: "object", properties: {} },
    execute: () => listWafRules(),
  },
  {
    name: "fetch_logs",
    description:
      "Raw application logs from Heroku (via Better Stack), for iorio-reloaded-api (web/worker backend) or iorio-reloaded-app (frontend static/SSR host) — use this to investigate an error, crash, or unexpected behavior report. Pass either `minutes` (a relative recent window) or `startTime`+`endTime` (ISO 8601, to investigate a specific past incident). Covers the last 8 days; returns up to 5000 lines, most relevant (closest to now, or closest to endTime) kept if the window has more than that.",
    tier: "read",
    parameters: {
      type: "object",
      properties: {
        sourceApp: { type: "string", enum: ["api", "app"], description: "'api' for iorio-reloaded-api (backend/worker), 'app' for iorio-reloaded-app (frontend host)." },
        minutes: { type: "number", description: "Minutes back from now. Defaults to 30 if none of minutes/startTime/endTime are given." },
        startTime: { type: "string", description: "ISO 8601. Use with endTime instead of minutes." },
        endTime: { type: "string", description: "ISO 8601. Use with startTime instead of minutes." },
      },
      required: ["sourceApp"],
    },
    execute: (input) =>
      fetchLogsFromBetterStack({
        sourceApp: input.sourceApp as LogSourceApp,
        minutes: input.minutes as number | undefined,
        startTime: input.startTime as string | undefined,
        endTime: input.endTime as string | undefined,
      }),
  },
];
