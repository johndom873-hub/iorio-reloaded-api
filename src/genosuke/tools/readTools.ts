// Read-only tools — safe to call speculatively, no confirmation needed.
// Each maps to an existing GET route; Genosuke is just another authenticated
// client of the same API the frontend uses (see apiClient.ts).
//
// Two live-data routes are deliberately NOT exposed here: GET
// /tickers/:symbol/detail/stream and /tickers/:symbol/position-quote/stream
// are SSE, not a simple request/response — they don't fit a tool call
// without extra streaming plumbing. get_position_live_pnl_and_greeks below
// covers live pricing/greeks for actual positions, which is the case that
// matters most; live quotes for a ticker not yet held are a gap worth
// revisiting later if it comes up in practice.
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
    description: "Execution history (the Trade Blotter) — every recorded fill, with computed P&L on closing trades. Filterable by strategy, symbol, and date range.",
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
    name: "list_screener",
    description: "The monitored-ticker shortlist for one strategy, with each ticker's latest IV, IV Rank, and avg option volume snapshot.",
    tier: "read",
    parameters: { type: "object", properties: { strategyKey: strategyKeyEnum }, required: ["strategyKey"] },
    execute: (input, api) => api.get(`/screener?strategy=${input.strategyKey}`),
  },
  {
    name: "search_tickers",
    description: "Live IBKR search-as-you-type for US-listed optionable tickers, by symbol or company name.",
    tier: "read",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    execute: (input, api) => api.get(`/screener/search?q=${encodeURIComponent(String(input.query))}`),
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
];
