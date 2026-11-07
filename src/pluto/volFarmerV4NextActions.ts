import { alwaysHoldsTheStock } from "../backtest/backtestTypes.js";
import { sharesPerContract } from "../backtest/engine/backtestBook.js";
import { runVolFarmerV4Steps, volFarmerV2StepAtLook, volFarmerV4BreakEven, volFarmerV4LeapsEntryPriceCap, type VolFarmerV4Book, type VolFarmerV4Market, type VolFarmerV4SymbolState } from "../backtest/engine/volFarmerV4Steps.js";
import { flatCommissionEstimator, flatStockCommissionEstimator } from "../lib/commissionEstimate.js";
import { formatWeekdayDayMonth } from "../lib/easternIsoDate.js";
import { formatTradePrice } from "../lib/tradeMessageFormatting.js";
import { formatWholeDollars } from "../lib/formatWholeDollars.js";
import { daysToExpiry, describeOptionContract, formatDayMonth } from "../lib/optionContractLabel.js";
import { isLastSessionBeforeWeekend } from "../lib/tradingWeek.js";
import { nextListedExpiryAfter } from "./optionQuoteBandPlan.js";
import { volFarmerV4BuyBackMinutesBeforeWindowEnd, type volFarmerV4RulesOf } from "./volFarmerV4LiveBook.js";
import type { VolFarmerV4ScreenOption, VolFarmerV4ScreenTicker } from "./volFarmerV4Screen.js";

// The Pluto screen's Vol Farmer v4 card, Next action column (approved mockup https://claude.ai/artifact/LVNUtVCEJEEwgRLj5Zuiua,
// 2026-11-05): what v4 does next on a ticker, when, and what stops it; the six actions it can take, each with its state and why.
// Pure: the loader (volFarmerV4Screen.ts) reads the inputs. Prices where v4 would trade shares come from running v4's own
// rebalancing steps at other prices, not from a formula of ours.

export type VolFarmerV4ActionState = "ready" | "working" | "waiting" | "blocked" | "not_due" | "done" | "stopped";
export type VolFarmerV4ActionKey = "sell_calls" | "sell_puts" | "buy_leaps" | "buy_shares" | "sell_shares" | "buy_back_call";

export interface VolFarmerV4ActionLine {
  key: VolFarmerV4ActionKey;
  name: string;
  state: VolFarmerV4ActionState;
  detail: string;
}

export interface VolFarmerV4NextAction {
  state: VolFarmerV4ActionState;
  text: string;
  sub: string | null;
  /** Another action that is blocked, when the headline is not it. */
  alert: string | null;
}

type Rules = ReturnType<typeof volFarmerV4RulesOf>;

export interface VolFarmerV4ShareTrade {
  price: number;
  shares: number;
}

const settledCashStandInNote = "IBKR reports no settled cash on the paper account, so the total cash stands in";

