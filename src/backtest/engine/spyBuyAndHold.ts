import { computeInterestDollars } from "./backtestBook.js";

// Buy and hold of SPY, a session's second baseline, for comparison only (Marcelo 2026-10-12; docs/backtesting/FORMULAS.md):
// the starting value buys whole SPY shares at SPY's 10:00 price on the session's first day with one, the rest stays in
// cash and earns the session's interest; marked at 10:00 every session day, as the session's own account. SPY's cash
// dividends are credited on their ex-dividend dates to the shares held, kept as cash (Marcelo 2026-11-04), when SPY's
// data file has them. Until SPY has a price the whole value waits in cash.

export interface SpyBuyAndHoldDay {
  value: number;
  /** The shares' value: what the series holds in SPY. */
  exposureDollars: number;
  interestDollars: number;
}

export class SpyBuyAndHold {
  private cash: number;
  private shares = 0;
  private lastPrice: number | null = null;
  /** The purchase, once made. */
  purchase: { dateIso: string; shares: number; price: number } | null = null;
  /** Session days on which SPY had no 10:00 price of its own: marked at its last one. */
  daysMarkedAtAnEarlierPrice = 0;

  /** SPY's dividends, as paid, each credited once; null when they are not known. */
  private readonly dividends: { exDividendDate: string; amount: number; credited: boolean }[] | null;
  /** The dividends credited so far, in dollars. */
  dividendDollars = 0;

  constructor(startingValue: number, dividends: readonly { exDividendDate: string; amount: number }[] | null = null) {
    this.cash = startingValue;
    this.dividends = dividends === null ? null : dividends.map((dividend) => ({ ...dividend, credited: false }));
  }

  /** Whether SPY's dividends are known (credited) or not. */
  get countsDividends(): boolean {
    return this.dividends !== null;
  }

  /**
   * One session day: the interest on the cash since the previous session day (`ratePercent` over `calendarDays`; none
   * on the first day), the purchase on the first day with a price, and the 10:00 mark at `priceAtTen` (the last price
   * when the day has none).
   */
  markDay(dateIso: string, priceAtTen: number | null, interest: { ratePercent: number; calendarDays: number } | null): SpyBuyAndHoldDay {
    const interestDollars = interest === null ? 0 : computeInterestDollars(this.cash, interest.ratePercent, interest.calendarDays);
    this.cash += interestDollars;
    // A dividend whose ex-date has come pays the shares held since before it (none before the purchase).
    for (const dividend of this.dividends ?? []) {
      if (dividend.credited || dividend.exDividendDate > dateIso) continue;
      dividend.credited = true;
      const credited = this.shares * dividend.amount;
      this.cash += credited;
      this.dividendDollars += credited;
    }
    if (priceAtTen !== null && priceAtTen > 0) {
      if (this.purchase === null) {
        this.shares = Math.floor(this.cash / priceAtTen);
        this.cash -= this.shares * priceAtTen;
        this.purchase = { dateIso, shares: this.shares, price: priceAtTen };
      }
      this.lastPrice = priceAtTen;
    } else if (this.purchase !== null) this.daysMarkedAtAnEarlierPrice += 1;
    const exposureDollars = this.shares * (this.lastPrice ?? 0);
    return { value: this.cash + exposureDollars, exposureDollars, interestDollars };
  }
}
