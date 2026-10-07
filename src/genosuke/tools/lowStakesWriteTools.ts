// Low-stakes write tools — mutate state but have no direct financial
// consequence (nothing here books a trade or changes a live position), so
// they execute immediately without the Yes/Cancel confirm gate the
// financial-write tier requires. Genosuke should still say what it did
// after the fact, just not ask permission first.
import type { GenosukeTool } from "./types.js";

export const lowStakesWriteTools: GenosukeTool[] = [
  {
    name: "add_shortlist_ticker",
    description:
      "Add a ticker to the monitored shortlist. Fetches live market data from IBKR if the ticker isn't already tracked. Signals is off unless signalsEnabled is true: an off ticker only shows on Price Performance and is not scored on Signals or tradable by Pluto. Only set it when the user asks for Signals on.",
    tier: "low-stakes-write",
    parameters: {
      type: "object",
      properties: { symbol: { type: "string" }, signalsEnabled: { type: "boolean" } },
      required: ["symbol"],
    },
    execute: (input, api) => api.post("/shortlist", input),
  },
  {
    name: "remove_shortlist_ticker",
    description:
      "Remove a ticker from the shortlist (soft-delete). Use the shortlist entry id from list_shortlist, not the ticker id. Refused (409) while the ticker has an open position — it must be closed first.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: { entryId: { type: "string" } }, required: ["entryId"] },
    execute: (input, api) => api.delete(`/shortlist/${encodeURIComponent(String(input.entryId))}`),
  },
  {
    name: "trigger_ibkr_health_check",
    description: "Runs a real IBKR Gateway health check right now (same check the hourly scheduled job runs) and returns the result.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: {} },
    execute: (_input, api) => api.post("/system-health/check-ibkr", {}),
  },
  {
    name: "save_preference",
    description:
      "Save a standing instruction Marce or Juan explicitly confirmed they want you to remember across future conversations. Only call this after they've said yes to your 'do you want me to remember that?' question — never on your own initiative.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: { content: { type: "string" } }, required: ["content"] },
    execute: (input, api) => api.post("/genosuke/preferences", { content: input.content }),
  },
  {
    name: "forget_preference",
    description:
      "Remove a previously saved preference. Pass the bracketed id shown next to it in the Preferences section of your system prompt, not the text itself.",
    tier: "low-stakes-write",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    execute: (input, api) => api.delete(`/genosuke/preferences/${encodeURIComponent(String(input.id))}`),
  },
];
