import { EventName, OrderAction, OrderType, SecType, TimeInForce, type ComboLeg, type Contract, type IBApi, type Order } from "@stoqey/ib";
import { readExpectedAccountId } from "../lib/accountBinding.js";
import { readWhatIfCommissionRange, type WhatIfCommissionRange } from "../lib/orderCommissionPreview.js";
import { buildContractFromConId, buildLegContract, computeNetLimitPrice, type OrderLegPayload } from "./ibkrGatewayOrderPayload.js";
import { resolveContractId } from "./ibkrGatewayResolveContractId.js";
import { borrowSharedConnectionOrConnect, nextReqIdFor, sharedReadConnection } from "./sharedReadConnection.js";

// Exact commission for one order from IBKR's what-if (approved 2026-10-02, order setup only). A what-if
// order asks IBKR for the commission and margin the order WOULD cost and never works it, but it travels
// through placeOrder from the web process, so every order built here carries whatIf: true (IBKR requires
// transmit: true on a what-if and rejects it otherwise, error 321) and requestWhatIfOrderState refuses to
// send anything that is not a what-if (ibkrWhatIfCommission.test.ts pins it). Runs on the shared read connection, never the
// VPS worker's, so a web deploy ships it. The order shape mirrors ibkrGatewayWorker.ts's buildOrder
// without the Adaptive algo, which does not change the commission.

// A two-leg combo's what-if takes several seconds longer than a single leg's.
const whatIfTimeoutMs = 12_000;
const orderIdRequestTimeoutMs = 5_000;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Pure: the contract and what-if order for resolved leg conIds (one LMT order, or one BAG combo for several legs). */
export function buildWhatIfOrder(legs: OrderLegPayload[], conIds: number[], account: string): { contract: Contract; order: Order } {
  const whatIfFields = { whatIf: true, transmit: true, account } as const;
  if (legs.length === 1) {
    const leg = legs[0]!;
    return {
      contract: buildContractFromConId(leg, conIds[0]!),
      order: { action: leg.action, orderType: OrderType.LMT, lmtPrice: leg.unitPrice, totalQuantity: leg.quantity, tif: TimeInForce.DAY, ...whatIfFields },
    };
  }
  const legRatioGcd = legs.map((leg) => leg.quantity).reduce((a, b) => gcd(a, b));
  const comboLegs: ComboLeg[] = legs.map((leg, index) => ({ conId: conIds[index]!, ratio: leg.quantity / legRatioGcd, action: leg.action, exchange: "SMART" }));
  return {
    contract: { symbol: legs[0]!.symbol, secType: SecType.BAG, currency: "USD", exchange: "SMART", comboLegs },
    order: { action: OrderAction.BUY, orderType: OrderType.LMT, lmtPrice: computeNetLimitPrice(legs), totalQuantity: legRatioGcd, tif: TimeInForce.DAY, ...whatIfFields },
  };
}

// Order ids are per client id; a what-if never works an order, so these only need to be distinct among themselves on this connection.
const nextWhatIfOrderIdByConnection = new WeakMap<IBApi, number>();

async function allocateWhatIfOrderId(ib: IBApi): Promise<number> {
  const known = nextWhatIfOrderIdByConnection.get(ib);
  if (known !== undefined) {
    nextWhatIfOrderIdByConnection.set(ib, known + 1);
    return known;
  }
  const firstValidId = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      ib.off(EventName.nextValidId, onNextValidId);
      reject(new Error("IBKR did not return a valid order id."));
    }, orderIdRequestTimeoutMs);
    const onNextValidId = (orderId: number) => {
      clearTimeout(timer);
      resolve(orderId);
    };
    ib.once(EventName.nextValidId, onNextValidId);
    ib.reqIds(1);
  });
  // Another caller may have set it while this one waited: keep whichever is higher.
  const base = Math.max(firstValidId, nextWhatIfOrderIdByConnection.get(ib) ?? 0);
  nextWhatIfOrderIdByConnection.set(ib, base + 1);
  return base;
}

function requestWhatIfCommissionRange(ib: IBApi, orderId: number, contract: Contract, order: Order): Promise<WhatIfCommissionRange> {
  // The only door to placeOrder in this file: a real order must never be sent from the web process.
  if (order.whatIf !== true) throw new Error("Refusing to send a non-what-if order from the web process.");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("IBKR what-if timed out."))), whatIfTimeoutMs);
    // IBKR answers a what-if with two order states; the first only holds a placeholder commission, so keep listening until one carries the range.
    const onOpenOrder = (id: number, _contract: Contract, _order: Order, orderState: { commission?: number; minCommission?: number; maxCommission?: number }) => {
      if (id !== orderId) return;
      const range = readWhatIfCommissionRange(orderState);
      if (range) finish(() => resolve(range));
    };
    const onError = (error: Error, code: number, id: number) => {
      if (id === orderId) finish(() => reject(new Error(`IBKR what-if rejected (${code}): ${error.message}`)));
    };
    function finish(settle: () => void) {
      clearTimeout(timer);
      ib.off(EventName.openOrder, onOpenOrder);
      ib.off(EventName.error, onError);
      settle();
    }
    ib.on(EventName.openOrder, onOpenOrder);
    ib.on(EventName.error, onError);
    ib.placeOrder(orderId, contract, order);
  });
}

/** The order's commission range in dollars from IBKR's what-if; throws when IBKR cannot be reached, rejects it or sends no usable range. */
export async function fetchWhatIfCommissionRange(legs: OrderLegPayload[]): Promise<WhatIfCommissionRange> {
  const account = readExpectedAccountId();
  const connection = await borrowSharedConnectionOrConnect(sharedReadConnection, "fetchWhatIfCommissionRange");
  try {
    const conIds: number[] = [];
    for (const leg of legs) {
      const conId = leg.ibkrContractId ?? (await resolveContractId(connection.ib, buildLegContract(leg), nextReqIdFor(connection.ib, () => 90_000 + conIds.length)));
      if (conId === null) throw new Error(`IBKR could not resolve the ${leg.role} contract for ${leg.symbol}.`);
      conIds.push(conId);
    }
    const { contract, order } = buildWhatIfOrder(legs, conIds, account);
    const orderId = await allocateWhatIfOrderId(connection.ib);
    return await requestWhatIfCommissionRange(connection.ib, orderId, contract, order);
  } finally {
    connection.disconnect();
  }
}
