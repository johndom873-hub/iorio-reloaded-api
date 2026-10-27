import { decideAssignmentRiskAlert, loadAssignmentRiskAlertStates, loadHeldShortLegs, notifyAssignmentRisk, rearmAssignmentRiskAlert, recordAssignmentRiskAlert, type AssignmentRiskAlert, type AssignmentRiskAlertState, type HeldShortLeg } from "./assignmentRiskAlerts.js";
import { contractKeyOf, type MarketQuoteConsumer, type QuoteLoopCycle, type QuoteLoopOptionQuote } from "./marketQuoteLoop.js";
import { loadTradingSessionsBetween } from "./marketSessionStatus.js";
import { calendarDaysUntilExpiry } from "./optionChainCaptureWindow.js";
import { deltaFromQuoteMid, yearsToSessionClose } from "./quoteOwnDelta.js";
import { getRiskFreeRate } from "./riskFreeRate.js";

// The market quote loop's assignment-risk user: every held short leg is quoted each cycle, all session, and its delta
// is read from its own quote's mid (quoteOwnDelta.ts, as the CC + Put Ladder does): time to expiry is the hours to
// today's close on its expiry day, else calendar days to expiry ÷ 365. A leg with no two-sided quote is skipped.

export interface AssignmentRiskConsumerDependencies {
  loadHeldShortLegs(): Promise<HeldShortLeg[]>;
  loadAlertStates(legIds: string[]): Promise<Map<string, AssignmentRiskAlertState>>;
  recordAlert(legId: string, tradingDateIso: string): Promise<void>;
  rearmAlert(legId: string): Promise<void>;
  notify(alert: AssignmentRiskAlert): Promise<void>;
  riskFreeRate(): Promise<number | null>;
  sessionCloseMinutesEt(dateIso: string): Promise<number>;
}

const defaultDependencies: AssignmentRiskConsumerDependencies = {
  loadHeldShortLegs,
  loadAlertStates: loadAssignmentRiskAlertStates,
  recordAlert: recordAssignmentRiskAlert,
  rearmAlert: rearmAssignmentRiskAlert,
  notify: notifyAssignmentRisk,
  riskFreeRate: () => getRiskFreeRate(),
  sessionCloseMinutesEt: async (dateIso) => (await loadTradingSessionsBetween(dateIso, dateIso))[0]?.closeMinutesEt ?? 16 * 60,
};

export function createAssignmentRiskConsumer(deps: AssignmentRiskConsumerDependencies = defaultDependencies): MarketQuoteConsumer {
  let legs: HeldShortLeg[] = [];
  return {
    name: "assignment risk",
    async tickers() {
      legs = await deps.loadHeldShortLegs();
      const tickers = new Map(legs.map((leg) => [leg.tickerId, { tickerId: leg.tickerId, symbol: leg.symbol }]));
      return [...tickers.values()];
    },
    async contracts() {
      return legs.map((leg) => ({ tickerId: leg.tickerId, symbol: leg.symbol, expiry: leg.expiry, strike: leg.strike, right: leg.right }));
    },
    async onCycleComplete(quotes: QuoteLoopOptionQuote[], cycle: QuoteLoopCycle) {
      const quoteByKey = new Map(quotes.map((quote) => [contractKeyOf(quote.contract), quote]));
      const riskFreeRate = (await deps.riskFreeRate()) ?? 0;
      const yearsToTodaysClose = legs.some((leg) => leg.expiry <= cycle.tradingDateIso) ? yearsToSessionClose(cycle.now, await deps.sessionCloseMinutesEt(cycle.tradingDateIso)) : 0;
      const scored: (HeldShortLeg & { delta: number; dte: number })[] = [];
      for (const leg of legs) {
        const quote = quoteByKey.get(contractKeyOf(leg));
        const spotPrice = cycle.spotByTicker.get(leg.tickerId) ?? null;
        if (!quote || spotPrice === null) continue;
        const daysToExpiry = calendarDaysUntilExpiry(cycle.tradingDateIso, leg.expiry.replaceAll("-", ""));
        const delta = deltaFromQuoteMid({ bid: quote.bid, ask: quote.ask, spotPrice, strike: leg.strike, isCall: leg.right === "C", yearsToExpiry: daysToExpiry <= 0 ? yearsToTodaysClose : daysToExpiry / 365, riskFreeRate });
        if (delta !== null) scored.push({ ...leg, delta, dte: Math.max(0, daysToExpiry) });
      }
      if (scored.length === 0) return;
      const states = await deps.loadAlertStates(scored.map((leg) => leg.legId));
      for (const leg of scored) {
        const state = states.get(leg.legId);
        if (!state) continue; // closed since the legs were loaded
        const decision = decideAssignmentRiskAlert(leg.delta, state, cycle.tradingDateIso);
        if (decision === "rearm") await deps.rearmAlert(leg.legId);
        if (decision === "alert") {
          // Recorded before notifying: a failed write must not turn into a re-alert every cycle.
          await deps.recordAlert(leg.legId, cycle.tradingDateIso);
          await deps.notify({ symbol: leg.symbol, leg, spotPrice: cycle.spotByTicker.get(leg.tickerId) ?? null });
        }
      }
    },
  };
}
