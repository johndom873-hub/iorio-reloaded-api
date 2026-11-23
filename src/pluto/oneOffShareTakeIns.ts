import { db } from "../db/connection.js";
import { addVolFarmerV4Shares, volFarmerV4BreakEven } from "../backtest/engine/volFarmerV4Steps.js";
import { publishNotification } from "../lib/notificationChannel.js";
import type { VolFarmerV4Memory } from "./volFarmerV4LiveBook.js";
import { loadVolFarmerV4OrderOutcomes, saveVolFarmerV4Memory } from "./volFarmerV4LookLoader.js";

// Shares a Call order of Pluto's bought that its memory never counted, taken in once (Marcelo 2026-11-23): settled before a
// Call order's settlement took such shares in (volFarmerV4LiveBook.ts). Matched by the order's action, so on any other
// database it does nothing. Delete once it has run on prod (its holdings_adopted event carries sharesTakenInFromActionId).
export const oneOffShareTakeIns: readonly { symbol: string; actionId: string }[] = [{ symbol: "IBIT", actionId: "ee72fd0f-f24e-4e7f-8d6a-97966ed10e19" }];

/**
 * Takes the ticker's one-off shares into its memory and saves it, with a holdings_adopted event that marks it done, in one
 * transaction. Answers the round's note, or null when there is nothing to take in (not listed, already taken in, no shares
 * bought, the order still working, no position to take them into, an order of the ticker still to settle).
 * Example: IBIT's first position of 1,600 shares takes in the 200 bought at $35.57 ($7,114.34 with commission): 1,800 shares.
 */
export async function takeInOneOffShares(input: { tickerId: string; symbol: string; memory: VolFarmerV4Memory; passId: string }): Promise<string | null> {
  const entry = oneOffShareTakeIns.find((candidate) => candidate.symbol === input.symbol);
  if (entry === undefined || input.memory.pending.length > 0) return null;
  const done = await db("pluto_events").where({ type: "holdings_adopted" }).whereRaw("payload->>'sharesTakenInFromActionId' = ?", [entry.actionId]).first("id");
  if (done) return null;
  const outcome = (await loadVolFarmerV4OrderOutcomes([entry.actionId])).get(entry.actionId);
  if (outcome === undefined || outcome.working || outcome.sharesBought <= 0) return null;
  const name = input.memory.state.first !== null ? "first" : input.memory.state.second !== null ? "second" : null;
  if (name === null) return null;
  const position = input.memory.state[name]!;
  addVolFarmerV4Shares(position, outcome.sharesBought, outcome.sharesCostDollars);
  const payload = {
    passId: input.passId,
    symbol: input.symbol,
    strategy: "vol_farmer_v4",
    shares: position.shares,
    breakEvenPerShare: volFarmerV4BreakEven(position) ?? position.costPerShare,
    callContracts: Math.round(position.calls.reduce((sum, call) => sum + call.shares, 0) / 100),
    putContracts: Math.round(position.puts.reduce((sum, put) => sum + put.shares, 0) / 100),
    sharesTakenIn: outcome.sharesBought,
    sharesTakenInFromActionId: entry.actionId,
  };
  const row = await db.transaction(async (trx) => {
    await saveVolFarmerV4Memory(input.tickerId, input.memory, false, trx);
    const [inserted] = await trx("pluto_events").insert({ type: "holdings_adopted", payload: JSON.stringify(payload) }).returning(["id", "occurred_at"]);
    return inserted as { id: string | number; occurred_at: Date };
  });
  await publishNotification({ type: "pluto_event", eventId: Number(row.id), eventType: "holdings_adopted", occurredAt: new Date(row.occurred_at).toISOString(), payload }).catch(() => {});
  return `${outcome.sharesBought} shares its Call order of ${entry.actionId.slice(0, 8)} bought were taken into the ${name} position (${position.shares} shares now)`;
}
