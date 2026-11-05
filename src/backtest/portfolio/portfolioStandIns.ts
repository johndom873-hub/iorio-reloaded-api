// The portfolio simulator's stand-ins (Marcelo 2026-11-04): a ticker with little history of its own takes a longer-listed
// ticker's real moves for the days before its own (tickerDayHistoryOf), scaled by their volatility ratio, instead of β ×
// SPY with a β read off a few months. The pairs were confirmed by Marcelo; a ticker added later with under 3 years of its
// own history should get one here. A stand-in with a short history of its own (ASTS, COIN, MSTR) falls back to its own
// β × SPY before its start.

export const tickerStandIns: Readonly<Record<string, string>> = {
  SKHY: "MU",
  DRAM: "MU",
  CBRS: "NVDA",
  SPCX: "ASTS",
  CRCL: "COIN",
  BMNR: "MSTR",
  IBIT: "MSTR",
  CRWV: "SMCI",
  NBIS: "SMCI",
  ALAB: "MRVL",
  RDDT: "META",
};

export function standInOf(symbol: string): string | null {
  return tickerStandIns[symbol] ?? null;
}
