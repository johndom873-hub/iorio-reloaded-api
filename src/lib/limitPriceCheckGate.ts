import { OptionType } from "@stoqey/ib";
import type { OrderRequestPayload } from "../ibkr/ibkrGatewayOrderPayload.js";
import type { PriceContract } from "../ibkr/fetchLivePrices.js";
import { subscribeToPooledQuote, waitForFirstReading, type PooledQuote } from "../ibkr/marketDataPool.js";
import { describeOrderLegForPriceCheck, evaluateLimitPrices, usableQuote, type PriceCheckResult } from "./limitPriceCheck.js";
import { loadPriceCheckTolerance } from "./tradingSettingsStore.js";

// The limit-price check at the confirm step (and in the order preview), for every order type: each leg's limit against its own live
// two-sided quote from the shared pool (limitPriceCheck.ts has the formula). Fail closed: a quote that does not arrive within the
// pool's settle grace, or any failure, refuses the order. The trading worker repeats the check from its own IBKR snapshot right
// before placement (ibkrGatewayLimitPriceCheck.ts), so a price that drifted after confirm is caught there.

function poolContractForLeg(leg: OrderRequestPayload["legs"][number], index: number): PriceContract {
  if (leg.role === "stock") return { key: `price-check-${index}`, legType: "stock", symbol: leg.symbol };
  return { key: `price-check-${index}`, legType: "option", symbol: leg.symbol, expiry: leg.expiry, strike: leg.strike, right: leg.right === "C" ? OptionType.Call : OptionType.Put };
}

/** Null when the order has no legs; otherwise the verdict, with the quotes it saw on each leg. */
export async function evaluateLimitPriceCheckForOrderRequest(orderRequest: { payload: OrderRequestPayload }): Promise<PriceCheckResult | null> {
  const { legs } = orderRequest.payload;
  if (!legs || legs.length === 0) return null;

  const quotesByIndex = new Map<number, PooledQuote>();
  const unsubscribes: Array<() => void> = [];
  try {
    const tolerance = await loadPriceCheckTolerance();
    const { settled, check } = waitForFirstReading(() => legs.every((_, index) => usableQuote(quotesByIndex.get(index) ?? null) !== null));
    for (const [index, leg] of legs.entries()) {
      unsubscribes.push(
        await subscribeToPooledQuote(poolContractForLeg(leg, index), (quote) => {
          quotesByIndex.set(index, quote);
          check();
        }),
      );
    }
    await settled;
    return evaluateLimitPrices(
      legs.map((leg, index) => ({
        description: describeOrderLegForPriceCheck(leg),
        action: leg.action === "BUY" ? "BUY" : "SELL",
        limitPrice: leg.unitPrice,
        quote: quotesByIndex.get(index) ?? null,
      })),
      tolerance,
    );
  } catch (error) {
    return { blocked: true, reasons: [`The limit prices could not be checked against live quotes (${error instanceof Error ? error.message : String(error)}).`], legs: [] };
  } finally {
    for (const unsubscribe of unsubscribes) unsubscribe();
  }
}
