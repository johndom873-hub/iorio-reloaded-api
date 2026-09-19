// Wheel cycles with fair strategy attribution — approved 2026-09-19 (PROGRESS.md,
// "Positions table: Price, P(Δ), P(d2), totals row" entry). Derived at read time,
// never stored. A cycle opens with the first option sold / stock held on a symbol
// and closes when the symbol is flat (no shares held, no open option legs).
//
// Stock ownership rule: a share is owned by the CC bucket while a covered call is
// open on it, else by the Unstructured bucket. Handoffs are valued at the daily
// close of the transition date; shares enter at their real cost (fill + commission,
// or the strike for an assigned put) and leave at their real proceeds (fill − commission,
// or the strike for a called-away call). Because every mark cancels between its two
// ends, the buckets always add up to the cycle's real total (checked in tests).
//
//   CSP bucket          = put premium (net of commissions) + on assignment
//                         (expiry-date close − strike) x shares  [charged, usually negative]
//   Unstructured bucket = stock P&L on shares with no call written (handed in at market)
//   CC bucket           = call premium (net) + stock P&L on covered shares
//                         (a buy-write's covered shares start at their purchase price)
//   Capital             = CSP: strike x shares of each put; the others: value of the shares
//                         when they entered the bucket. Return = bucket total / capital.
//
// Ledger inputs are the same cash flows as cycleBreakEven.ts (trades fills, ITM-at-expiry
// assignments from daily bars, option legs). A cycle whose ledger cannot be trusted is
// returned with `dataFlags` set instead of guessed: a missing expiry bar, an expiry
// within $0.05 of the strike, or ledger shares that disagree with the stock legs.

export type CycleBucket = "csp" | "unstructured" | "cc";

export interface CycleOptionLeg {
  id: string;
  positionId: string;
  side: "long" | "short";
  optionType: "call" | "put";
  strike: number;
  quantity: number;
  multiplier: number;
  entryPrice: number;
  entryAt: Date;
  exitPrice: number | null;
  exitAt: Date | null;
  /** Sum of trades.commission on this leg's closing trades (NULL counts as 0). */
  closingCommission: number;
  hasClosingTrade: boolean;
  expiryDate: string;
  /** Daily close on expiryDate, null when no bar exists. */
  expiryClose: number | null;
}

export interface CycleStockLeg {
  quantity: number;
  entryAt: Date;
  exitAt: Date | null;
}

export interface CycleStockTrade {
  at: Date;
  side: "buy" | "sell";
  quantity: number;
  price: number;
  commission: number;
}

export interface CycleInput {
  optionLegs: CycleOptionLeg[];
  stockLegs: CycleStockLeg[];
  stockTrades: CycleStockTrade[];
  /** Daily closes by ISO date (YYYY-MM-DD) in America/New_York; used for handoff valuation. */
  dailyCloses: Map<string, number>;
  /** Latest known price for marking shares still held, and the date it is from. */
  lastPrice: { date: string; price: number } | null;
  /** Unrealized premium P&L of currently open option legs keyed by position id (from the latest snapshot); absent = at credit. */
  openPositionPremiumPnl: Map<string, number>;
}

export interface BucketResult {
  premium: number;
  stock: number;
  total: number;
  capital: number;
}

export interface CycleTimelineRow {
  at: Date | null; // null = "today" mark row
  label: string;
  bucket: CycleBucket;
  premium: number;
  stock: number;
  instrument: "stock" | "option";
  /** Shares-equivalent, always positive (1 contract = 100); the label says whether it was sold, bought or handed over. */
  quantity: number;
  /** Option strike; null for stock rows. */
  strike: number | null;
  /** Underlying price: the real fill for a stock trade, else that date's daily close (the only stock price we store for option fills). */
  stockPrice: number | null;
}

interface RowMeta {
  instrument: "stock" | "option";
  quantity: number;
  strike: number | null;
  stockPrice: number | null;
}

export interface Cycle {
  startAt: Date;
  endAt: Date | null;
  status: "open" | "closed";
  buckets: Record<CycleBucket, BucketResult>;
  total: number;
  netPremium: number;
  sharesHeld: number;
  /** Cash-ledger break-even per share held (open cycles only); null when not computable. */
  breakEvenPerShare: number | null;
  timeline: CycleTimelineRow[];
  dataFlags: string[];
}

