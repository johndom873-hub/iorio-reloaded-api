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
  /**
   * For financial-write tools that must show the human what the system says about the order BEFORE the card (the same blocks and warnings the
   * web order review shows): builds the order, reads its gates, and returns the card text plus whatever execute() needs, or a `problem` (no card is
   * sent, the model gets the error). Replaces validateBeforeConfirmation + describeForConfirmation for such a tool. Throwing counts as a problem.
   */
  prepareConfirmation?: (input: Record<string, unknown>, api: GenosukeApiClient) => Promise<PreparedConfirmation>;
  /** Undoes what prepareConfirmation set up when the human cancels (or the confirmation expires). Errors are ignored. */
  discardPrepared?: (prepared: unknown, api: GenosukeApiClient) => Promise<void>;
  execute: (input: Record<string, unknown>, api: GenosukeApiClient, prepared?: unknown) => Promise<unknown>;
}

export type PreparedConfirmation = { problem: string } | { problem?: undefined; description: string; prepared: unknown };
