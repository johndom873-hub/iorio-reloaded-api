// An option order's limit price (Marcelo 2026-10-21, both of Pluto's strategies): the mid rounded to the cent, a sell up
// and a buy down, so neither gives up anything past the mid, and kept inside the bid and ask. SMART-routed US options
// accept any cent price, at or above $3.00 too (what-if on paper, 2026-10-05); IBKR refuses only a third decimal (error 110).

/** `price` to the cent: a sell rounded up, a buy down. */
export function roundOptionPriceToCent(price: number, side: "sell" | "buy"): number {
  const cents = price * 100;
  // The tolerance keeps a price already on the cent (1.15 is 114.999… cents in floating point) where it is.
  const rounded = side === "sell" ? Math.ceil(cents - 1e-6) : Math.floor(cents + 1e-6);
  return rounded / 100;
}

/** The mid to the cent, inside the market: a sell never below the mid, a buy never above it (design item 22: mid, no concession). */
export function optionMidLimitPrice(bid: number, ask: number, side: "sell" | "buy"): number {
  return Math.min(ask, Math.max(bid, roundOptionPriceToCent((bid + ask) / 2, side)));
}

// Vol Farmer v4's option price (Marcelo 2026-11-07, its Calls, Puts and buybacks, in Pluto's orders and planning and in the
// lab): a mid order on a one- or two-cent spread sat unfilled, so v4 gives up one cent past the mid, never past the bid or ask.
export const optionLimitCentsGivenUp = 1;

/**
 * The mid to the cent (optionMidLimitPrice), then one cent towards the other side, kept inside the market: a sell one cent
 * lower but not below the bid, a buy one cent higher but not above the ask. Bid 0.67 / ask 0.68 sells at 0.67; 1.49 / 1.52
 * sells at 1.50 and buys at 1.51; 2.81 / 3.15 sells at 2.97.
 */
export function optionLimitPriceGivingUpOneCent(bid: number, ask: number, side: "sell" | "buy"): number {
  const midCents = Math.round(optionMidLimitPrice(bid, ask, side) * 100);
  return side === "sell" ? Math.max(bid, (midCents - optionLimitCentsGivenUp) / 100) : Math.min(ask, (midCents + optionLimitCentsGivenUp) / 100);
}
