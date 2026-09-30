import type { GenosukeApiClient } from "../apiClient.js";
import type { ToolDefinition } from "../openRouterAdapter.js";

export type GenosukeToolTier = "read" | "low-stakes-write" | "financial-write" | "infra-write";

export interface GenosukeTool extends ToolDefinition {
  tier: GenosukeToolTier;
  /** For financial-write/infra-write tools: the human-readable line shown on the Yes/Cancel confirmation. Required for those tiers, ignored otherwise. */
  describeForConfirmation?: (input: Record<string, unknown>, api: GenosukeApiClient) => string | Promise<string>;
  /** For financial-write tools: returns an error for the model (no card is sent) when the request is provably wrong, e.g. a close that includes an already-closed leg. */
  validateBeforeConfirmation?: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<string | null>;
  /** True for tools whose execute() result is an order_requests row still in flight ("confirmed", not yet a terminal IBKR outcome) — bot.ts polls it and sends a follow-up once it resolves. */
  tracksOrderStatus?: boolean;
  /** For tools whose outcome the human must read (an action that can be refused, or that needs them to do something next): the message sent after the confirmation instead of the generic "Done:" line. */
  describeResult?: (result: unknown) => string;
  execute: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<unknown>;
}
