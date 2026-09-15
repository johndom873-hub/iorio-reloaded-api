// One shared extraction point for "every strike/expiry this alert
// references" — written to trade_alerts.referenced_strikes at every
// insert/update site, read back by the option chain's must-include-strikes
// query (fetchPendingAlertStrikesByExpiry, streamTickerDetail.ts). Exists so
// a new alert-referencing feature (e.g. roll alerts driving an in-place
// order-setup panel, 2026-09-15) can't silently omit its strikes from the
// chain the way suggested_structure's per-alert-type JSON parsing did —
// every write site calls one of these two functions, so the read side never
// needs updating again when a new field starts mattering.
export interface ReferencedStrike {
  expiry: string; // YYYY-MM-DD
  strike: number;
}

export function referencedStrikesForNewTrade(candidate: { strike: number; expiry: string }): ReferencedStrike[] {
  return [{ expiry: candidate.expiry, strike: candidate.strike }];
}

export function referencedStrikesForRoll(structure: {
  closeLeg: { strike: number; expiry: string };
  replacement: { strike: number; expiry: string };
}): ReferencedStrike[] {
  return [
    { expiry: structure.closeLeg.expiry, strike: structure.closeLeg.strike },
    { expiry: structure.replacement.expiry, strike: structure.replacement.strike },
  ];
}
