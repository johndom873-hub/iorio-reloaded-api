// Telegram message for a position that fully closed via option expiry (see
// ibkrGatewayWorker.ts's reconcilePositionsFromIbkr — the "no closing trade
// found, past expiry" path, which is the only trigger for this message).
// Plain-text style matching formatTradeAlertMessage.ts, not HTML tags —
// notifyTelegram HTML-escapes the whole message before sending.
export interface PositionExpiredLegSummary {
  legType: "stock" | "option";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
}

const strategyLabels: Record<string, string> = {
  covered_call: "Covered Call",
  cash_secured_put: "Cash-Secured Put",
};

function formatStrike(strikePrice: number): string {
  return Number.isInteger(strikePrice) ? strikePrice.toFixed(0) : strikePrice.toFixed(2);
}

function formatStructureLine(legs: PositionExpiredLegSummary[]): string {
  return legs
    .map((leg) => {
      const sideLabel = leg.side === "long" ? "Long" : "Short";
      if (leg.legType === "stock") return `${sideLabel} ${leg.quantity} sh`;
      const strikeLabel = leg.strikePrice !== null ? `$${formatStrike(leg.strikePrice)}` : "—";
      const rightLabel = leg.optionType === "call" ? "C" : "P";
      return `${sideLabel} ${leg.quantity}x ${strikeLabel}${rightLabel}`;
    })
    .join(" / ");
}

function formatSigned(amount: number, decimalPlaces: number, suffix: string): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${suffix === "%" ? "" : "$"}${Math.abs(amount).toFixed(decimalPlaces)}${suffix === "%" ? "%" : ""}`;
}

export function formatPositionExpiredMessage(input: {
  symbol: string;
  strategyKey: "covered_call" | "cash_secured_put";
  legs: PositionExpiredLegSummary[];
  realizedPnl: number;
  realizedPnlPercent: number | null;
  assigned: boolean;
}): string {
  const { symbol, strategyKey, legs, realizedPnl, realizedPnlPercent, assigned } = input;
  const emoji = realizedPnl >= 0 ? "✅" : "🔴";
  const assignmentLabel = assigned
    ? strategyKey === "covered_call"
      ? "assigned — shares called away"
      : "assigned — shares put to you"
    : "expired worthless — no assignment";
  const pnlLine =
    realizedPnlPercent === null
      ? `Realized P&L: ${formatSigned(realizedPnl, 2, "$")}`
      : `Realized P&L: ${formatSigned(realizedPnl, 2, "$")} (${formatSigned(realizedPnlPercent, 2, "%")})`;

  return [
    `${emoji} ${symbol} — ${strategyLabels[strategyKey] ?? strategyKey} closed (${assignmentLabel})`,
    formatStructureLine(legs),
    pnlLine,
  ].join("\n");
}
