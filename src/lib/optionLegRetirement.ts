// Whether a position's option legs have all left IBKR's holdings for a reason we can
// name. A structure transition (a covered call handing its shares to a leftover-stock
// position, for example) is a close + open that cannot be undone, so it only fires on
// positive evidence: every option leg is gone AND each one either has a recorded closing
// trade or is past its expiry. A leg that vanished with neither is IBKR's held-positions
// report having a transient gap (observed around expiry/settlement), not a real change.

export interface OptionLegRetirementEvidence {
  exitAt: Date | string | null;
  expiryDate: string | null;
  hasClosingTrade: boolean;
}

export type OptionLegRetirement = "still_open" | "settled" | "ambiguous";

export function classifyOptionLegRetirement(legs: OptionLegRetirementEvidence[], todayEasternIsoDate: string): OptionLegRetirement {
  if (legs.length === 0) return "settled";
  if (legs.some((leg) => leg.exitAt === null)) return "still_open";
  const everyLegSettled = legs.every((leg) => leg.hasClosingTrade || (leg.expiryDate !== null && leg.expiryDate <= todayEasternIsoDate));
  return everyLegSettled ? "settled" : "ambiguous";
}
