import type { GenosukeApiClient } from "../apiClient.js";
import type { ToolDefinition } from "../openRouterAdapter.js";

export type GenosukeToolTier = "read" | "low-stakes-write" | "financial-write" | "infra-write";

export interface GenosukeTool extends ToolDefinition {
  tier: GenosukeToolTier;
  /** For financial-write/infra-write tools: the human-readable line shown on the Yes/Cancel confirmation. Required for those tiers, ignored otherwise. */
  describeForConfirmation?: (input: Record<string, unknown>) => string;
  /** True for tools whose execute() result is an order_requests row still in flight ("confirmed", not yet a terminal IBKR outcome) — bot.ts polls it and sends a follow-up once it resolves. */
  tracksOrderStatus?: boolean;
  execute: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<unknown>;
}
