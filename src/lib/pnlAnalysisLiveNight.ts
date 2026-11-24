import { db } from "../db/connection.js";
import { loadBooksLiveState } from "../books/bookFigures.js";
import type { BookKey } from "../books/bookKeys.js";
import { loadUnmatchedRecordedDeposits } from "../books/recordedDeposits.js";
import { loadSnapshotMarksBetween, type SnapshotMarks } from "./cyclePeriodPnl.js";
import { easternIsoDate, easternMinutesOfDay } from "./easternIsoDate.js";
import { createExpiringPromiseCache } from "./expiringPromiseCache.js";
import { regularOpenMinutesEt, resolveIsOpenDay } from "./marketSessionStatus.js";
import { daysToExpiry, describeOptionContract } from "./optionContractLabel.js";
import type { NightlySnapshotPrices } from "./pnlAttributionSnapshots.js";
import type { OpenLegMarketValue } from "./positionExposure.js";

// The P&L Analyser's live night (Marcelo 2026-11-24): on a trading day, from the 09:30 ET open until the nightly snapshot
// stores the day, a load adds today as one more night, taken now: the account's net liquidation value, both books' values
// and every open leg at the same live prices, which the attribution then marks the night's cycles at. Nothing is stored;
// tonight's snapshot replaces it. A leg with no live price is valued at its last nightly close (else its entry), as the
// live book values are, and named in the note. Without IBKR's account value there is no live night at all, so the three
// books always share one date.

export interface LiveNight {
  night: string;
  capturedAt: Date;
  accountNetLiquidationValue: number;
  /** Deposits recorded since the last snapshot, the nightly job's own first estimate of the day's cash flow. */
  accountCashFlow: number;
  bookValues: Record<BookKey, number>;
  /** The live prices, as the attribution reads a night's snapshot prices. */
  snapshotPrices: NightlySnapshotPrices;
  /** The last stored night's position marks: a position whose open legs are not all priced here keeps them. */
  fallbackMarks: Map<string, SnapshotMarks>;
  /** The open legs valued at their last close or entry, labelled ("SMCI $47 Call · 9 Oct (2DTE)", "SMCI shares"). */
  legsAtLastClose: string[];
}

export type LiveNightStatus = { state: "live"; liveNight: LiveNight } | { state: "unavailable"; night: string; reason: string } | { state: "notTrading" };

/** Today's night when a live one applies now (a trading day, past the open, not stored yet), with the last stored night. */
export async function liveNightWindow(now: Date): Promise<{ night: string; lastStoredNight: string; lastCapturedAt: Date } | null> {
  const night = easternIsoDate(now);
  if (easternMinutesOfDay(now) < regularOpenMinutesEt) return null;
  const [isOpenDay, latest] = await Promise.all([resolveIsOpenDay(night), db("account_pnl_snapshots").orderBy("snapshot_date", "desc").first(db.raw("snapshot_date::text AS night"), "captured_at")]);
  if (!isOpenDay || !latest || latest.night >= night) return null;
  return { night, lastStoredNight: latest.night, lastCapturedAt: new Date(latest.captured_at) };
}

/** Pure: the legs' prices as a night's snapshot prices: shares by ticker (quantity-weighted, as the nightly snapshot's), options by leg. */
export function snapshotPricesFromLegValues(legValues: readonly OpenLegMarketValue[]): NightlySnapshotPrices {
  const sharesByTickerId = new Map<string, { value: number; shares: number }>();
  const optionPriceByLegId = new Map<string, number>();
  for (const leg of legValues) {
    if (leg.legType === "option") {
      optionPriceByLegId.set(leg.legId, leg.price);
      continue;
    }
    const totals = sharesByTickerId.get(leg.tickerId) ?? { value: 0, shares: 0 };
    totals.value += leg.price * leg.quantity;
    totals.shares += leg.quantity;
    sharesByTickerId.set(leg.tickerId, totals);
  }
  const exact = new Map([...sharesByTickerId].filter(([, totals]) => totals.shares !== 0).map(([tickerId, totals]) => [tickerId, totals.value / totals.shares]));
  return { stockPriceByTickerId: { exact, implied: new Map() }, optionPriceByLegId };
}

/** Pure: the legs not at a live price, labelled once each, in order. */
export function legsAtLastCloseLabels(legValues: readonly OpenLegMarketValue[], night: string): string[] {
  const labels = legValues
    .filter((leg) => leg.priceSource !== "live")
    .map((leg) => {
      if (leg.legType === "stock" || leg.optionType === null || leg.strikePrice === null || leg.expiryDate === null) return `${leg.symbol} shares`;
      const expiryIso = `${leg.expiryDate.slice(0, 4)}-${leg.expiryDate.slice(4, 6)}-${leg.expiryDate.slice(6, 8)}`;
      return describeOptionContract({ symbol: leg.symbol, strike: leg.strikePrice, right: leg.optionType, expiry: expiryIso, dte: daysToExpiry(expiryIso, night) });
    });
  return [...new Set(labels)];
}

export async function loadLiveNightUncached(now: Date = new Date()): Promise<LiveNightStatus> {
  const window = await liveNightWindow(now);
  if (window === null) return { state: "notTrading" };
  const { night, lastStoredNight, lastCapturedAt } = window;
  const [books, recordedDeposits, marksByNight] = await Promise.all([loadBooksLiveState({ now }), loadUnmatchedRecordedDeposits(db), loadSnapshotMarksBetween(lastStoredNight, lastStoredNight)]);
  if (!books.ready) return { state: "unavailable", night, reason: "the books have not started" };
  if (books.ibkrNetLiquidationValue === null) return { state: "unavailable", night, reason: "IBKR is not answering" };
  const accountCashFlow = recordedDeposits.filter((deposit) => deposit.effectiveAt > lastCapturedAt && deposit.effectiveAt <= now).reduce((sum, deposit) => sum + deposit.amount, 0);
  return {
    state: "live",
    liveNight: {
      night,
      capturedAt: now,
      accountNetLiquidationValue: books.ibkrNetLiquidationValue,
      accountCashFlow,
      bookValues: { pluto: books.books.pluto.bookValue, manual: books.books.manual.bookValue },
      snapshotPrices: snapshotPricesFromLegValues(books.legValues),
      fallbackMarks: marksByNight.get(lastStoredNight) ?? new Map(),
      legsAtLastClose: legsAtLastCloseLabels(books.legValues, night),
    },
  };
}

// One live read kept 15 s (Marcelo 2026-11-24), so the Dashboard's cards, the Positions card and a period switch share it.
const liveNightCache = createExpiringPromiseCache<LiveNightStatus>({ ttlMs: 15_000, maxEntries: 1 });

export function loadLiveNight(): Promise<LiveNightStatus> {
  return liveNightCache.get("live", () => loadLiveNightUncached());
}
