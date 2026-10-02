import { describe, expect, it } from "vitest";
import {
  buildFifoLedger,
  soldSharesEntryPrice,
  verifyLedgerAgainstIbkr,
  type LedgerSettledPut,
  type LedgerStockTrade,
} from "./stockCostBasisLedger.js";

const at = (iso: string) => new Date(iso);
let tradeCounter = 0;
function trade(side: "buy" | "sell", quantity: number, price: number, commission: number | null, executedAtIso: string): LedgerStockTrade {
  tradeCounter += 1;
  return { id: `trade-${String(tradeCounter).padStart(3, "0")}`, side, quantity, price, commission, executedAt: at(executedAtIso) };
}
const put = (strike: number, premiumPerShare: number, shares: number, exitAtIso: string): LedgerSettledPut => ({ strike, premiumPerShare, shares, exitAt: at(exitAtIso) });

function verified(verdict: ReturnType<typeof verifyLedgerAgainstIbkr>): number {
  if (!verdict.verified) throw new Error(`expected a verified ledger, got ${verdict.reason}`);
  return verdict.adjustedEntryPrice;
}

describe("verified cost basis from the trades ledger (real staging rows)", () => {
  it("COHR: 100 sh held at 327.48 plus 100 assigned at 317.50 (premium 7.3471) is reported by IBKR at 318.8219; the true cost is 322.4955", () => {
    const trades = [trade("buy", 100, 327.48, 1.0903, "2026-09-21T13:54:25Z"), trade("buy", 100, 317.5, null, "2026-09-26T01:44:46Z")];
    const ledger = buildFifoLedger(trades, [put(317.5, 7.3471, 100, "2026-09-26T01:45:31Z")]);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 200, 318.8219))).toBeCloseTo(322.4955, 3);
  });

  it("HOOD: 200 assigned at 120 (premium 1.4026) is reported at 118.5974; the true cost is exactly 120", () => {
    const ledger = buildFifoLedger([trade("buy", 200, 120, null, "2026-09-26T01:44:46Z")], [put(120, 1.4026, 200, "2026-09-26T01:45:38Z")]);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 200, 118.5974))).toBe(120);
  });

  it("COIN: four buy lots at different prices, an earlier lot sold out, are reported at one blended average that is kept exactly", () => {
    const trades = [
      trade("buy", 100, 195.67, 1.0903, "2026-09-24T15:08:32Z"),
      trade("buy", 100, 195.67, 0.0003, "2026-09-24T15:08:32Z"),
      trade("sell", 100, 194.74, 1.5489, "2026-09-28T14:06:23Z"),
      trade("sell", 100, 194.85, 0.4591, "2026-09-28T14:06:23Z"),
      trade("buy", 100, 191.63, 1.0903, "2026-09-28T15:08:41Z"),
      trade("buy", 100, 191.63, 0.0003, "2026-09-28T15:08:41Z"),
      trade("buy", 100, 193.53, 1.0903, "2026-09-29T14:30:12Z"),
      trade("buy", 100, 187.89, 1.0903, "2026-09-30T13:45:46Z"),
    ];
    const ledger = buildFifoLedger(trades, []);
    expect(ledger.shares).toBe(400);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 400, 191.1782))).toBe(191.1782);
  });

  it("a put assigned in two fills prices both at the strike, each put absorbing only its own shares", () => {
    const trades = [trade("buy", 100, 104, null, "2026-09-26T01:44:46Z"), trade("buy", 200, 104, null, "2026-09-26T01:44:47Z")];
    const ledger = buildFifoLedger(trades, [put(104, 2.5926, 300, "2026-09-26T01:45:31Z")]);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 300, 104 - 2.5926))).toBe(104);
  });

  it("two puts at different strikes assigned the same night are matched to their own fills", () => {
    const trades = [trade("buy", 100, 81, null, "2026-09-24T02:03:22Z"), trade("buy", 100, 742, null, "2026-09-24T02:03:23Z")];
    const ledger = buildFifoLedger(trades, [put(742, 2.0587, 100, "2026-09-24T02:04:00Z"), put(81, 0.0887, 100, "2026-09-24T02:04:00Z")]);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 200, (81 - 0.0887 + 742 - 2.0587) / 2))).toBeCloseTo((81 + 742) / 2, 4);
  });
});

