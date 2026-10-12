// The Signals screen's "not accounted for" roadmap (mockup approved 2026-09-22). Every item
// names the measure the model does not yet use, what it is waiting on, and an ETA: progress
// from real counts where there is one, plain text otherwise. The per-ticker caveats below
// project dates from trading days (~5 per 7 calendar days, no holiday calendar). The counts
// are the only thing the store supplies; everything else is pure so it can be tested.

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
  /** Orders built from the Signals modal (order_requests.signal_snapshot set) that filled. */
  signalsOrderFills: number;
  /** λ as a percentage: the share of the half-spread friction charges (Risk & Limits spread cost). */
  spreadCostChargedPct: number;
}

export const fillsForFrictionCalibration = 50;
export const tradingDaysForMomentum = 253;
export const tradingDaysForOwnVolatilityThreshold = 377;

const calendarDaysPerTradingDay = 7 / 5;

export function addCalendarDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The calendar date by which `tradingDays` more captures will exist, starting tomorrow. */
export function projectTradingDays(todayIso: string, tradingDays: number): string {
  return addCalendarDays(todayIso, Math.ceil(Math.max(0, tradingDays) * calendarDaysPerTradingDay));
}

const afterThetaDataBacktests: RoadmapEta = { kind: "text", text: "After the ThetaData backtests" };

export function buildSignalsRoadmap(counts: RoadmapCounts): RoadmapItem[] {
  return [
    {
      id: "blend",
      title: "Delta drift and momentum do not change the rank",
      summary: "Edge Yield ranks on its own. Drift (UncompensatedShare) shows in a ticker's contract list and momentum as its own figure. The valuation assumes no price direction; momentum is not validated.",
      needs: "ThetaData backtests showing whether either one improves the outcomes of sales ranked by Edge Yield",
      status: "waiting_on_data",
      eta: afterThetaDataBacktests,
    },
    {
      id: "ratio",
      title: "Risk-adjusted ratio (Edge $ / dollar risk)",
      summary: "Computed on every candidate, used nowhere. Edge Yield ranks and half-Kelly on Edge $ sizes, which covers much of what it was for.",
      needs: "ThetaData backtests showing whether it ranks better than Edge Yield; if not, it is dropped",
      status: "waiting_on_data",
      eta: afterThetaDataBacktests,
    },
    {
      id: "earnings",
      title: "Past earnings moves stay in the volatility forecast",
      summary: "Contracts spanning a coming earnings date are excluded. The forecast (21 sessions of daily prices) still counts the last earnings reaction while it is in that window, which raises the forecast.",
      needs: "A decision on how to forecast without earnings sessions; the model review found no clear winner",
      status: "waiting_on_decision",
      eta: { kind: "text", text: "When decided" },
    },
    {
      id: "friction",
      title: `Friction charges ${counts.spreadCostChargedPct}% of the half-spread (λ = ${(counts.spreadCostChargedPct / 100).toFixed(2)})`,
      summary: "Set in Risk & Limits (spread cost). Real fills will show how much of the spread you truly pay.",
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
      title: "Sizing rests on the model's Edge $, not on proven outcomes",
      summary: "Pluto caps each sale at half-Kelly on Edge $ and a stress limit (Pluto's caps on the contract card). Kelly on the calibrated figure needs out-of-the-money history; CVaR sizing is not built.",
      needs: "ThetaData backtests for the out-of-the-money calibration, then the CVaR formula for your sign-off",
      status: "waiting_on_data",
      eta: afterThetaDataBacktests,
    },
  ];
}

/** Per-ticker caveats derived from a row's own facts (no snapshot, short history, dividend payer, stale surface). */
export interface TickerCaveatInputs {
  unscoredReason: string | null;
  dailyBarCount: number;
  /** True when there is an upcoming ex-dividend but no regular cadence could be inferred to project later ones into the forward. */
  dividendCadenceUnknown: boolean;
  /** Trading date of the volatility surface this ticker was scored on, if any. */
  snapshotDateIso: string | null;
}

export interface TickerCaveat {
  id: "no_snapshot" | "short_history" | "dividend_payer" | "stale_surface";
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
