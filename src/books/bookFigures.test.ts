import { describe, expect, it } from "vitest";
import { computeBookFigures, type BookFiguresInput } from "./bookFigures.js";
import { assignmentCash, fillCash } from "./bookLedger.js";

// The mockup's example (https://claude.ai/artifact/BsfaHtEXioGY52rbmVBHLr): Pluto $220,000 cash + $380,000 of positions,
// Manual $150,000 + $250,000, a $50,000 deposit waiting, 5% min cash reserve.
const mockupInput: BookFiguresInput = {
  ledgerCash: { pluto: 220_000, manual: 150_000, unallocated: 50_000 },
  provisionalCash: { pluto: 0, manual: 0 },
  unsettledSaleProceeds: { pluto: 0, manual: 0 },
  positionsValue: { pluto: 380_000, manual: 250_000 },
  heldAgainstPuts: { pluto: 80_000, manual: 60_000 },
  ordersWorking: { pluto: 0, manual: 5_000 },
  minCashReservePct: 5,
  ibkrTotalCash: 420_000,
  ibkrSettledCash: 420_000,
};

describe("computeBookFigures", () => {
  it("gives the mockup's figures: Pluto $110,000 available, Manual $65,000", () => {
    const { books, cashGapAgainstIbkr } = computeBookFigures(mockupInput);
    expect(books.pluto).toMatchObject({ cash: 220_000, bookValue: 600_000, minCashReserve: 30_000, availableCash: 110_000, availableSettledCash: 110_000, limitedByAccountCash: false });
    expect(books.manual).toMatchObject({ cash: 150_000, bookValue: 400_000, minCashReserve: 20_000, availableCash: 65_000, limitedByAccountCash: false });
    expect(cashGapAgainstIbkr).toBe(0);
  });

  it("limits a book to IBKR's cash less the other book's when its own ledger runs ahead (an assignment not seen yet)", () => {
    const { books, cashGapAgainstIbkr } = computeBookFigures({ ...mockupInput, ledgerCash: { pluto: 220_000, manual: 150_000, unallocated: 0 }, ibkrTotalCash: 360_000, ibkrSettledCash: 360_000 });
    // Pluto may use 360,000 − 150,000 = 210,000 of cash, not its ledger's 220,000.
    expect(books.pluto.limitedByAccountCash).toBe(true);
    expect(books.pluto.availableCash).toBe(210_000 - 80_000 - 30_000);
    // Manual is untouched: 360,000 − 220,000 = 140,000 is less than its 150,000, so it is held too (errs towards blocking).
    expect(books.manual.availableCash).toBe(140_000 - 60_000 - 5_000 - 20_000);
    expect(cashGapAgainstIbkr).toBe(-10_000);
  });

  it("adds cash moved since the statement and keeps unsettled sale proceeds out of settled cash", () => {
    const { books } = computeBookFigures({ ...mockupInput, provisionalCash: { pluto: 2_000, manual: 0 }, unsettledSaleProceeds: { pluto: 2_000, manual: 0 }, ibkrTotalCash: 422_000, ibkrSettledCash: 420_000 });
    expect(books.pluto.cash).toBe(222_000);
    expect(books.pluto.availableSettledCash).toBe(220_000 - 80_000 - (5 / 100) * 602_000);
  });

  it("leaves available cash unknown (orders blocked) when IBKR's cash is unknown", () => {
    const { books, cashGapAgainstIbkr } = computeBookFigures({ ...mockupInput, ibkrTotalCash: null, ibkrSettledCash: null });
    expect(books.pluto.availableCash).toBeNull();
    expect(books.manual.availableSettledCash).toBeNull();
    expect(cashGapAgainstIbkr).toBeNull();
  });
});

describe("provisional cash", () => {
  it("prices a fill net of commission", () => {
    expect(fillCash({ side: "sell", quantity: 2, price: 1.2, multiplier: 100, commission: 1.3 })).toBeCloseTo(238.7, 9);
    expect(fillCash({ side: "buy", quantity: 100, price: 162.4, multiplier: 1, commission: null })).toBeCloseTo(-16_240, 9);
  });

  it("prices an assignment at the strike: a short Put buys the shares, a short Call sells them", () => {
    expect(assignmentCash({ side: "short", optionType: "put", strike: 150, multiplier: 100, quantity: 1 })).toBe(-15_000);
    expect(assignmentCash({ side: "short", optionType: "call", strike: 170, multiplier: 100, quantity: 2 })).toBe(34_000);
    expect(assignmentCash({ side: "long", optionType: "put", strike: 90, multiplier: 100, quantity: 1 })).toBe(9_000);
  });
});
