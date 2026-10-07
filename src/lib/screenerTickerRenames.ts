// Ticker-change detection for scripts/run-daily-screener-scan-job.ts. IBKR keeps a stock's contract id when only its
// ticker or listing exchange changes (PSKY on Nasdaq became SKYD on NYSE, same contract id 804144296), so a symbol the
// scanner returns for the first time with the contract id of a stored row is that row under its new ticker.

export interface TickerRename {
  oldSymbol: string;
  newSymbol: string;
  ibkrContractId: number;
}

/**
 * A rename needs all of: the new symbol matched tonight and is not stored yet, the scanner gave its contract id,
 * exactly one stored row has that contract id, and that row's symbol did not match tonight (if the old ticker
 * still matched, IBKR still knows it, so it is not a rename).
 */
export function findTickerRenames(
  matches: { symbol: string; conId: number | null }[],
  storedRows: { symbol: string; ibkrContractId: number | null }[],
): TickerRename[] {
  const matchedSymbols = new Set(matches.map((match) => match.symbol));
  const storedSymbols = new Set(storedRows.map((row) => row.symbol));
  const storedSymbolsByContractId = new Map<number, string[]>();
  for (const row of storedRows) {
    if (row.ibkrContractId === null) continue;
    storedSymbolsByContractId.set(row.ibkrContractId, [...(storedSymbolsByContractId.get(row.ibkrContractId) ?? []), row.symbol]);
  }

  const renames: TickerRename[] = [];
  for (const match of matches) {
    if (match.conId === null || storedSymbols.has(match.symbol)) continue;
    const storedWithSameContract = storedSymbolsByContractId.get(match.conId) ?? [];
    if (storedWithSameContract.length !== 1) continue;
    const oldSymbol = storedWithSameContract[0]!;
    if (matchedSymbols.has(oldSymbol) || renames.some((rename) => rename.oldSymbol === oldSymbol)) continue;
    renames.push({ oldSymbol, newSymbol: match.symbol, ibkrContractId: match.conId });
  }
  return renames;
}