/** Where v4's rebalancing would sell shares (at or above) or buy them (at or below), and how many, while the first position holds no Call. */
export function volFarmerV4ShareTrades(input: {
  symbol: string;
  state: VolFarmerV4SymbolState;
  potDollars: number;
  freeCashDollars: number;
  stockPrice: number;
  rules: Rules;
  stockCommissionDollars: (shares: number) => number;
}): { sellAtOrAbove: VolFarmerV4ShareTrade | null; buyAtOrBelow: VolFarmerV4ShareTrade | null } {
  const { rules, state: heldState } = input;
  if (heldState.first === null || heldState.first.shares <= 0) return { sellAtOrAbove: null, buyAtOrBelow: null };
  // The rebalancing runs on a day the steps sell no option (a day with no expiry): the same code a Call-free first position meets.
  const v3 = { ...rules.v3, optionsExpiry: "today" as const };
  const run = (price: number): { sold: number; bought: number } => {
    const state = structuredClone(heldState);
    for (const position of [state.first, state.second]) if (position !== null) position.calls = [];
    let sold = 0;
    let bought = 0;
    const book = {
      isFlat: () => false,
      freeCash: () => input.freeCashDollars,
      potForNewCycle: () => input.potDollars,
      leapsCapBaseDollars: () => input.potDollars,
      openOptionContracts: () => [],
      leg: () => undefined,
      sellCoveredCall: () => "unused",
      sellCashSecuredPut: () => "unused",
      buyLeaps: () => "unused",
      sellLeaps: () => {},
      buyShares: (order: { shares: number }) => void (bought += order.shares),
      sellShares: (order: { shares: number }) => void (sold += order.shares),
      notePositionPnl: () => {},
    } as unknown as VolFarmerV4Book;
    const market = {
      symbol: input.symbol,
      todayIso: "2026-01-01",
      stockPrice: price,
      riskFreeRate: 0.04,
      quotes: [],
      forwardAnchors: new Map(),
      previousSessionVolumeByContract: null,
      salesSizeLimit: "none",
      yearsToTodaysClose: 0,
      yearsToExpiry: () => 1,
      leapsCallQuotes: undefined,
      stepImpliedVolatility: () => null,
      tradingSessionsThrough: () => 1,
      priceToCycleScale: 1,
      optionContractsRepresentable: true,
      commissions: { option: flatCommissionEstimator, stock: flatStockCommissionEstimator },
      optionCommissionDollars: () => 0,
      stockCommissionDollars: input.stockCommissionDollars,
      leapsCapBaseLabel: "its share of the account",
      capsLeapsAtAskSize: false,
      expiryEndsToday: false,
    } as unknown as VolFarmerV4Market;
    runVolFarmerV4Steps({ state, market, farmer: rules.farmer, v2: rules.v2, v3, book });
    return { sold, bought };
  };
  // The first price a half-percent step further out at which the steps trade, refined to the cent.
  const search = (direction: 1 | -1, kind: "sold" | "bought"): VolFarmerV4ShareTrade | null => {
    let previous = input.stockPrice;
    for (let step = 1; step <= 400; step++) {
      const price = Math.round(input.stockPrice * (1 + direction * 0.005 * step) * 100) / 100;
      if (!(price > 0)) return null;
      if (run(price)[kind] > 0) {
        let withoutTrade = previous;
        let withTrade = price;
        for (let round = 0; round < 40 && Math.abs(withTrade - withoutTrade) > 0.0051; round++) {
          const middle = (withTrade + withoutTrade) / 2;
          if (run(middle)[kind] > 0) withTrade = middle;
          else withoutTrade = middle;
        }
        const trigger = direction === 1 ? Math.ceil(withTrade * 100) / 100 : Math.floor(withTrade * 100) / 100;
        return { price: trigger, shares: run(trigger)[kind] };
      }
      previous = price;
    }
    return null;
  };
  return { sellAtOrAbove: search(1, "sold"), buyAtOrBelow: search(-1, "bought") };
}

export interface VolFarmerV4NextActionsInput {
  ticker: Pick<VolFarmerV4ScreenTicker, "symbol" | "waiting" | "first" | "second" | "leaps" | "workingOrders" | "lastRoundNotes" | "lastRoundFigures">;
  state: VolFarmerV4SymbolState | null;
  rules: Rules;
  todayIso: string;
  /** A session today and the window's end not yet reached: a Call sold now would expire at today's close. */
  windowOpenToday: boolean;
  /** Pluto off, paused or a breaker tripped (describePlutoBlock): its words. */
  blockReason: string | null;
  /** The stored chain's expiries, YYYYMMDD. */
  expirations: readonly string[];
  /** The trading days from today on, ascending (ISO). */
  openDays: readonly string[];
  caps: { ordersTodayTicker: number; ordersTodayBook: number; maxPerTicker: number; maxPerDay: number };
  stockPrice: number | null;
  stockCommissionDollars: (shares: number) => number;
  stepImpliedVolatility: number | null;
}

/** An action line as built here: what it says as the headline, and why. `detail` is its line in the All actions list. */
interface BuiltLine extends VolFarmerV4ActionLine {
  headline: string;
  sub: string | null;
  /** How a blocked line reads in the headline's alert. */
  alertText?: string;
}