const groupingWindowMs = 120_000;
// A leg's entry_at is when the worker's reconcile pass created it, which can be minutes after the real fill
// (HOOD 2026-08-24: fills 21:44, legs 21:46), so stock fills are matched from a short lookback before the cycle start.
const fillLookbackMs = 600_000;
const marginalThreshold = 0.05;

const easternDateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
function easternIsoDate(at: Date): string {
  return easternDateFormatter.format(at);
}

function newBucket(): BucketResult {
  return { premium: 0, stock: 0, total: 0, capital: 0 };
}

interface RawEvent {
  at: number;
  kind: "buy" | "sell" | "putAssigned" | "callAssigned" | "optionOpen" | "optionClose";
  shares: number;
  price: number; // per share actual cost/proceeds incl. commission for buys/sells; strike for assignments
  fillPrice?: number; // the raw stock fill, without commission
  leg?: CycleOptionLeg;
  expiryClose?: number | null;
}

function isSettledWithoutTrade(leg: CycleOptionLeg): boolean {
  return leg.side === "short" && leg.exitAt !== null && !leg.hasClosingTrade && (leg.exitPrice === 0 || leg.exitPrice === null);
}

export function deriveCycles(input: CycleInput): Cycle[] {
  const { optionLegs, stockLegs, stockTrades, dailyCloses, lastPrice, openPositionPremiumPnl } = input;

  // 1. Boundaries from the legs (the closest thing to real holdings): flat = no stock legs open and no option legs open.
  const boundaryEvents: { at: number; sharesDelta: number; optionsDelta: number }[] = [];
  for (const leg of stockLegs) {
    boundaryEvents.push({ at: leg.entryAt.getTime(), sharesDelta: leg.quantity, optionsDelta: 0 });
    if (leg.exitAt) boundaryEvents.push({ at: leg.exitAt.getTime(), sharesDelta: -leg.quantity, optionsDelta: 0 });
  }
  for (const leg of optionLegs) {
    boundaryEvents.push({ at: leg.entryAt.getTime(), sharesDelta: 0, optionsDelta: 1 });
    if (leg.exitAt) boundaryEvents.push({ at: leg.exitAt.getTime(), sharesDelta: 0, optionsDelta: -1 });
  }
  boundaryEvents.sort((a, b) => a.at - b.at);
  const windows: { start: number; end: number | null }[] = [];
  {
    let shares = 0;
    let options = 0;
    let index = 0;
    let currentStart: number | null = null;
    while (index < boundaryEvents.length) {
      let groupEnd = index;
      while (groupEnd + 1 < boundaryEvents.length && boundaryEvents[groupEnd + 1]!.at - boundaryEvents[groupEnd]!.at <= groupingWindowMs) groupEnd += 1;
      const wasFlat = shares === 0 && options === 0;
      for (let i = index; i <= groupEnd; i += 1) {
        shares += boundaryEvents[i]!.sharesDelta;
        options += boundaryEvents[i]!.optionsDelta;
      }
      const isFlat = shares === 0 && options === 0;
      if (wasFlat && !isFlat) currentStart = boundaryEvents[index]!.at;
      if (isFlat && currentStart !== null) {
        windows.push({ start: currentStart, end: boundaryEvents[groupEnd]!.at });
        currentStart = null;
      }
      index = groupEnd + 1;
    }
    if (currentStart !== null) windows.push({ start: currentStart, end: null });
  }

  return windows.map((window) => deriveOneCycle(window, input));
}

function priceOnOrBefore(dailyCloses: Map<string, number>, isoDate: string): { price: number; exact: boolean } | null {
  const exact = dailyCloses.get(isoDate);
  if (exact !== undefined) return { price: exact, exact: true };
  let bestDate: string | null = null;
  for (const date of dailyCloses.keys()) if (date < isoDate && (bestDate === null || date > bestDate)) bestDate = date;
  return bestDate === null ? null : { price: dailyCloses.get(bestDate)!, exact: false };
}

