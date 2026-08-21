// Low-stakes write tools — mutate state but have no direct financial
// consequence (nothing here books a trade or changes a live position), so
// they execute immediately without the Yes/Cancel confirm gate the
// financial-write tier requires. Genosuke should still say what it did
// after the fact, just not ask permission first.
import type { GenosukeTool } from "./types.js";

const strategyKeyEnum = { type: "string", enum: ["covered_call", "cash_secured_put"] };

export const lowStakesWriteTools: GenosukeTool[] = [
  {
    name: "add_screener_ticker",
    description: "Add a ticker to a strategy's monitored shortlist. Fetches live market data from IBKR if the ticker isn't already tracked.",
    tier: "low-stakes-write",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, strategyKey: strategyKeyEnum, notes: { type: "string" } },
      required: ["symbol", "strategyKey"],
    },
    execute: (input, api) => api.post("/screener", input),
  },
  {
    name: "remove_screener_ticker",
    description: "Remove a ticker from a strategy's shortlist (soft-delete). Use the shortlist entry id from list_screener, not the ticker id.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: { entryId: { type: "string" } }, required: ["entryId"] },
    execute: (input, api) => api.delete(`/screener/${input.entryId}`),
  },
  {
    name: "update_screener_notes",
    description: "Update the free-text notes on a shortlist entry.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: { entryId: { type: "string" }, notes: { type: "string" } }, required: ["entryId", "notes"] },
    execute: (input, api) => api.patch(`/screener/${input.entryId}`, { notes: input.notes }),
  },
  {
    name: "update_position_notes",
    description: "Update a position's notes, price target, or close-trigger notes. Metadata only — does not touch legs, prices, or status.",
    tier: "low-stakes-write",
    parameters: {
      type: "object",
      properties: {
        positionId: { type: "string" },
        notes: { type: "string" },
        priceTarget: { type: "number" },
        closeTriggerNotes: { type: "string" },
      },
      required: ["positionId"],
    },
    execute: (input, api) => {
      const { positionId, ...patch } = input;
      return api.patch(`/positions/${positionId}`, patch);
    },
  },
  {
    name: "trigger_ibkr_health_check",
    description: "Runs a real IBKR Gateway health check right now (same check the hourly scheduled job runs) and returns the result.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.post("/system-health/check-ibkr", {}),
  },
];