const lotsLabel = (lots: number) => `${lots} ${lots === 1 ? "lot" : "lots"}`;
const optionLabel = (option: { strike: number; expiry: string }, right: "C" | "P", todayIso: string) => describeOptionContract({ strike: option.strike, right, expiry: option.expiry, dte: daysToExpiry(option.expiry, todayIso) });
const shortContract = (option: { strike: number }, right: "C" | "P") => `$${option.strike} ${right === "C" ? "Call" : "Put"}`;
const isoOfExpiry = (expiry: string) => (/^\d{8}$/.test(expiry) ? `${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}` : expiry);

function workingOrderText(order: VolFarmerV4ScreenTicker["workingOrders"][number], todayIso: string): string {
  const contract = (right: "C" | "P") => optionLabel(order, right, todayIso);
  switch (order.kind) {
    case "covered_call": return `Sell ${order.contracts} × ${contract("C")}`;
    case "cash_secured_put": return `Sell ${order.contracts} × ${contract("P")}`;
    case "buy_leaps": return `Buy ${order.contracts} × ${contract("C")} (LEAPS)`;
    case "sell_leaps": return `Sell ${order.contracts} × ${contract("C")} (LEAPS)`;
    case "buy_back_call": return `Buy back ${order.contracts} × ${contract("C")}`;
    case "buy_shares": return `Buy ${order.shares ?? 0} shares`;
    case "sell_shares": return `Sell ${order.shares ?? 0} shares`;
  }
}

