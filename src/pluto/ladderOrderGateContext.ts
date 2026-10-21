import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import type { LadderOrderGateContext } from "../lib/ladderOrderGates.js";
import { defaultLadderBandPlannerDependencies } from "./ladderBandPlanLoader.js";
import { loadPlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings } from "./tickerSettingsStore.js";

// The CC + Put Ladder's order-gate context for an order request (ladderOrderGates.ts): null unless the order's Pluto
// action was taken under the ladder (pluto_actions.execution_strategy). A ticker no longer enabled in Pluto has no
// allocation, so its pot is 0 and every opening order on it is refused. The book is every ticker enabled in Pluto; the
// action's sale step (contract.saleStep, ladderOrders.ts) tells a Cash-Secured Put entry from a ladder Put.

export async function loadLadderOrderGateContext(orderRequest: { pluto_action_id?: string | null; payload: OrderRequestPayload }, connection: Knex = db, now: Date = new Date()): Promise<LadderOrderGateContext | null> {
  if (!orderRequest.pluto_action_id) return null;
  const action: { execution_strategy: string; contract: { saleStep?: string } | null } | undefined = await connection("pluto_actions").where({ id: orderRequest.pluto_action_id }).first("execution_strategy", "contract");
  if (action?.execution_strategy !== "cc_put_ladder") return null;
  const symbol = orderRequest.payload.symbol.trim().toUpperCase();
  const todayIso = easternIsoDate(now);
  const [settings, enabledTickers, clock] = await Promise.all([loadPlutoSettings(connection), loadEnabledPlutoTickerSettings(connection), defaultLadderBandPlannerDependencies.loadClock(todayIso)]);
  const ticker = enabledTickers.find((entry) => entry.symbol === symbol);
  const allocationPct = effectiveAllocationPctBySymbol(enabledTickers).get(symbol) ?? 0;
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  const expiryIso = optionLeg?.expiry ? `${optionLeg.expiry.slice(0, 4)}-${optionLeg.expiry.slice(4, 6)}-${optionLeg.expiry.slice(6, 8)}` : null;
  const anchors = ticker && expiryIso ? await defaultLadderBandPlannerDependencies.loadForwardAnchors(ticker.tickerId, todayIso) : new Map();
  return {
    potFraction: ((allocationPct / 100) * settings.capitalBudgetPct) / 100,
    book: { symbols: enabledTickers.map((entry) => entry.symbol), budgetFraction: settings.capitalBudgetPct / 100 },
    isEntryPut: optionLeg?.right === "P" && action.contract?.saleStep === "entry",
    minAbsDelta: ticker?.ladderMinAbsDelta ?? settings.ladderMinAbsDelta,
    maxAbsDelta: ticker?.ladderMaxAbsDelta ?? settings.ladderMaxAbsDelta,
    forwardAnchor: (expiryIso && anchors.get(expiryIso)) || null,
    riskFreeRate: clock.riskFreeRate,
    todayIso,
    closeMinutesEt: clock.closeMinutesEt,
  };
}
