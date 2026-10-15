/**
 * The average price paid for the shares held after `moves`, oldest first; null when none are left (approved by Marcelo
 * 2026-10-13, shared by the backtest's ledger and the live ladder). An acquisition (a purchase at its fill, a Put
 * assigned at its strike; commissions left out) moves it to (shares held × average + shares acquired × price) ÷ (shares
 * held + shares acquired); shares leaving (sold, or called away) do not change it; once none are held, the next
 * acquisition sets it afresh.
 *
 * Example: buy 100 at $50, buy 100 at $40 → $45; 100 called away → still $45; buy 200 at $30 → (100 × 45 + 200 × 30) ÷ 300 = $35.
 */
export function runningAverageShareCost(moves: readonly { shares: number; price: number }[]): number | null {
  let sharesHeld = 0;
  let averageCost = 0;
  for (const move of moves) {
    if (move.shares > 0) {
      averageCost = (sharesHeld * averageCost + move.shares * move.price) / (sharesHeld + move.shares);
      sharesHeld += move.shares;
    } else if ((sharesHeld += move.shares) < 1e-9) {
      sharesHeld = 0;
      averageCost = 0;
    }
  }
  return sharesHeld > 0 ? averageCost : null;
}
