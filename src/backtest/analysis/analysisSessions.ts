import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import type { BacktestMetrics, BacktestSettings, BacktestSettingsOverrides } from "../backtestTypes.js";

// The Analyse window's Backtest results: every finished session of two years or more on the ticker alone, with the
// decision maker it ran, its metrics, buy and hold's, and Excess Calmar; best CAGR first (the v4 mockup, approved by
// Marcelo 2026-11-01).

/** Sessions shorter than this many calendar days are left out: too short to judge a strategy on. */
export const analysisSessionMinimumDays = 730;

export interface AnalysisSessionRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  decisionMaker: BacktestSettings["decisionMaker"];
  startingValue: number;
  cagr: number;
  maxDrawdown: number;
  totalReturn: number;
  buyAndHoldCagr: number | null;
  buyAndHoldMaxDrawdown: number | null;
  /** (CAGR − T-bill CAGR) ÷ |Max drawdown|; null with no drawdown. */
  excessCalmar: number | null;
  /** The T-bill CAGR over the session's period, and buy and hold's Excess Calmar on it (null with no drawdown or no buy and hold). */
  treasuryBillCagr: number;
  buyAndHoldExcessCalmar: number | null;
  /** The engine version the session ran on (backtestEngineVersion); null: before versions were recorded. */
  engineVersion: number | null;
  createdAt: string;
  /** An analysis's own backtest or trial (its name starts "Analysis"). */
  isAnalysis: boolean;
}

const addCalendarDays = (dateIso: string, days: number) => new Date(Date.parse(`${dateIso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (fromIso: string, toIso: string) => (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000;

/**
 * T-bill CAGR over a period: an all-cash account credited as the engine credits interest (cash × the latest rate on or
 * before the day × calendar days since the previous weekday ÷ 365), compounded over the weekdays, as a CAGR on calendar
 * days ÷ 365.25.
 */
export function treasuryBillCagr(rates: TreasuryBillRates, startIso: string, endIso: string): number {
  let value = 1;
  let previous = startIso;
  for (let day = addCalendarDays(startIso, 1); day <= endIso; day = addCalendarDays(day, 1)) {
    if ([0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay())) continue;
    value *= 1 + ((rates.ratePercentOnOrBefore(day) ?? 0) / 100) * (daysBetween(previous, day) / 365);
    previous = day;
  }
  const calendarDays = daysBetween(startIso, endIso);
  return calendarDays > 0 ? value ** (365.25 / calendarDays) - 1 : 0;
}

/** Excess Calmar = (CAGR − the period's T-bill CAGR) ÷ |Max drawdown|; null with no drawdown. */
export function excessCalmarOf(cagr: number, maxDrawdown: number, treasuryBillCagrOverPeriod: number): number | null {
  return maxDrawdown === 0 ? null : (cagr - treasuryBillCagrOverPeriod) / Math.abs(maxDrawdown);
}

export async function listAnalysisSessions(symbol: string, connection: Knex = db): Promise<AnalysisSessionRow[]> {
  const rows: {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    settings_snapshot: BacktestSettings;
    overrides: BacktestSettingsOverrides;
    metrics: BacktestMetrics;
    baseline_metrics: BacktestMetrics | null;
    created_at: Date;
    starting_value: string;
    engine_version: number | null;
  }[] = await connection("backtest_sessions")
    .where({ status: "succeeded" })
    .whereNotNull("metrics")
    .where((inner) => inner.whereRaw("symbols = ?::jsonb", [JSON.stringify([symbol])]).orWhere((single) => single.whereNull("symbols").where("symbol", symbol)))
    .whereRaw("end_date - start_date >= ?", [analysisSessionMinimumDays])
    .select("id", "name", connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "settings_snapshot", "overrides", "metrics", "baseline_metrics", "created_at", "starting_value", "engine_version");
  if (rows.length === 0) return [];
  const firstStart = rows.reduce((earliest, row) => (row.start_date < earliest ? row.start_date : earliest), rows[0]!.start_date);
  const lastEnd = rows.reduce((latest, row) => (row.end_date > latest ? row.end_date : latest), rows[0]!.end_date);
  const rates = await loadTreasuryBillRates(requireBacktestDataDirectory(), firstStart, lastEnd);
  const cashCagrByPeriod = new Map<string, number>();
  return rows
    .map((row) => {
      const effective = applyBacktestOverrides(row.settings_snapshot, row.overrides ?? {});
      const period = `${row.start_date}|${row.end_date}`;
      const cashCagr = cashCagrByPeriod.get(period) ?? cashCagrByPeriod.set(period, treasuryBillCagr(rates, row.start_date, row.end_date)).get(period)!;
      const maxDrawdown = Number(row.metrics.maxDrawdown);
      const buyAndHoldMaxDrawdown = row.baseline_metrics ? Number(row.baseline_metrics.maxDrawdown) : null;
      return {
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        decisionMaker: effective.decisionMaker,
        startingValue: Number(row.starting_value),
        cagr: Number(row.metrics.cagr),
        maxDrawdown,
        totalReturn: Number(row.metrics.totalReturn),
        buyAndHoldCagr: row.baseline_metrics ? Number(row.baseline_metrics.cagr) : null,
        buyAndHoldMaxDrawdown,
        excessCalmar: excessCalmarOf(Number(row.metrics.cagr), maxDrawdown, cashCagr),
        treasuryBillCagr: cashCagr,
        buyAndHoldExcessCalmar: row.baseline_metrics ? excessCalmarOf(Number(row.baseline_metrics.cagr), buyAndHoldMaxDrawdown!, cashCagr) : null,
        engineVersion: row.engine_version,
        createdAt: new Date(row.created_at).toISOString(),
        isAnalysis: row.name.startsWith("Analysis"),
      };
    })
    .sort((a, b) => b.cagr - a.cagr);
}
