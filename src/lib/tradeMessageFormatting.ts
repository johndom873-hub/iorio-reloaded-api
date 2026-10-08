// Plain-text pieces shared by every Telegram message that describes a trade: Genosuke's order follow-up, the trading-events
// catch-all (orderTelegramNotices.ts, positionTelegramNotices.ts) and Genosuke's confirmation cards.

import { easternIsoDate } from "./easternIsoDate.js";
import { daysToExpiry, describeOptionContract, formatDayMonth, formatStrike } from "./optionContractLabel.js";

const strategyLabels: Record<string, string> = {
  covered_call: "covered call",
  cash_secured_put: "cash-secured put",
  hedge: "hedge",
  unstructured: "unstructured",
};

export function labelStrategy(strategyKey: string): string {
  return strategyLabels[strategyKey] ?? strategyKey;
}

/** IBKR-style YYYYMMDD or a full ISO timestamp -> ISO YYYY-MM-DD; anything else passes through unchanged. */
export function toIsoExpiry(expiry: string): string {
  if (/^\d{8}$/.test(expiry)) return `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}T/.test(expiry)) return expiry.slice(0, 10);
  return expiry;
}

/** A per-share or per-contract price as brokers quote it: always two decimals. */
export function formatTradePrice(price: number): string {
  return price.toFixed(2);
}

export interface TradeLineContract {
  legType: "stock" | "option";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  /** YYYY-MM-DD or YYYYMMDD. */
  expiryDate: string | null;
}

/**
 * The platform's contract wording without the symbol (the message's headline names it): "$180 Put · 17 Oct (9DTE) · 1×",
 * or "100 shares". DTE counts from `todayIso` and is left out once the expiry has passed.
 */
export function describeTradeContract(contract: TradeLineContract, todayIso = easternIsoDate(new Date())): string {
  if (contract.legType === "stock") return `${contract.quantity} shares`;
  const right = contract.optionType ?? "put";
  const expiry = contract.expiryDate ? toIsoExpiry(contract.expiryDate) : null;
  const readableExpiry = expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry : null;
  const dte = readableExpiry ? daysToExpiry(readableExpiry, todayIso) : null;
  if (contract.strikePrice !== null && readableExpiry) return `${describeOptionContract({ strike: contract.strikePrice, right, expiry: readableExpiry, dte: dte !== null && dte >= 0 ? dte : null })} · ${contract.quantity}×`;
  // A leg missing its strike or a readable expiry: what is known, in the same order.
  const date = readableExpiry ? ` · ${formatDayMonth(readableExpiry)}` : expiry ? ` · ${expiry}` : "";
  return `${contract.strikePrice === null ? "?" : formatStrike(contract.strikePrice)} ${right === "call" ? "Call" : "Put"}${date} · ${contract.quantity}×`;
}

/** "• Sell $180 Put · 17 Oct (9DTE) · 1× @ 1.25", "• Buy 100 shares @ 45.10" — a fill, or a position leg at its entry/exit price. A null price reads "price unknown". */
export function describeTradeLine(action: string, contract: TradeLineContract, price: number | null, todayIso = easternIsoDate(new Date())): string {
  const priceText = price === null ? " (price unknown)" : ` @ ${formatTradePrice(price)}`;
  return `• ${tradeVerb(action)} ${describeTradeContract(contract, todayIso)}${priceText}`;
}

/** "SELL" → "Sell", "BUY" → "Buy". */
export function tradeVerb(action: string): string {
  return action.charAt(0).toUpperCase() + action.slice(1).toLowerCase();
}
