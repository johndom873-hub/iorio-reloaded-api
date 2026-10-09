import type { PlutoRejection, PlutoRejectionCode, PlutoTickerFilterResult } from "./candidateFilters.js";

// Why a round's contracts were out, counted per filter rule, for the pass_skipped and model_called events: the
// per-contract reasons are not stored, so without these counts a round only said how many were rejected.

export interface PlutoRejectionCounts {
  /** Contracts failing each rule; a contract failing two rules counts under both. */
  rejectedBy: Partial<Record<PlutoRejectionCode, number>>;
  /** Contracts failing that rule and no other: the rule that alone kept them out. */
  onlyBlocker: Partial<Record<PlutoRejectionCode, number>>;
}

export interface PlutoTickerRejectionSummary extends PlutoRejectionCounts {
  symbol: string;
  blocks: string[];
  rejected: number;
  /** Present only when the ticker had roll candidates rejected. */
  rolls?: PlutoRejectionCounts & { rejected: number };
}

export function countPlutoRejections(rejections: PlutoRejection[]): PlutoRejectionCounts {
  const rejectedBy: Partial<Record<PlutoRejectionCode, number>> = {};
  const onlyBlocker: Partial<Record<PlutoRejectionCode, number>> = {};
  for (const rejection of rejections) {
    const codes = new Set(rejection.codes);
    for (const code of codes) rejectedBy[code] = (rejectedBy[code] ?? 0) + 1;
    if (codes.size === 1) {
      const [code] = codes;
      onlyBlocker[code!] = (onlyBlocker[code!] ?? 0) + 1;
    }
  }
  return { rejectedBy, onlyBlocker };
}

export function summarizeTickerRejections(filtered: PlutoTickerFilterResult): PlutoTickerRejectionSummary {
  const summary: PlutoTickerRejectionSummary = { symbol: filtered.symbol, blocks: filtered.tickerBlocks, rejected: filtered.rejected.length, ...countPlutoRejections(filtered.rejected) };
  if (filtered.rejectedRolls.length > 0) summary.rolls = { rejected: filtered.rejectedRolls.length, ...countPlutoRejections(filtered.rejectedRolls) };
  return summary;
}