describe("a ledger that does not reproduce IBKR's holding is never used", () => {
  const assignedTrades = [trade("buy", 100, 120, null, "2026-09-26T01:44:46Z")];
  const assignedPut = put(120, 1.4026, 100, "2026-09-26T01:45:38Z");

  it("share count differs (a trade is missing or still in flight)", () => {
    expect(verifyLedgerAgainstIbkr(buildFifoLedger(assignedTrades, [assignedPut]), 200, 118.5974)).toEqual({ verified: false, reason: "share_count" });
  });

  it("average cost differs (the account does not match lots the way the ledger assumes)", () => {
    expect(verifyLedgerAgainstIbkr(buildFifoLedger(assignedTrades, [assignedPut]), 100, 119.5)).toEqual({ verified: false, reason: "average_cost" });
  });

  it("the assignment fill is outside the put's window, so the premium is not recognised and IBKR's reported average disagrees", () => {
    const farFromPut = put(120, 1.4026, 100, "2026-09-20T01:45:38Z");
    expect(verifyLedgerAgainstIbkr(buildFifoLedger(assignedTrades, [farFromPut]), 100, 118.5974)).toEqual({ verified: false, reason: "average_cost" });
  });

  it("no trades at all (an old assignment with no recorded fill)", () => {
    expect(verifyLedgerAgainstIbkr(buildFifoLedger([], [assignedPut]), 100, 118.5974)).toEqual({ verified: false, reason: "no_ledger_shares" });
  });

  it("a sale larger than the lots held means buys are missing", () => {
    const ledger = buildFifoLedger([trade("buy", 100, 50, null, "2026-09-01T14:00:00Z"), trade("sell", 200, 51, null, "2026-09-02T14:00:00Z")], []);
    expect(verifyLedgerAgainstIbkr(ledger, 0, 0)).toEqual({ verified: false, reason: "oversold" });
  });

  it("a small commission difference (older trades with no commission recorded) is within tolerance and IBKR's own number is kept", () => {
    const ledger = buildFifoLedger([trade("buy", 100, 476.36, null, "2026-09-10T14:00:00Z")], []);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 100, 476.3609))).toBe(476.3609);
  });
});

describe("FIFO partial sales (an AAOI-shaped history: 100 sh bought, 100 assigned, the older lot sold)", () => {
  const trades = [
    trade("buy", 100, 107.65, 1.09, "2026-08-24T15:10:46Z"),
    trade("buy", 100, 107, null, "2026-08-28T01:44:46Z"),
    trade("sell", 100, 107.1, 1.35, "2026-08-31T16:51:51Z"),
  ];
  const assignedPut = put(107, 2.3468, 100, "2026-08-28T01:45:30Z");

  it("after the older lot is sold IBKR reports the remaining lot's own cost, 104.6532, and the true cost of what remains is 107", () => {
    const ledger = buildFifoLedger(trades, [assignedPut]);
    expect(verified(verifyLedgerAgainstIbkr(ledger, 100, 104.6532))).toBe(107);
  });

  it("if IBKR instead kept a flat average the ledger is not verified, so nothing is changed", () => {
    const ledger = buildFifoLedger(trades, [assignedPut]);
    expect(verifyLedgerAgainstIbkr(ledger, 100, (107.6609 + 104.6532) / 2)).toEqual({ verified: false, reason: "average_cost" });
  });

  it("the sold shares cost the older lot's 107.6609, not the 107.33 average of both lots", () => {
    const sale = trades[2]!;
    const ledger = buildFifoLedger(trades, [assignedPut], sale.executedAt);
    expect(soldSharesEntryPrice(ledger, [sale.id])).toBeCloseTo(107.6609, 4);
  });

  it("when the sold lots cost the same as the rest, the parent leg's entry is kept (null)", () => {
    const uniform = [trade("buy", 100, 50, 1, "2026-09-01T14:00:00Z"), trade("buy", 100, 50, 1, "2026-09-02T14:00:00Z"), trade("sell", 100, 52, 1, "2026-09-03T14:00:00Z")];
    const ledger = buildFifoLedger(uniform, [], uniform[2]!.executedAt);
    expect(soldSharesEntryPrice(ledger, [uniform[2]!.id])).toBeNull();
  });

  it("a sale the ledger does not know about leaves the parent's entry (null)", () => {
    const ledger = buildFifoLedger(trades, [assignedPut], trades[2]!.executedAt);
    expect(soldSharesEntryPrice(ledger, ["not-a-trade"])).toBeNull();
  });

  it("only trades up to the last sold fill count, so a later buy does not disturb the sold slice", () => {
    const withLaterBuy = [...trades, trade("buy", 100, 200, null, "2026-09-05T14:00:00Z")];
    const ledger = buildFifoLedger(withLaterBuy, [assignedPut], trades[2]!.executedAt);
    expect(ledger.shares).toBe(100);
    expect(soldSharesEntryPrice(ledger, [trades[2]!.id])).toBeCloseTo(107.6609, 4);
  });
});
