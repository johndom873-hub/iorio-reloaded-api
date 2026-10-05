import type { Knex } from "knex";
import { db } from "../db/connection.js";
import { formatDurationHuman } from "./formatDurationHuman.js";

// The trading halt (kill switch): platform_controls row `trading_halt`. Read by the
// order confirm gate (tradingGate.ts), by the VPS worker right before placeOrder
// (ibkrGatewayWorker.ts) and by the top bar / Pulse. Written only through
// setTradingHalt below so every change carries who/when/why.

export const tradingHaltControlKey = "trading_halt";

export interface TradingHalt {
  enabled: boolean;
  reason: string | null;
  setByUserId: string | null;
  setByDisplayName: string | null;
  setAt: Date | null;
}

interface PlatformControlRow {
  key: string;
  enabled: boolean;
  reason: string | null;
  set_by_user_id: string | null;
  set_at: Date | string | null;
  set_by_display_name?: string | null;
}

function toTradingHalt(row: PlatformControlRow | undefined): TradingHalt {
  // Fails closed: the migration seeds this row, so a missing row means the switch's state cannot be known and trading stays halted.
  if (!row) return { enabled: true, reason: "the trading-halt switch row is missing from platform_controls", setByUserId: null, setByDisplayName: null, setAt: null };
  return {
    enabled: Boolean(row.enabled),
    reason: row.reason ?? null,
    setByUserId: row.set_by_user_id ?? null,
    setByDisplayName: row.set_by_display_name ?? null,
    setAt: row.set_at ? new Date(row.set_at) : null,
  };
}

export async function fetchTradingHalt(connection: Knex = db): Promise<TradingHalt> {
  const row = await connection("platform_controls as pc")
    .leftJoin("users as u", "u.id", "pc.set_by_user_id")
    .where("pc.key", tradingHaltControlKey)
    .select("pc.*", "u.display_name as set_by_display_name")
    .first();
  return toTradingHalt(row as PlatformControlRow | undefined);
}

export interface SetTradingHaltInput {
  enabled: boolean;
  reason: string | null;
  userId: string;
}

/** Upserts the halt row and returns the stored state (with the setter's display name). */
export async function setTradingHalt(input: SetTradingHaltInput): Promise<TradingHalt> {
  await db("platform_controls")
    .insert({ key: tradingHaltControlKey, enabled: input.enabled, reason: input.reason, set_by_user_id: input.userId, set_at: db.fn.now() })
    .onConflict("key")
    .merge({ enabled: input.enabled, reason: input.reason, set_by_user_id: input.userId, set_at: db.fn.now() });
  return fetchTradingHalt();
}

/** The reason text every enforcement point reports; null when trading is not halted. */
export function describeTradingHaltBlock(halt: TradingHalt, nowMs: number = Date.now()): string | null {
  if (!halt.enabled) return null;
  const who = halt.setByDisplayName ?? "an operator";
  const since = halt.setAt ? ` ${formatDurationHuman(Math.max(0, nowMs - halt.setAt.getTime()))} ago` : "";
  const why = halt.reason ? `: ${halt.reason}` : ".";
  return `Trading is halted — switched off by ${who}${since}${why}`;
}
