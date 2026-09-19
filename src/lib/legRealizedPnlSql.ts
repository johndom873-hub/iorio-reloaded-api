// Single source of truth for a closed leg's realized P&L, approved 2026-09-19
// ("P&L net of commissions"): the gross spread, minus the commissions on the
// leg's CLOSING trades. Opening commissions are deliberately not subtracted:
// IBKR reports a leg's entry_price (avgCost) already net of the opening
// commission — verified on 62 legs, entry minus fill matches the commission
// (~$93 of opening commissions are already inside P&L; subtracting them again
// would double count). Exit prices are raw fills, so closing commissions
// (trades.is_closing_trade) are the missing piece. Expiries/assignments have no
// trade row, hence no commission. A NULL commission counts as 0.
//
// Use in any query that sums realized P&L over position_legs filtered to
// `exit_price IS NOT NULL`. Previously this formula was copy-pasted into ~6
// places (positionQueries, strategyPeriodPnl x2, positionEvents).
export function legRealizedPnlSql(legAlias: string): string {
  return `(
    (${legAlias}.exit_price - ${legAlias}.entry_price) * ${legAlias}.quantity * ${legAlias}.multiplier * (CASE WHEN ${legAlias}.side = 'short' THEN -1 ELSE 1 END)
    - COALESCE((SELECT SUM(tr.commission) FROM trades tr WHERE tr.position_leg_id = ${legAlias}.id AND tr.is_closing_trade), 0)
  )`;
}
