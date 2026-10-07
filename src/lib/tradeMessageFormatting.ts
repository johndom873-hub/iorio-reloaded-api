// Plain-text pieces shared by every Telegram message that describes a trade: Genosuke's order follow-up, the trading-events
// catch-all (orderTelegramNotices.ts, positionTelegramNotices.ts) and Genosuke's confirmation cards.

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

/** "1 put $180 exp 2026-10-17" or "100 shares". */
export function describeTradeContract(contract: TradeLineContract): string {
  if (contract.legType === "stock") return `${contract.quantity} shares`;
  return `${contract.quantity} ${contract.optionType} $${contract.strikePrice} exp ${contract.expiryDate ? toIsoExpiry(contract.expiryDate) : "?"}`;
}

/** "• SELL 1 put $180 exp 2026-10-17 at 1.25" — a fill, or a position leg at its entry/exit price. A null price reads "price unknown". */
export function describeTradeLine(action: string, contract: TradeLineContract, price: number | null): string {
  const priceText = price === null ? "price unknown" : `at ${formatTradePrice(price)}`;
  return `• ${action.toUpperCase()} ${describeTradeContract(contract)} ${priceText}`;
}
