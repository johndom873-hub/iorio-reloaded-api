// Plain-language text for Genosuke's Yes/Cancel cards, and the leg checks that
// run before a card is sent. Pure functions (no API calls) so they're unit
// tested; the tools in financialWriteTools.ts fetch the position and pass it in.
//
// Deliberately shows only the inputs the model chose (legs, sides, limit
// prices) — never a computed net credit/P&L, since financial formulas need
// explicit sign-off before they're implemented.

export interface PositionLeg {
  id: string;
  legType: "option" | "stock";
  side: "long" | "short";
  quantity: number;
  optionType: "call" | "put" | null;
  strikePrice: number | null;
  expiryDate: string | null;
  exitAt: string | null;
}

export interface PositionForCard {
  symbol: string;
  strategyKey: string;
  status: string;
  legs: PositionLeg[];
}

const strategyLabels: Record<string, string> = {
  covered_call: "covered call",
  cash_secured_put: "cash-secured put",
  hedge: "hedge",
  unstructured: "unstructured",
};

const riskSettingLabels: [string, string][] = [
  ["delta_target_min", "Delta target min"],
  ["delta_target_max", "Delta target max"],
  ["dte_target_min", "DTE target min"],
  ["dte_target_max", "DTE target max"],
  ["max_position_pct_of_portfolio", "Max position % of portfolio"],
  ["max_aggregate_collateral_pct", "Max aggregate collateral %"],
  ["max_concentration_per_ticker_pct", "Max concentration per ticker %"],
  ["max_concentration_per_sector_pct", "Max concentration per sector %"],
  ["min_cash_reserve_pct", "Min cash reserve %"],
];

export function labelStrategy(strategyKey: string): string {
  return strategyLabels[strategyKey] ?? strategyKey;
}

/** IBKR-style YYYYMMDD -> ISO YYYY-MM-DD; anything else passes through unchanged. */
export function toIsoExpiry(expiry: string): string {
  return /^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}` : expiry;
}

function formatLimitPrice(limitPrice: unknown): string {
  const numeric = Number(limitPrice);
  return Number.isFinite(numeric) ? numeric.toFixed(2) : String(limitPrice);
}

export function describeLegContract(leg: PositionLeg): string {
  if (leg.legType === "stock") return `${leg.quantity} shares`;
  return `${leg.quantity} ${leg.optionType} $${leg.strikePrice} exp ${leg.expiryDate ? toIsoExpiry(leg.expiryDate) : "?"}`;
}

/** What closing this leg means as an order: a short leg is bought back, a long leg is sold. */
function closingVerb(leg: PositionLeg): string {
  if (leg.side === "long") return "SELL";
  return leg.legType === "option" ? "BUY BACK" : "BUY";
}

function openLegs(position: PositionForCard): PositionLeg[] {
  return position.legs.filter((leg) => !leg.exitAt);
}

function positionHeading(verb: string, position: PositionForCard): string {
  return `${verb} ${position.symbol} (${labelStrategy(position.strategyKey)})`;
}

/** Returns an error for the model (no card is sent) if the legs aren't exactly the position's open legs. */
export function validateCloseLegs(position: PositionForCard, requestedLegs: { legId: string }[]): string | null {
  if (position.status !== "open") return `Position ${position.symbol} is already closed — nothing to close.`;

  const open = openLegs(position);
  const openById = new Map(open.map((leg) => [leg.id, leg]));
  const requestedIds = new Set(requestedLegs.map((leg) => leg.legId));

  const alreadyClosedOrUnknown = [...requestedIds].filter((legId) => !openById.has(legId));
  const missingOpen = open.filter((leg) => !requestedIds.has(leg.id));
  if (alreadyClosedOrUnknown.length === 0 && missingOpen.length === 0) return null;

  const problems: string[] = [];
  if (alreadyClosedOrUnknown.length > 0) {
    problems.push(`these legs are not open (already closed/expired, or unknown): ${alreadyClosedOrUnknown.join(", ")}`);
  }
  if (missingOpen.length > 0) {
    problems.push(`these open legs were left out: ${missingOpen.map((leg) => leg.id).join(", ")}`);
  }
  const correctLegs = open.map((leg) => `${leg.id} (${leg.side} ${describeLegContract(leg)})`).join("; ");
  return `Close not sent for confirmation: ${problems.join("; ")}. A close must include exactly the position's currently-open legs (isOpen: true): ${correctLegs}. Retry with only those.`;
}

export function buildCloseCard(position: PositionForCard, requestedLegs: { legId: string; limitPrice: unknown }[]): string {
  const legsById = new Map(position.legs.map((leg) => [leg.id, leg]));
  const lines = requestedLegs.map(({ legId, limitPrice }) => {
    const leg = legsById.get(legId);
    return leg ? `• ${closingVerb(leg)} ${describeLegContract(leg)}, limit ${formatLimitPrice(limitPrice)}` : `• unknown leg ${legId}, limit ${formatLimitPrice(limitPrice)}`;
  });
  return [positionHeading("Close", position), ...lines, "One combo order, sent to IBKR immediately when you tap Yes."].join("\n");
}

export function buildRiskLimitsCard(input: Record<string, unknown>): string {
  const lines = riskSettingLabels.map(([key, label]) => `• ${label}: ${input[key]}`);
  return [`Update ${labelStrategy(String(input.strategyKey))} risk settings`, ...lines].join("\n");
}

/** Adds isOpen to each leg so the model never has to infer it from exitAt. Non-position values pass through. */
export function annotateLegOpenState<T>(value: T): T {
  if (Array.isArray(value)) return value.map(annotateLegOpenState) as T;
  if (value && typeof value === "object" && Array.isArray((value as { legs?: unknown }).legs)) {
    const position = value as unknown as { legs: { exitAt?: string | null }[] };
    return { ...position, legs: position.legs.map((leg) => ({ ...leg, isOpen: !leg.exitAt })) } as T;
  }
  return value;
}