function deriveOneCycle(window: { start: number; end: number | null }, input: CycleInput): Cycle {
  const { dailyCloses, lastPrice, openPositionPremiumPnl } = input;
  const inWindow = (at: number) => at >= window.start && (window.end === null || at <= window.end + groupingWindowMs);
  const optionLegs = input.optionLegs.filter((leg) => inWindow(leg.entryAt.getTime()));
  const stockTrades = input.stockTrades.filter((trade) => trade.at.getTime() >= window.start - fillLookbackMs && (window.end === null || trade.at.getTime() <= window.end + groupingWindowMs));
  const dataFlags: string[] = [];

  // 2. Raw event stream.
  const events: RawEvent[] = [];
  for (const trade of stockTrades) {
    const perShare = trade.side === "buy" ? (trade.quantity * trade.price + trade.commission) / trade.quantity : (trade.quantity * trade.price - trade.commission) / trade.quantity;
    events.push({ at: trade.at.getTime(), kind: trade.side === "buy" ? "buy" : "sell", shares: trade.quantity, price: perShare, fillPrice: trade.price });
  }
  for (const leg of optionLegs) {
    events.push({ at: leg.entryAt.getTime(), kind: "optionOpen", shares: leg.quantity * leg.multiplier, price: 0, leg });
    if (leg.exitAt === null) continue;
    if (isSettledWithoutTrade(leg)) {
      if (leg.expiryClose === null) {
        dataFlags.push(`no expiry-date price bar for ${leg.optionType} $${leg.strike} (${leg.expiryDate})`);
      } else {
        const inTheMoneyBy = leg.optionType === "call" ? leg.expiryClose - leg.strike : leg.strike - leg.expiryClose;
        if (inTheMoneyBy > 0 && inTheMoneyBy < marginalThreshold) dataFlags.push(`${leg.optionType} $${leg.strike} (${leg.expiryDate}) expired within $${marginalThreshold} of the strike — assignment unclear`);
        else if (inTheMoneyBy >= marginalThreshold) {
          events.push({ at: leg.exitAt.getTime(), kind: leg.optionType === "put" ? "putAssigned" : "callAssigned", shares: leg.quantity * leg.multiplier, price: leg.strike, leg, expiryClose: leg.expiryClose });
        }
      }
    }
    events.push({ at: leg.exitAt.getTime(), kind: "optionClose", shares: leg.quantity * leg.multiplier, price: 0, leg });
  }
  events.sort((a, b) => a.at - b.at);

  // 3. Bookkeeping: two share pools (owner buckets) each with a reference price for the next realized mark.
  const buckets: Record<CycleBucket, BucketResult> = { csp: newBucket(), unstructured: newBucket(), cc: newBucket() };
  const timeline: CycleTimelineRow[] = [];
  const pools = { unstructured: { shares: 0, ref: 0 }, cc: { shares: 0, ref: 0 } };
  let openCallShares = 0;
  let netPremium = 0;

  const addRow = (at: number | null, label: string, bucket: CycleBucket, premium: number, stock: number, meta: RowMeta) => {
    buckets[bucket].premium += premium;
    buckets[bucket].stock += stock;
    timeline.push({ at: at === null ? null : new Date(at), label, bucket, premium, stock, ...meta });
  };
  const closeFor = (at: number): number | null => {
    // A weekend/holiday timestamp naturally values at the previous close, so that is not a data problem.
    return priceOnOrBefore(dailyCloses, easternIsoDate(new Date(at)))?.price ?? null;
  };
  const enterPool = (pool: "unstructured" | "cc", shares: number, ref: number) => {
    const target = pools[pool];
    target.ref = (target.shares * target.ref + shares * ref) / (target.shares + shares);
    target.shares += shares;
  };

  let index = 0;
  while (index < events.length) {
    let groupEnd = index;
    while (groupEnd + 1 < events.length && events[groupEnd + 1]!.at - events[groupEnd]!.at <= groupingWindowMs) groupEnd += 1;
    const group = events.slice(index, groupEnd + 1);
    const at = group[0]!.at;
    index = groupEnd + 1;
    const poolValueBefore = { cc: pools.cc.shares * pools.cc.ref, unstructured: pools.unstructured.shares * pools.unstructured.ref };

    // 3a. Disposals first: covered shares (CC pool) leave before uncovered ones.
    for (const event of group.filter((e) => e.kind === "sell" || e.kind === "callAssigned")) {
      let remaining = event.shares;
      for (const pool of ["cc", "unstructured"] as const) {
        const taken = Math.min(remaining, pools[pool].shares);
        if (taken <= 0) continue;
        const stockPnl = taken * (event.price - pools[pool].ref);
        addRow(
          event.at,
          event.kind === "sell" ? "Sold shares" : "Call assigned: shares called away at the strike",
          pool === "cc" ? "cc" : "unstructured",
          0,
          stockPnl,
          event.kind === "sell"
            ? { instrument: "stock", quantity: taken, strike: null, stockPrice: event.fillPrice ?? event.price }
            : { instrument: "option", quantity: taken, strike: event.price, stockPrice: event.expiryClose ?? null },
        );
        pools[pool].shares -= taken;
        remaining -= taken;
      }
      if (remaining > 0) dataFlags.push(`${remaining} sh sold/called away that the ledger never acquired`);
    }

    // 3b. Acquisitions enter the Unstructured pool at their real cost; an assigned put charges the CSP bucket first.
    let purchasedShares = 0;
    let purchaseCostTotal = 0;
    const groupBuys: RawEvent[] = [];
    for (const event of group.filter((e) => e.kind === "buy" || e.kind === "putAssigned")) {
      if (event.kind === "putAssigned") {
        const marketPrice = event.expiryClose!;
        addRow(event.at, "Put assigned: shares bought at the strike", "csp", 0, event.shares * (marketPrice - event.price), { instrument: "option", quantity: event.shares, strike: event.price, stockPrice: marketPrice });
        enterPool("unstructured", event.shares, marketPrice);
      } else {
        enterPool("unstructured", event.shares, event.price);
        purchasedShares += event.shares;
        purchaseCostTotal += event.shares * event.price;
        groupBuys.push(event);
      }
    }

    // 3c. Premium rows and the open-call count.
    for (const event of group.filter((e) => e.kind === "optionOpen" || e.kind === "optionClose")) {
      const leg = event.leg!;
      const bucket: CycleBucket = leg.optionType === "put" ? "csp" : "cc";
      const sign = leg.side === "short" ? 1 : -1;
      const contractShares = leg.quantity * leg.multiplier;
      const optionMeta: RowMeta = { instrument: "option", quantity: contractShares, strike: leg.strike, stockPrice: closeFor(event.at) };
      if (event.kind === "optionOpen") {
        const credit = sign * leg.entryPrice * contractShares;
        netPremium += credit;
        addRow(event.at, `${sign === 1 ? "Sold" : "Bought"} ${leg.optionType} @ ${leg.entryPrice.toFixed(2)}`, bucket, credit, 0, optionMeta);
        if (leg.optionType === "put") buckets.csp.capital += leg.strike * contractShares;
        if (leg.optionType === "call" && leg.side === "short") openCallShares += contractShares;
      } else {
        const debit = leg.exitPrice === null ? 0 : -sign * leg.exitPrice * contractShares - leg.closingCommission;
        netPremium += debit;
        if (leg.exitPrice !== null && (debit !== 0 || leg.closingCommission !== 0)) addRow(event.at, `Bought back ${leg.optionType} @ ${leg.exitPrice.toFixed(2)}`, bucket, debit, 0, optionMeta);
        if (leg.optionType === "call" && leg.side === "short") openCallShares -= contractShares;
      }
    }

    // 3d. Rebalance: covered shares belong to CC. New purchases move at their cost (buy-write), others at the day's close.
    const totalShares = pools.cc.shares + pools.unstructured.shares;
    const wantedCovered = Math.min(totalShares, Math.max(openCallShares, 0));
    const delta = wantedCovered - pools.cc.shares;
    if (delta !== 0) {
      const from: "cc" | "unstructured" = delta > 0 ? "unstructured" : "cc";
      const to: "cc" | "unstructured" = delta > 0 ? "cc" : "unstructured";
      const moved = Math.abs(delta);
      const purchaseAverage = purchasedShares > 0 ? purchaseCostTotal / purchasedShares : null;
      const useCost = delta > 0 && purchaseAverage !== null && pools.unstructured.shares - purchasedShares < moved; // moving newly bought shares
      const handoffPrice = useCost ? purchaseAverage! : closeFor(at) ?? pools[from].ref;
      const realized = moved * (handoffPrice - pools[from].ref);
      if (realized !== 0) addRow(at, `Shares handed ${from === "unstructured" ? "to CC" : "to Unstructured"}`, from === "cc" ? "cc" : "unstructured", 0, realized, { instrument: "stock", quantity: moved, strike: null, stockPrice: handoffPrice });
      pools[from].shares -= moved;
      enterPool(to, moved, handoffPrice);
    }

    // Shares bought: a row so the acquisition shows up (P&L starts at zero); owned by CC when a call covers them right away.
    for (const buy of groupBuys) {
      addRow(buy.at, "Bought shares", pools.cc.shares > 0 ? "cc" : "unstructured", 0, 0, { instrument: "stock", quantity: buy.shares, strike: null, stockPrice: buy.fillPrice ?? buy.price });
    }

    // Capital = value of shares when they entered a bucket (net of anything that left in the same step).
    for (const pool of ["cc", "unstructured"] as const) {
      const valueAfter = pools[pool].shares * pools[pool].ref;
      if (valueAfter > poolValueBefore[pool]) buckets[pool].capital += valueAfter - poolValueBefore[pool];
    }
  }

  // 4. Mark what is still held, and the open option legs.
  const sharesHeld = pools.cc.shares + pools.unstructured.shares;
  const isOpen = window.end === null;
  if (isOpen && sharesHeld > 0) {
    if (lastPrice === null) dataFlags.push("no price to mark the shares still held");
    else {
      for (const pool of ["cc", "unstructured"] as const) {
        if (pools[pool].shares > 0) addRow(null, `Marked to the ${lastPrice.date} close`, pool === "cc" ? "cc" : "unstructured", 0, pools[pool].shares * (lastPrice.price - pools[pool].ref), { instrument: "stock", quantity: pools[pool].shares, strike: null, stockPrice: lastPrice.price });
      }
    }
  }
  if (isOpen) {
    const openLegsByPosition = new Map<string, CycleOptionLeg[]>();
    for (const leg of optionLegs.filter((l) => l.exitAt === null)) openLegsByPosition.set(leg.positionId, [...(openLegsByPosition.get(leg.positionId) ?? []), leg]);
    for (const [positionId, legs] of openLegsByPosition) {
      const snapshotPremiumPnl = openPositionPremiumPnl.get(positionId);
      if (snapshotPremiumPnl === undefined) continue; // stays at credit
      const credit = legs.reduce((sum, leg) => sum + (leg.side === "short" ? 1 : -1) * leg.entryPrice * leg.quantity * leg.multiplier, 0);
      const adjustment = snapshotPremiumPnl - credit;
      const bucket: CycleBucket = legs[0]!.optionType === "put" ? "csp" : "cc";
      netPremium += adjustment;
      addRow(null, `Open ${legs[0]!.optionType} marked to market`, bucket, adjustment, 0, {
        instrument: "option",
        quantity: legs.reduce((sum, leg) => sum + leg.quantity * leg.multiplier, 0),
        strike: new Set(legs.map((leg) => leg.strike)).size === 1 ? legs[0]!.strike : null,
        stockPrice: lastPrice?.price ?? null,
      });
    }
  }

  // 5. Trust checks.
  const legShares = input.stockLegs.filter((leg) => inWindow(leg.entryAt.getTime()) && leg.exitAt === null).reduce((sum, leg) => sum + leg.quantity, 0);
  if (isOpen && sharesHeld !== legShares) dataFlags.push(`ledger says ${sharesHeld} sh held but the open stock legs total ${legShares} sh`);
  if (!isOpen && sharesHeld !== 0) dataFlags.push(`cycle closed with ${sharesHeld} sh unaccounted for in the ledger (missing fills)`);

  for (const bucket of ["csp", "unstructured", "cc"] as const) buckets[bucket].total = buckets[bucket].premium + buckets[bucket].stock;
  const total = buckets.csp.total + buckets.unstructured.total + buckets.cc.total;

  // Break-even (open cycle), pro-rata (confirmed by Marcelo 2026-09-19): (cost of every share acquired - net premium) / shares acquired,
  // with the open call counted at its credit ("if it expires worthless"), i.e. without the mark-to-market row.
  let acquisitionCost = 0;
  let sharesAcquired = 0;
  for (const trade of stockTrades) {
    if (trade.side !== "buy") continue;
    acquisitionCost += trade.quantity * trade.price + trade.commission;
    sharesAcquired += trade.quantity;
  }
  for (const event of events) {
    if (event.kind === "putAssigned") {
      acquisitionCost += event.shares * event.price;
      sharesAcquired += event.shares;
    }
  }
  const breakEvenPremium = timeline.filter((row) => !(row.at === null && row.label.startsWith("Open "))).reduce((sum, row) => sum + row.premium, 0);
  const breakEvenPerShare = isOpen && sharesHeld > 0 && sharesAcquired > 0 && dataFlags.length === 0 ? (acquisitionCost - breakEvenPremium) / sharesAcquired : null;

  return {
    startAt: new Date(window.start),
    endAt: window.end === null ? null : new Date(window.end),
    status: isOpen ? "open" : "closed",
    buckets,
    total,
    netPremium,
    sharesHeld,
    breakEvenPerShare,
    timeline,
    dataFlags: [...new Set(dataFlags)],
  };
}