export function describeVolFarmerV4NextActions(input: VolFarmerV4NextActionsInput): { nextAction: VolFarmerV4NextAction; actions: VolFarmerV4ActionLine[] } {
  const { ticker, state, rules, todayIso } = input;
  const symbol = ticker.symbol;
  const notes = ticker.lastRoundNotes.filter((note) => note !== settledCashStandInNote);
  if (state === null || ticker.waiting) {
    return { nextAction: { state: "not_due", text: "Waiting to adopt its holdings", sub: notes[0] ?? null, alert: null }, actions: [] };
  }
  const figures = ticker.lastRoundFigures;
  const first = ticker.first;
  const second = ticker.second;
  const heldShares = (first?.shares ?? 0) + (second?.shares ?? 0);
  const lotsOf = (position: { shares: number } | null) => (position === null ? 0 : Math.floor(position.shares / sharesPerContract + 1e-9));
  const totalLots = lotsOf(first) + lotsOf(second);
  const openCalls = [...(first?.calls ?? []), ...(second?.calls ?? [])].filter((call) => !call.working);
  const workingCalls = ticker.workingOrders.filter((order) => order.kind === "covered_call");
  const coveringCalls = [...openCalls.map((call) => ({ expiry: call.expiry, contracts: call.contracts })), ...workingCalls.map((order) => ({ expiry: order.expiry, contracts: order.contracts }))];
  const expiryDays = [...new Set(input.expirations.map(isoOfExpiry))].sort();
  const coveredFrom = (expiry: string) => coveringCalls.filter((call) => call.expiry >= expiry).reduce((sum, call) => sum + call.contracts, 0);
  const capBlock = input.caps.ordersTodayTicker >= input.caps.maxPerTicker ? `${input.caps.ordersTodayTicker} of the ticker's ${input.caps.maxPerTicker} orders a day are sent` : input.caps.ordersTodayBook >= input.caps.maxPerDay ? `${input.caps.ordersTodayBook} of Pluto's ${input.caps.maxPerDay} orders a day are sent` : null;
  const lines: BuiltLine[] = [];
  const add = (key: VolFarmerV4ActionKey, name: string, lineState: VolFarmerV4ActionState, headline: string, sub: string | null, detail: string, alertText?: string) => void lines.push({ key, name, state: lineState, headline, sub, detail, alertText });

  // Sell Calls: the first sale day on which lots would have no Call open (a Call expiring that day still covers its lots that morning).
  let sale: { day: string; expiry: string; lots: number } | null = null;
  let noExpiryListed = false;
  if (rules.v3.optionsExpiry === "today") {
    const days = expiryDays.filter((day) => day > todayIso || (day === todayIso && input.windowOpenToday));
    noExpiryListed = days.length === 0;
    for (const day of days) {
      const lots = totalLots - coveredFrom(day);
      if (lots > 0) {
        sale = { day, expiry: day, lots };
        break;
      }
    }
  } else {
    const day = input.windowOpenToday ? todayIso : (input.openDays.find((openDay) => openDay > todayIso) ?? null);
    const expiry = day === null ? null : nextListedExpiryAfter(input.expirations, day);
    noExpiryListed = expiry === null;
    const lots = expiry === null ? 0 : totalLots - coveredFrom(expiry);
    if (day !== null && expiry !== null && lots > 0) sale = { day, expiry, lots };
  }
  const workingCall = workingCalls[0];
  if (totalLots === 0) {
    const reason = heldShares > 0 ? "Holds less than one lot." : "Holds no shares.";
    add("sell_calls", "Sell Calls", "not_due", "No Call to sell", reason, reason);
  } else if (workingCall !== undefined) {
    add("sell_calls", "Sell Calls", "working", workingOrderText(workingCall, todayIso), "order working", `${workingOrderText(workingCall, todayIso)} · order working`);
  } else if (noExpiryListed) {
    add("sell_calls", "Sell Calls", "waiting", "Sell Calls", "no Call expiry is listed in the stored chain", "No Call expiry is listed in the stored chain.");
  } else if (sale === null) {
    const covered = `Calls cover all ${totalLots} lots`;
    add("sell_calls", "Sell Calls", "done", covered, openCalls.map((call) => `${shortContract(call, "C")} · ${call.contracts}×`).join(", "), `${covered}: ${openCalls.map((call) => `${shortContract(call, "C")} · ${call.contracts}×`).join(", ")}.`);
  } else if (sale.day === todayIso) {
    const headline = `Sell Calls on ${lotsLabel(sale.lots)}`;
    const noteReason = notes.find((note) => /(^|: |; )no Call\b/.test(note));
    if (capBlock !== null) add("sell_calls", "Sell Calls", "blocked", headline, capBlock, `${headline}: ${capBlock}`, `Sell Calls blocked: ${capBlock}`);
    else if (noteReason !== undefined) add("sell_calls", "Sell Calls", "waiting", headline, noteReason, `${headline}: ${noteReason}`);
    else add("sell_calls", "Sell Calls", "ready", headline, "sending at the next quote", `${headline} · sending at the next quote`);
  } else {
    const headline = `Sell Calls on ${lotsLabel(sale.lots)}`;
    const skipped = input.openDays.filter((day) => day >= todayIso && day < sale!.day && !expiryDays.includes(day));
    const reasons: string[] = [];
    const expiringToday = openCalls.filter((call) => call.expiry === todayIso);
    if (expiringToday.length > 0) reasons.push(`today's ${[...new Set(expiringToday.map((call) => shortContract(call, "C")))].join(" and ")} expires at the close`);
    if (rules.v3.optionsExpiry === "today" && skipped.length > 0) reasons.push(skipped.length === 1 ? `${symbol} has no expiry ${skipped[0] === todayIso ? "today" : `on ${formatWeekdayDayMonth(skipped[0]!)}`}` : `${symbol} has no expiry until ${formatWeekdayDayMonth(sale.day)}`);
    const when = `${formatWeekdayDayMonth(sale.day)} (${daysToExpiry(sale.expiry, sale.day)}DTE)`;
    add("sell_calls", "Sell Calls", "waiting", headline, [when, ...reasons].join(" · "), `${when}: ${headline}${reasons.length > 0 ? ` · ${reasons.join("; ")}` : ""}.`);
  }

  // Sell Puts.
  const putsDollars = figures === null ? null : (figures.putsDollars ?? figures.potDollars / 2);
  const openPuts = [...(first?.puts ?? []), ...(second?.puts ?? [])].filter((put) => !put.working);
  const workingPut = ticker.workingOrders.find((order) => order.kind === "cash_secured_put");
  if (workingPut !== undefined) {
    add("sell_puts", "Sell Puts", "working", workingOrderText(workingPut, todayIso), "order working", `${workingOrderText(workingPut, todayIso)} · order working`);
  } else if (figures !== null && putsDollars !== null && figures.committedDollars > figures.potDollars - putsDollars) {
    const committed = `${formatWholeDollars(figures.committedDollars)} of the ${formatWholeDollars(figures.potDollars)} pot is committed`;
    add("sell_puts", "Sell Puts", "blocked", "Sell Puts", committed, `${symbol} commits ${formatWholeDollars(figures.committedDollars)} of its ${formatWholeDollars(figures.potDollars)} pot: a v4 Put on the rest of the pot (${formatWholeDollars(putsDollars)}) would be refused by the pot check.`, `Sell Puts blocked: ${committed}`);
  } else if (openPuts.length > 0) {
    const open = openPuts.map((put) => `${shortContract(put, "P")} · ${put.contracts}×`).join(", ");
    add("sell_puts", "Sell Puts", "done", "Puts open", open, `Puts open: ${open}.`);
  } else {
    const kept = putsDollars === null ? "" : ` (${formatWholeDollars(putsDollars)} of the pot is kept for Puts)`;
    const detail = openCalls.length > 0 ? `Waits for the first position's next Call, then starts if that Call yields under ${rules.v2.putsStartCallYieldPct}% a year${kept}.` : `Starts on a day the first position needs a Call and its best Call yields under ${rules.v2.putsStartCallYieldPct}% a year${kept}.`;
    add("sell_puts", "Sell Puts", "not_due", "Sell Puts", detail, detail);
  }

  // Buy a LEAPS: once the second position holds shares, at a price half a Step under its break-even.
  const leaps = ticker.leaps;
  const workingLeaps = ticker.workingOrders.find((order) => order.kind === "buy_leaps");
  if (workingLeaps !== undefined) {
    add("buy_leaps", "Buy a LEAPS", "working", workingOrderText(workingLeaps, todayIso), "order working", `${workingOrderText(workingLeaps, todayIso)} · order working`);
  } else if (leaps !== null && leaps.heldContracts >= leaps.intendedContracts) {
    const held = `${leaps.heldContracts} ${leaps.heldContracts === 1 ? "contract" : "contracts"} held: ${shortContract(leaps, "C")} · ${leaps.expiry}`;
    add("buy_leaps", "Buy a LEAPS", "done", "LEAPS held", held, `${held}.`);
  } else if (!(second !== null && second.shares > 0)) {
    const detail = "Needs a second position holding shares. That comes from an assigned Put and no Put is open, so there is no entry price or contract yet.";
    add("buy_leaps", "Buy a LEAPS", "not_due", "Buy a LEAPS", detail, detail);
  } else {
    const step = volFarmerV2StepAtLook(rules.v2, { stepImpliedVolatility: () => input.stepImpliedVolatility });
    const secondBreakEven = state.second === null ? null : volFarmerV4BreakEven(state.second);
    const stepCap = step === null || secondBreakEven === null ? null : volFarmerV4LeapsEntryPriceCap(secondBreakEven, step.stepPct / 2);
    const expiry = expiryDays.find((day) => daysToExpiry(day, todayIso) >= rules.v2.leapsMinDte) ?? null;
    const what =
      leaps !== null
        ? `${leaps.intendedContracts - leaps.heldContracts} more of the ${shortContract(leaps, "C")} · ${leaps.expiry}`
        : expiry === null
          ? `a Call at least ${rules.v2.leapsMinDte} days out (none is listed)`
          : `the Call of ${formatDayMonth(expiry)} ${expiry.slice(0, 4)} (${daysToExpiry(expiry, todayIso)}DTE) whose |delta| is nearest ${rules.v2.leapsAbsDelta}`;
    // The contract v4 picks on the LEAPS Calls as quoted (the round's look of the day), or why there is none: real quotes only.
    const look = leaps === null ? ticker.lastRoundFigures?.leapsLook ?? null : null;
    const quoted =
      leaps !== null
        ? ""
        : look === null
          ? " The LEAPS Calls have not been quoted yet."
          : look.contract !== null && look.expiry !== null
            ? ` On the quotes of ${formatWeekdayDayMonth(look.tradingDate)} it would pick the ${describeOptionContract({ strike: look.contract.strike, right: "C", expiry: look.expiry, dte: daysToExpiry(look.expiry, todayIso) })}, bid $${formatTradePrice(look.contract.bid)}, ask $${formatTradePrice(look.contract.ask)}; it picks again when the price is reached.`
            : ` On the quotes of ${formatWeekdayDayMonth(look.tradingDate)}: ${look.reason ?? "no contract"}.`;
    if (stepCap === null) add("buy_leaps", "Buy a LEAPS", "waiting", "Buy a LEAPS", `buys ${what} once the previous session's IV gives a Step`, `Buys ${what} once the previous session's IV gives a Step.${quoted}`);
    else add("buy_leaps", "Buy a LEAPS", "waiting", `Buy a LEAPS if ${symbol} is at $${stepCap.toFixed(2)} or below`, what, `Buys ${what} if ${symbol} is at $${stepCap.toFixed(2)} or below (half a Step under the second position's break-even).${quoted}`);
  }

  // Buy and sell shares: where v4's own rebalancing would trade, while the first position has no Call open.
  const workingShares = ticker.workingOrders.find((order) => order.kind === "buy_shares" || order.kind === "sell_shares");
  const addShares = (key: "buy_shares" | "sell_shares", name: string, detail: string) => {
    if (workingShares !== undefined && workingShares.kind === key) add(key, name, "working", workingOrderText(workingShares, todayIso), "order working", `${workingOrderText(workingShares, todayIso)} · order working`);
    else add(key, name, "not_due", name, detail, detail);
  };
  if (first === null || first.shares <= 0 || figures === null || input.stockPrice === null) {
    const detail = first === null || first.shares <= 0 ? "The first position holds no shares." : "No price or round figures yet.";
    addShares("buy_shares", "Buy shares", detail);
    addShares("sell_shares", "Sell shares", detail);
  } else {
    const trades = volFarmerV4ShareTrades({ symbol, state, potDollars: figures.potDollars, freeCashDollars: figures.freeCashDollars, stockPrice: input.stockPrice, rules, stockCommissionDollars: input.stockCommissionDollars });
    const earliestCallEnd = openCalls.map((call) => call.expiry).sort()[0] ?? null;
    const from = earliestCallEnd === null ? "now: no Call is open" : `once the ${shortContract(openCalls.find((call) => call.expiry === earliestCallEnd)!, "C")} · ${formatWeekdayDayMonth(earliestCallEnd)} has expired`;
    const buy = trades.buyAtOrBelow;
    const sell = trades.sellAtOrAbove;
    addShares("buy_shares", "Buy shares", buy === null ? "No price below the band within reach." : alwaysHoldsTheStock(rules.v3, symbol) ? `Buys ${buy.shares} shares if ${symbol} is at $${buy.price.toFixed(2)} or below, ${from} (more shares at lower prices).` : `Buys shares only with a Call sold the same day (Always hold the stock is off), at $${buy.price.toFixed(2)} or below.`);
    addShares("sell_shares", "Sell shares", sell === null ? "No price above the band within reach." : `Sells ${sell.shares} shares if ${symbol} is at $${sell.price.toFixed(2)} or above, ${from} (the first position keeps one lot; more shares at higher prices).`);
  }

  // Buy back a Call: v4's setting for Calls in the money in the window's last minutes.
  const callsInTheMoney = rules.v3.callsInTheMoneyAtLastLook;
  const workingBuyBack = ticker.workingOrders.find((order) => order.kind === "buy_back_call");
  if (workingBuyBack !== undefined) {
    add("buy_back_call", "Buy back a Call", "working", workingOrderText(workingBuyBack, todayIso), "order working", `${workingOrderText(workingBuyBack, todayIso)} · order working`);
  } else if (openCalls.length === 0) {
    add("buy_back_call", "Buy back a Call", "not_due", "Buy back a Call", "No Call open.", "No Call open.");
  } else if (callsInTheMoney === "assigned") {
    const detail = "v4 lets a Call in the money be assigned (its setting).";
    add("buy_back_call", "Buy back a Call", "not_due", "Buy back a Call", detail, detail);
  } else {
    const days = input.openDays.filter((day) => day >= todayIso);
    const usable = (day: string) => day > todayIso || input.windowOpenToday;
    const buyBackDay = callsInTheMoney === "bought_back" ? (days.find(usable) ?? null) : (days.find((day, index) => usable(day) && isLastSessionBeforeWeekend(day, days[index + 1] ?? null)) ?? null);
    const target = buyBackDay === null ? null : (openCalls.filter((call) => call.expiry >= buyBackDay).sort((a, b) => a.expiry.localeCompare(b.expiry))[0] ?? null);
    if (buyBackDay === null || target === null) {
      const detail = `Not before the Calls expire: v4 buys a Call in the money back only in the last ${volFarmerV4BuyBackMinutesBeforeWindowEnd} minutes${callsInTheMoney === "bought_back_before_weekends" ? " before a weekend" : ""}${buyBackDay === null ? "" : ` (next: ${formatWeekdayDayMonth(buyBackDay)})`}.`;
      add("buy_back_call", "Buy back a Call", "not_due", "Buy back a Call", detail, detail);
    } else {
      const detail = `${formatWeekdayDayMonth(buyBackDay)}, last ${volFarmerV4BuyBackMinutesBeforeWindowEnd} minutes: the ${shortContract(target, "C")} · ${formatWeekdayDayMonth(target.expiry)} is bought back if it is in the money.`;
      add("buy_back_call", "Buy back a Call", "waiting", `Buy back the ${shortContract(target, "C")} on ${formatWeekdayDayMonth(buyBackDay)}`, detail, detail);
    }
  }

  return { nextAction: chooseHeadline({ lines, input, notes, symbol }), actions: lines.map(({ key, name, state: lineState, detail }) => ({ key, name, state: lineState, detail })) };
}

