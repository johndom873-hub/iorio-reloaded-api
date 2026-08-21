import type { GenosukeApiClient } from "../apiClient.js";
import type { ToolDefinition } from "../openRouterAdapter.js";

export type GenosukeToolTier = "read" | "low-stakes-write" | "financial-write";

export interface GenosukeTool extends ToolDefinition {
  tier: GenosukeToolTier;
  /** For financial-write tools: the human-readable line shown on the Yes/Cancel confirmation. Required for that tier, ignored otherwise. */
  describeForConfirmation?: (input: Record<string, unknown>) => string;
  execute: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<unknown>;
}
