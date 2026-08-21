// In-memory pending-confirmation store for financial-write tool calls.
// Deliberately not persisted (matches the bot's own conversation history —
// see bot.ts's chatHistories) — a confirmation that's still unanswered
// across a dyno restart should just expire, not silently execute later
// against possibly-stale context.
import { randomUUID } from "node:crypto";

export interface PendingConfirmation {
  id: string;
  chatId: string;
  toolName: string;
  input: Record<string, unknown>;
  createdAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingConfirmation>();

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, confirmation] of pending) {
    if (now - confirmation.createdAt > TTL_MS) pending.delete(id);
  }
}

export function createConfirmation(chatId: string, toolName: string, input: Record<string, unknown>): PendingConfirmation {
  sweepExpired();
  const confirmation: PendingConfirmation = { id: randomUUID(), chatId, toolName, input, createdAt: Date.now() };
  pending.set(confirmation.id, confirmation);
  return confirmation;
}

/** Looks up and removes a pending confirmation in one step — a confirmation can only ever be resolved (confirmed or cancelled) once. */
export function takeConfirmation(id: string): PendingConfirmation | null {
  const confirmation = pending.get(id);
  if (!confirmation) return null;
  pending.delete(id);
  if (Date.now() - confirmation.createdAt > TTL_MS) return null;
  return confirmation;
}