const headlineOrder: VolFarmerV4ActionKey[] = ["sell_calls", "sell_puts", "sell_shares", "buy_shares", "buy_leaps", "buy_back_call"];

function chooseHeadline(context: { lines: BuiltLine[]; input: VolFarmerV4NextActionsInput; notes: string[]; symbol: string }): VolFarmerV4NextAction {
  const { lines, input, symbol } = context;
  if (input.blockReason !== null) return { state: "stopped", text: input.blockReason, sub: null, alert: null };
  const stoppedNote = context.notes.find((note) => /Pluto stops on it until a person looks/.test(note));
  if (stoppedNote !== undefined) return { state: "stopped", text: `${symbol} is stopped`, sub: stoppedNote, alert: null };
  const byKey = new Map(lines.map((line) => [line.key, line]));
  const chosen = lines.find((line) => line.state === "working") ?? headlineOrder.map((key) => byKey.get(key)!).find((line) => line.state === "ready" || line.state === "waiting" || line.state === "blocked");
  const alertLine = lines.find((line) => line.state === "blocked" && line !== chosen);
  const alert = alertLine?.alertText ?? null;
  if (chosen === undefined) {
    const calls = byKey.get("sell_calls");
    return { state: calls?.state === "done" ? "done" : "not_due", text: "Nothing due", sub: calls?.detail ?? null, alert };
  }
  return { state: chosen.state, text: chosen.headline, sub: chosen.sub, alert };
}
