// The Signals screen's "not accounted for" roadmap (mockup approved 2026-09-22; Marcelo
// chose computed ETAs over a static list). Every item names the measure the ranking does
// not yet use, what it is waiting on, and an ETA projected from real data counts where the
// wait is data (one capture per trading day, ~5 per 7 calendar days, no holiday calendar),
// or plain text where the wait is a decision or a later phase. The counts are the only
// thing the store supplies; everything else is pure so it can be tested.

export type RoadmapStatus = "waiting_on_data" | "waiting_on_sign_off" | "waiting_on_decision" | "waiting_on_later_phase" | "waiting_on_build" | "waiting_on_next_run";

export interface RoadmapProgress {
  have: number;
  need: number;
  unit: string;
}

export type RoadmapEta = { kind: "date"; dateIso: string; progress: RoadmapProgress } | { kind: "text"; text: string; progress?: RoadmapProgress };

export interface RoadmapItem {
  id: string;
  title: string;
  summary: string;
  needs: string;
  status: RoadmapStatus;
  eta: RoadmapEta;
}

export interface RoadmapCounts {
  /** Distinct trading dates with a complete or partial option-chain snapshot. */
  snapshotNights: number;
  /** Distinct snapshot dates that have at least one 'ok' surface slice. */
  fittedNights: number;
  /** Across shortlist tickers, the smallest number of PAST earnings dates on record. */
  minimumPastEarningsPerTicker: number;
  /** Orders built from the Signals modal (order_requests.signal_snapshot set) that filled. */
  signalsOrderFills: number;
}

export const nightsForBlending = 126; // ~6 months of trading days
export const nightsForSkewValidation = 63; // ~3 months
export const nightsForSviStability = 20; // ~4 weeks
export const quartersForEarningsAdjustment = 4;
export const fillsForFrictionCalibration = 50;
export const tradingDaysForMomentum = 253;
export const tradingDaysForOwnVolatilityThreshold = 377;

const calendarDaysPerTradingDay = 7 / 5;
const calendarDaysPerQuarter = 91;

export function addCalendarDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The calendar date by which `tradingDays` more captures will exist, starting tomorrow. */
export function projectTradingDays(todayIso: string, tradingDays: number): string {
  return addCalendarDays(todayIso, Math.ceil(Math.max(0, tradingDays) * calendarDaysPerTradingDay));
}

function nightsEta(todayIso: string, have: number, need: number): RoadmapEta {
  return { kind: "date", dateIso: projectTradingDays(todayIso, need - have), progress: { have: Math.min(have, need), need, unit: "nightly chains" } };
}

export function buildSignalsRoadmap(counts: RoadmapCounts, todayIso: string): RoadmapItem[] {
  return [
    {
      id: "blend",
      title: "UncompensatedShare and Tilt do not change the rank",
      summary: "Shown as their own columns. Blending needs weights fitted on outcomes.",
      needs: "About 6 months of nightly chains plus the outcomes of closed trades (Phase 2)",
      status: "waiting_on_data",
      eta: nightsEta(todayIso, counts.snapshotNights, nightsForBlending),
    },
    {
      id: "ratio",
      title: "Risk-adjusted ratio (Edge $ / dollar risk)",
      summary: "Formula approved and built 2026-09-23, computed on every candidate. Kept out of ranking until Phase 2 can justify a weight for it.",
      needs: "Phase 2 backtest data, same as Composite Rank's other weights",
      status: "waiting_on_later_phase",
      eta: { kind: "text", text: "Built, to be wired in Phase 2" },
    },
    {
      id: "skew",
      title: "Skew and momentum are shown, not validated",
      summary: "Both come from the literature; six tickers cannot confirm or refute them.",
      needs: "Skew: ~3 months of chains (the date shown). Momentum: a universe of hundreds of stocks, not planned, no ETA",
      status: "waiting_on_data",
      eta: nightsEta(todayIso, counts.snapshotNights, nightsForSkewValidation),
    },
    {
      id: "earnings",
      title: "Earnings not adjusted in the volatility forecast",
      summary: "Expiries spanning a known earnings date are excluded (not just flagged); the forecast itself still isn't corrected for the elevated IV.",
      needs: "Earnings-date history: the nightly calendar keeps one report date per quarter per ticker",
      status: "waiting_on_data",
      eta: {
        kind: "date",
        dateIso: addCalendarDays(todayIso, Math.max(0, quartersForEarningsAdjustment - counts.minimumPastEarningsPerTicker) * calendarDaysPerQuarter),
        progress: { have: Math.min(counts.minimumPastEarningsPerTicker, quartersForEarningsAdjustment), need: quartersForEarningsAdjustment, unit: "past earnings dates per ticker (least-covered ticker)" },
      },
    },
    {
      id: "svi",
      title: "SVI surface stability under review",
      summary: "Some slices sit on their parameter bounds; the curves fit well, the wings are the risk.",
      needs: "About 4 weeks of nightly fits",
      status: "waiting_on_data",
      eta: { kind: "date", dateIso: projectTradingDays(todayIso, nightsForSviStability - counts.fittedNights), progress: { have: Math.min(counts.fittedNights, nightsForSviStability), need: nightsForSviStability, unit: "nightly fits" } },
    },
    {
      id: "friction",
      title: "Friction assumes fills at the bid (λ = 1.0)",
      summary: "Conservative by your choice. Real fills will show how much of the spread you truly pay.",
      needs: "About 50 fills from Signals orders",
      status: "waiting_on_data",
      eta: {
        kind: "text",
        text: counts.signalsOrderFills === 0 ? "No filled Signals orders yet; ~2-3 months of use once selling starts" : `${Math.max(0, fillsForFrictionCalibration - counts.signalsOrderFills)} more fills`,
        progress: { have: Math.min(counts.signalsOrderFills, fillsForFrictionCalibration), need: fillsForFrictionCalibration, unit: "filled Signals orders" },
      },
    },
    {
      id: "sizing",
      title: "No position-size suggestion",
      summary: "Kelly / CVaR sizing.",
      needs: "Phase 2 first, then the Phase 3 formulas",
      status: "waiting_on_later_phase",
      eta: { kind: "text", text: "After Phase 2" },
    },
  ];
}

