import type { Knex } from "knex";
import { db } from "../db/connection.js";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import { easternIsoDate } from "../lib/easternIsoDate.js";
import type { LadderOrderGateContext } from "../lib/ladderOrderGates.js";
import { defaultOptionQuoteBandPlannerDependencies } from "./optionQuoteBandPlanLoader.js";
import { loadPlutoSettings } from "./settingsStore.js";
import { effectiveAllocationPctBySymbol, loadEnabledPlutoTickerSettings, tickerPotFraction } from "./tickerSettingsStore.js";

// The order-gate context of a Pluto strategy's order request (ladderOrderGates.ts): null unless the order's Pluto action
// was taken under the CC + Put Ladder or Vol Farmer v2 (pluto_actions.execution_strategy). A ticker no longer enabled in
// Pluto has no allocation, so its pot is 0 and every opening order on it is refused. The book is every ticker enabled in
// Pluto; a ticker's pot is its allocation raised by the excess allowance (tickerPotFraction). The ladder: the action's
// sale step (contract.saleStep, ladderOrders.ts) tells a Cash-Secured Put entry from a
// ladder Put. Vol Farmer v2 (Marcelo 2026-10-27): its Calls are held to its Calls' |delta| range and its Puts to |delta|
// at most its Put |delta|; a LEAPS is paid from Pluto's budget beyond the ticker's pot, so it has no pot cap and no
// |delta| check, only the book's.

export async function loadLadderOrderGateContext(orderRequest: { pluto_action_id?: string | null; payload: OrderRequestPayload }, connection: Knex = db, now: Date = new Date()): Promise<LadderOrderGateContext | null> {
  if (!orderRequest.pluto_action_id) return null;
  const action: { execution_strategy: string; contract: { saleStep?: string } | null } | undefined = await connection("pluto_actions").where({ id: orderRequest.pluto_action_id }).first("execution_strategy", "contract");
  if (action?.execution_strategy !== "cc_put_ladder" && action?.execution_strategy !== "vol_farmer_v2") return null;
  const isVolFarmerV2 = action.execution_strategy === "vol_farmer_v2";
  const isLeaps = orderRequest.payload.strategyKey === "leaps";
  const symbol = orderRequest.payload.symbol.trim().toUpperCase();
  const todayIso = easternIsoDate(now);
  const [settings, enabledTickers, clock] = await Promise.all([loadPlutoSettings(connection), loadEnabledPlutoTickerSettings(connection), defaultOptionQuoteBandPlannerDependencies.loadClock(todayIso)]);
  const ticker = enabledTickers.find((entry) => entry.symbol === symbol);
  const allocationPct = effectiveAllocationPctBySymbol(enabledTickers).get(symbol) ?? 0;
  const optionLeg = orderRequest.payload.legs.find((leg) => leg.role === "option");
  const expiryIso = optionLeg?.expiry ? `${optionLeg.expiry.slice(0, 4)}-${optionLeg.expiry.slice(4, 6)}-${optionLeg.expiry.slice(6, 8)}` : null;
  const anchors = ticker && expiryIso ? await defaultOptionQuoteBandPlannerDependencies.loadForwardAnchors(ticker.tickerId, todayIso) : new Map();
  const potFraction = tickerPotFraction(allocationPct, settings);
  if (isVolFarmerV2) {
    const isPut = optionLeg?.right === "P";
    return {
      potFraction: isLeaps ? null : potFraction,
      book: { symbols: enabledTickers.map((entry) => entry.symbol), budgetFraction: settings.capitalBudgetPct / 100 },
      deltaChecked: !isLeaps,
      isEntryPut: isPut,
      minAbsDelta: isPut ? 0 : settings.volFarmerV2CallMinAbsDelta,
      maxAbsDelta: isPut ? settings.volFarmerV2PutMaxAbsDelta : settings.volFarmerV2CallMaxAbsDelta,
      forwardAnchor: (expiryIso && anchors.get(expiryIso)) || null,
      riskFreeRate: clock.riskFreeRate,
      todayIso,
      closeMinutesEt: clock.closeMinutesEt,
    };
  }
  return {
    potFraction,
    deltaChecked: true,
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
