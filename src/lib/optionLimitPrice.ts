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
