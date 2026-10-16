import type { Knex } from "knex";
import { db } from "../../db/connection.js";
import { requireBacktestDataDirectory } from "../backtestDataDirectory.js";
import { applyBacktestOverrides } from "../backtestSettingsOverrides.js";
import { loadTreasuryBillRates, type TreasuryBillRates } from "../engine/treasuryBillRates.js";
import type { BacktestBaselineSettings, BacktestMetrics, BacktestSettings, BacktestSettingsOverrides, BacktestSymbolSettings } from "../backtestTypes.js";

// The Analyse window's Backtest results: every finished session of two years or more whose book holds the ticker, with
// its share level, whether it ran the CC + Put Ladder, its metrics, buy-and-hold's, and Excess Calmar.

/** Sessions shorter than this many calendar days are left out: too short to judge a strategy on. */
export const analysisSessionMinimumDays = 730;

export interface AnalysisSessionRow {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  symbols: string[];
  /** The ticker's share level (%) in the session; null when the session is not the CC + Put Ladder. */
  sharesPct: number | null;
  rungs: number | null;
  /** A Covered Call entry with the reserve ladder: the CC + Put Ladder. */
  ladder: boolean;
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
  /** The ladder's values for this symbol on the CC + Put Ladder; null otherwise. */
  ladderSettings: AnalysisSessionLadderSettings | null;
  createdAt: string;
  /** The analysis's own backtest (its name starts "Analysis · "). */
  isAnalysis: boolean;
}

/** A CC + Put Ladder session's values for one symbol, in the analysis window's terms. */
export interface AnalysisSessionLadderSettings {
  /** The ticker's pot: the session's starting value with one ticker, else its own pot; null when unknown. */
  potDollars: number | null;
  ladderSharesPct: number;
  ladderRungs: number;
  /** Null: the rule (the stock's Max drawdown kept in its range); else the fixed shock, percent. */
  ladderShockPct: number | null;
  /** The Calls' |delta| range. */
  callsAbsDelta: [number, number];
  /** The ladder Puts' |delta| range; "none": any |delta|. */
  putsAbsDelta: [number, number] | "none";
  minDte: number;
  maxDte: number;
  maxSpreadPctOfMid: number;
  ladderPutVersusCall: BacktestBaselineSettings["ladderPutVersusCall"];
}

/** Pure: a ladder baseline's values in the window's terms. */
export function ladderSettingsOf(baseline: BacktestBaselineSettings, potDollars: number | null): AnalysisSessionLadderSettings {
  const callsOwn = baseline.callDeltaRange === "own_range";
  return {
    potDollars,
    ladderSharesPct: baseline.ladderSharesPct,
    ladderRungs: baseline.ladderRungs,
    ladderShockPct: baseline.ladderShock === "fixed" ? baseline.ladderShockPct : null,
    callsAbsDelta: callsOwn ? [baseline.callMinAbsDelta, baseline.callMaxAbsDelta] : [baseline.minAbsDelta, baseline.maxAbsDelta],
    putsAbsDelta: baseline.ladderPutDeltaRange === "none" ? "none" : [baseline.minAbsDelta, baseline.maxAbsDelta],
    minDte: baseline.minDte,
    maxDte: baseline.maxDte,
    maxSpreadPctOfMid: baseline.maxSpreadPctOfMid,
    ladderPutVersusCall: baseline.ladderPutVersusCall,
  };
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

export async function listAnalysisSessions(symbol: string, connection: Knex = db): Promise<AnalysisSessionRow[]> {
  const rows: {
    id: string;
    name: string;
    start_date: string;
    end_date: string;
    symbol: string;
    symbols: string[] | null;
    settings_snapshot: BacktestSettings;
    overrides: BacktestSettingsOverrides;
    symbol_settings: Record<string, BacktestSymbolSettings> | null;
    metrics: BacktestMetrics;
    baseline_metrics: BacktestMetrics | null;
    created_at: Date;
    starting_value: string;
    engine_version: number | null;
  }[] = await connection("backtest_sessions")
    .where({ status: "succeeded" })
    .whereNotNull("metrics")
    .where((inner) => inner.whereRaw("symbols @> ?::jsonb", [JSON.stringify([symbol])]).orWhere("symbol", symbol))
    .whereRaw("end_date - start_date >= ?", [analysisSessionMinimumDays])
    .select("id", "name", connection.raw("start_date::text as start_date"), connection.raw("end_date::text as end_date"), "symbol", "symbols", "settings_snapshot", "overrides", "symbol_settings", "metrics", "baseline_metrics", "created_at", "starting_value", "engine_version");
  if (rows.length === 0) return [];
  const firstStart = rows.reduce((earliest, row) => (row.start_date < earliest ? row.start_date : earliest), rows[0]!.start_date);
  const lastEnd = rows.reduce((latest, row) => (row.end_date > latest ? row.end_date : latest), rows[0]!.end_date);
  const rates = await loadTreasuryBillRates(requireBacktestDataDirectory(), firstStart, lastEnd);
  const cashCagrByPeriod = new Map<string, number>();
  return rows
    .map((row) => {
      const effective = applyBacktestOverrides(row.settings_snapshot, row.overrides ?? {});
      const baseline = effective.decisionMaker === "baseline" ? { ...effective.baseline, ...(row.symbol_settings?.[symbol]?.baseline ?? {}) } : null;
      const period = `${row.start_date}|${row.end_date}`;
      const cashCagr = cashCagrByPeriod.get(period) ?? cashCagrByPeriod.set(period, treasuryBillCagr(rates, row.start_date, row.end_date)).get(period)!;
      const maxDrawdown = Number(row.metrics.maxDrawdown);
      const ladder = baseline !== null && baseline.entry === "covered_call" && baseline.putsWhenNoCall === "reserve_ladder";
      const symbols = row.symbols ?? [row.symbol];
      const potDollars = symbols.length === 1 ? Number(row.starting_value) : (row.symbol_settings?.[symbol]?.potDollars ?? null);
      const buyAndHoldMaxDrawdown = row.baseline_metrics ? Number(row.baseline_metrics.maxDrawdown) : null;
      return {
        id: row.id,
        name: row.name,
        startDate: row.start_date,
        endDate: row.end_date,
        symbols,
        // The share level and rungs mean something only on the CC + Put Ladder.
        sharesPct: ladder ? baseline!.ladderSharesPct : null,
        rungs: ladder ? baseline!.ladderRungs : null,
        ladder,
        cagr: Number(row.metrics.cagr),
        maxDrawdown,
        totalReturn: Number(row.metrics.totalReturn),
        buyAndHoldCagr: row.baseline_metrics ? Number(row.baseline_metrics.cagr) : null,
        buyAndHoldMaxDrawdown: row.baseline_metrics ? Number(row.baseline_metrics.maxDrawdown) : null,
        excessCalmar: maxDrawdown === 0 ? null : (Number(row.metrics.cagr) - cashCagr) / Math.abs(maxDrawdown),
        treasuryBillCagr: cashCagr,
        buyAndHoldExcessCalmar: row.baseline_metrics && buyAndHoldMaxDrawdown !== 0 ? (Number(row.baseline_metrics.cagr) - cashCagr) / Math.abs(buyAndHoldMaxDrawdown!) : null,
        engineVersion: row.engine_version,
        ladderSettings: ladder ? ladderSettingsOf(baseline as BacktestBaselineSettings, potDollars) : null,
        createdAt: new Date(row.created_at).toISOString(),
        isAnalysis: row.name.startsWith("Analysis · "),
      };
    })
    .sort((a, b) => b.cagr - a.cagr);
}
