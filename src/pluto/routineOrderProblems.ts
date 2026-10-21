// Routine order problems (Marcelo 2026-10-15, both strategies): an order that ends for one of these reasons is recorded as
// blocked and planned afresh at the next look, instead of tripping the order_error breaker. Anything else that rejects or
// errors an order still trips it. Matched on the error_message the worker records:
//   drifted price  the worker's limit-price check at placement (ibkrGatewayLimitPriceCheck.ts) found the limit too far
//                  from the live mid
//   missing quote  the same check had no live two-sided quote to judge the limit by, or could not read one
//   tick size      IBKR error 110: the price does not conform to the contract's minimum price variation
//   margin         IBKR error 201 (order rejected) for margin: the account's equity with loan value or available funds
//                  short of the margin the order needs
// A refusal at the order routes (HTTP 400/404/409, the order gates at confirm included) is blocked by the executor before
// any of this: no order reached the worker.

export type RoutineOrderProblem = "drifted_price" | "missing_quote" | "tick_size" | "margin";

export const routineOrderProblemLabels: Record<RoutineOrderProblem, string> = {
  drifted_price: "drifted price",
  missing_quote: "missing quote",
  tick_size: "tick size",
  margin: "margin refusal",
};

const placementPriceCheckFailed = "The order's limit price failed the live-quote check at placement";
const placementPriceCheckUnreadable = "The order's limit price could not be checked against a live quote at placement";
const ibkrErrorCode = (message: string) => Number(/^IBKR error (\d+):/.exec(message)?.[1] ?? Number.NaN);

/** Pure: the routine problem an ended order's error message names, or null when it is not one. */
export function classifyRoutineOrderProblem(errorMessage: string | null | undefined): RoutineOrderProblem | null {
  if (!errorMessage) return null;
  if (errorMessage.startsWith(placementPriceCheckUnreadable)) return "missing_quote";
  if (errorMessage.startsWith(placementPriceCheckFailed)) return /No live two-sided quote/.test(errorMessage) ? "missing_quote" : "drifted_price";
  const code = ibkrErrorCode(errorMessage);
  if (code === 110) return "tick_size";
  if (code === 201 && /margin|equity with loan|available funds/i.test(errorMessage)) return "margin";
  return null;
}