/** Per-ticker caveats derived from a row's own facts (no snapshot, suspected split, short history, dividend payer). */
export interface TickerCaveatInputs {
  unscoredReason: string | null;
  suspectedSplitDateIso: string | null;
  dailyBarCount: number;
  /** True when there is an upcoming ex-dividend but no regular cadence could be inferred to project later ones into the forward. */
  dividendCadenceUnknown: boolean;
  /** Trading date of the volatility surface this ticker was scored on, if any. */
  snapshotDateIso: string | null;
}

export interface TickerCaveat {
  id: "no_snapshot" | "suspected_split" | "short_history" | "dividend_payer" | "stale_surface";
  title: string;
  summary: string;
  needs: string;
  status: RoadmapStatus;
  eta: RoadmapEta;
}

export function buildTickerCaveats(inputs: TickerCaveatInputs, todayIso: string): TickerCaveat[] {
  const caveats: TickerCaveat[] = [];
  if (inputs.unscoredReason === "no_snapshot") {
    caveats.push({ id: "no_snapshot", title: "No option-chain snapshot yet", summary: "Nothing to fit a surface from, so no scores.", needs: "The nightly capture to run for this ticker", status: "waiting_on_data", eta: { kind: "text", text: "First night after the capture runs" } });
  }
  if (inputs.suspectedSplitDateIso !== null) {
    caveats.push({
      id: "suspected_split",
      title: `Suspected stock split on ${inputs.suspectedSplitDateIso}: no volatility forecast`,
      summary: "The stored daily prices jump across that day the way a split does, so the forecast refuses to use them and the ticker is not scored. IBKR returns split-adjusted prices on a fresh fetch.",
      needs: "Backfill history for this ticker (re-fetches five years of adjusted prices)",
      status: "waiting_on_data",
      eta: { kind: "text", text: "Scored on the next refresh after the backfill" },
    });
  }
  if (inputs.snapshotDateIso !== null && inputs.snapshotDateIso !== todayIso) {
    caveats.push({
      id: "stale_surface",
      title: `Scored on a stale surface: ${inputs.snapshotDateIso}`,
      summary: `No capture ran today; scored on the volatility surface captured on ${inputs.snapshotDateIso}, re-timed to today.`,
      needs: "Tonight's capture to run",
      status: "waiting_on_next_run",
      eta: { kind: "text", text: "Next capture" },
    });
  }
  if (inputs.dailyBarCount < tradingDaysForOwnVolatilityThreshold) {
    const momentumMissing = inputs.dailyBarCount < tradingDaysForMomentum;
    const barsForMomentum = tradingDaysForMomentum - inputs.dailyBarCount;
    const barsForThreshold = tradingDaysForOwnVolatilityThreshold - inputs.dailyBarCount;
    caveats.push({
      id: "short_history",
      title: momentumMissing ? `Momentum unavailable: ${inputs.dailyBarCount} of ${tradingDaysForMomentum} daily bars` : `Volatility flag on the fixed 1.3 threshold: ${inputs.dailyBarCount} of ${tradingDaysForOwnVolatilityThreshold} daily bars`,
      summary: momentumMissing ? `The volatility flag also uses the fixed 1.3 threshold until ${tradingDaysForOwnVolatilityThreshold} bars.` : "The ticker's own 90th-percentile threshold needs more history.",
      needs: inputs.dailyBarCount <= tradingDaysForMomentum ? "Run Backfill history on the shortlist if more history exists; otherwise more trading days" : `${barsForThreshold} more trading days`,
      status: "waiting_on_data",
      eta: { kind: "date", dateIso: projectTradingDays(todayIso, momentumMissing ? barsForMomentum : barsForThreshold), progress: { have: inputs.dailyBarCount, need: momentumMissing ? tradingDaysForMomentum : tradingDaysForOwnVolatilityThreshold, unit: "daily bars" } },
    });
  }
  if (inputs.dividendCadenceUnknown) {
    caveats.push({
      id: "dividend_payer",
      title: "Dividend payer: later dividends missing from the forward",
      summary: "No past ex-dividend on record (or an irregular gap to it), so a cadence can't be projected forward. Only the next ex-dividend is used.",
      needs: "One more observed ex-dividend cycle on record for this ticker",
      status: "waiting_on_data",
      eta: { kind: "text", text: "No ETA" },
    });
  }
  return caveats;
}
