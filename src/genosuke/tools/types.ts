import type { GenosukeApiClient } from "../apiClient.js";
import type { ToolDefinition } from "../openRouterAdapter.js";

export type GenosukeToolTier = "read" | "low-stakes-write" | "infra-write";

export interface GenosukeTool extends ToolDefinition {
  tier: GenosukeToolTier;
  /** For infra-write tools: the human-readable line shown on the Yes/Cancel confirmation. Required for that tier, ignored otherwise. */
  describeForConfirmation?: (input: Record<string, unknown>, api: GenosukeApiClient) => string | Promise<string>;
  /** For infra-write tools: returns an error for the model (no card is sent) when the request is provably wrong, e.g. a WAF rule with a blank expression. */
  validateBeforeConfirmation?: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<string | null>;
  /** For tools whose outcome the human must read (an action that can be refused, or that needs them to do something next): the message sent after the confirmation instead of the generic "Done:" line. */
  describeResult?: (result: unknown) => string;
  execute: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<unknown>;
}
