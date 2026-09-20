import { BarSizeSetting, EventName, Stock, WhatToShow, type Contract } from "@stoqey/ib";
import { connectToIbkrGateway } from "./connectIbkr.js";
import type { PriceContract } from "./fetchLivePrices.js";
import { recordStockPrices } from "../lib/priceService.js";

// Fails the whole fetch if IBKR goes silent (Gateway/tunnel problem) — a
// liveness guard on the failure path only. Every request below finishes on
// a real IBKR signal (historicalData "finished"/error, accountDownloadEnd),
// so this never fires on a healthy run.
const gatewaySilentTimeoutMs = 30_000;

/**
 * Closing prices for the daily P&L snapshot job, chosen because both
 * sources end on a real IBKR completion signal — no arrival-wait guesses
 * (probed 2026-09-18, tmp/probeDailyJobPriceSources.ts and
 * tmp/probeDailyBarUseRthZero.ts):
 *
 * - Stocks: today's daily bar from reqHistoricalData with useRTH=0, whose
 *   close equals the last trade including after-hours (matches the FROZEN
 *   snapshot `last` exactly). The bar's date must be `sessionDateIso`, so a
 *   stale bar is never returned as today's price.
 * - Options: IBKR's own portfolio mark via reqAccountUpdates, only for
 *   contracts the account actually holds (position !== 0 — rows for
 *   contracts once held keep stale marks). reqHistoricalData returns no
 *   data for options at all (error 162), and the market-data snapshot has
 *   no completion signal for options. Approved 2026-09-18: options use the
 *   mark, stocks use last.
 *
 * A leg with no price gets null (the job then skips that position).
 */
export async function fetchDailyClosingPrices(contracts: PriceContract[], sessionDateIso: string): Promise<Record<string, number | null>> {
  const priceByKey: Record<string, number | null> = Object.fromEntries(contracts.map((contract) => [contract.key, null]));
  if (contracts.length === 0) return priceByKey;

  const stockContracts = contracts.filter((contract) => contract.legType === "stock");
  const optionContracts = contracts.filter((contract) => contract.legType === "option");
  const expectedBarDate = sessionDateIso.replaceAll("-", "");

  const connection = await connectToIbkrGateway();
  const { ib } = connection;

  try {
    const stockClosesBySymbol = new Map<string, number | null>();
    const barsBySymbolReqId = new Map<number, { symbol: string; lastBarDate: string | null; lastBarClose: number | null }>();
    const pendingBarReqIds = new Set<number>();
    let resolveBarsDone: () => void = () => {};
    const barsDone = new Promise<void>((resolve) => (resolveBarsDone = resolve));

    function finishBarRequest(reqId: number) {
      if (pendingBarReqIds.delete(reqId) && pendingBarReqIds.size === 0) resolveBarsDone();
    }

    const onHistoricalData = (reqId: number, date: string, _open: number, _high: number, _low: number, close: number) => {
      const request = barsBySymbolReqId.get(reqId);
      if (!request) return;
      if (date.startsWith("finished")) {
        finishBarRequest(reqId);
        return;
      }
      // Bars arrive oldest first; the last one seen is the most recent.
      request.lastBarDate = date;
      request.lastBarClose = close;
    };

    const onHistoricalError = (error: Error, code: number, reqId: number) => {
      const request = barsBySymbolReqId.get(reqId);
      if (!request) return;
      console.error(`fetchDailyClosingPrices: no daily bar for ${request.symbol} (code ${code}): ${error.message}`);
      finishBarRequest(reqId);
    };

    const portfolioMarks: { contract: Contract; position: number; marketPrice: number }[] = [];
    let resolveAccountDone: () => void = () => {};
    const accountDone = new Promise<void>((resolve) => (resolveAccountDone = resolve));
    let accountName: string | null = null;

    const onUpdatePortfolio = (contract: Contract, position: number, marketPrice: number, _marketValue: number, _averageCost?: number, _unrealizedPnl?: number, _realizedPnl?: number, account?: string) => {
      if (account) accountName = account;
      portfolioMarks.push({ contract, position, marketPrice });
    };

    ib.on(EventName.historicalData, onHistoricalData);
    ib.on(EventName.error, onHistoricalError);
    if (optionContracts.length > 0) {
      ib.on(EventName.updatePortfolio, onUpdatePortfolio);
      ib.on(EventName.accountDownloadEnd, () => resolveAccountDone());
    } else {
      resolveAccountDone();
    }

    const uniqueStockSymbols = [...new Set(stockContracts.map((contract) => contract.symbol))];
    if (uniqueStockSymbols.length === 0) resolveBarsDone();
    let nextReqId = 7_000;
    for (const symbol of uniqueStockSymbols) {
      const reqId = nextReqId++;
      barsBySymbolReqId.set(reqId, { symbol, lastBarDate: null, lastBarClose: null });
      pendingBarReqIds.add(reqId);
    }
    for (const [reqId, request] of barsBySymbolReqId) {
      // useRTH=0: include after-hours, so the bar's close is the last trade (approved 2026-09-18).
      ib.reqHistoricalData(reqId, new Stock(request.symbol, "SMART", "USD"), "", "2 D", BarSizeSetting.DAYS_ONE, WhatToShow.TRADES, 0, 2, false);
    }
    if (optionContracts.length > 0) ib.reqAccountUpdates(true, "");

    let silentTimer: NodeJS.Timeout | undefined;
    const gatewaySilent = new Promise<never>((_, reject) => {
      silentTimer = setTimeout(() => reject(new Error(`IBKR did not answer within ${gatewaySilentTimeoutMs}ms.`)), gatewaySilentTimeoutMs);
    });
    try {
      await Promise.race([Promise.all([barsDone, accountDone]), gatewaySilent]);
    } finally {
      clearTimeout(silentTimer);
      ib.removeListener(EventName.historicalData, onHistoricalData);
      ib.removeListener(EventName.error, onHistoricalError);
      ib.removeListener(EventName.updatePortfolio, onUpdatePortfolio);
      if (optionContracts.length > 0 && accountName) ib.reqAccountUpdates(false, accountName);
    }

    for (const request of barsBySymbolReqId.values()) {
      if (request.lastBarClose === null) {
        stockClosesBySymbol.set(request.symbol, null);
      } else if (request.lastBarDate !== expectedBarDate) {
        console.error(`fetchDailyClosingPrices: latest daily bar for ${request.symbol} is ${request.lastBarDate}, expected ${expectedBarDate} — not using it.`);
        stockClosesBySymbol.set(request.symbol, null);
      } else {
        stockClosesBySymbol.set(request.symbol, request.lastBarClose);
      }
    }
    for (const contract of stockContracts) priceByKey[contract.key] = stockClosesBySymbol.get(contract.symbol) ?? null;
    // The session's last trade (incl. after-hours) is a real price: keep it as the shared last known good.
    void recordStockPrices(
      [...stockClosesBySymbol.entries()].filter(([, close]) => close !== null).map(([symbol, close]) => ({ symbol, price: close as number, source: "daily_close" as const })),
    );

    for (const contract of optionContracts) {
      const held = portfolioMarks.find(
        (row) =>
          row.position !== 0 &&
          row.contract.secType === "OPT" &&
          row.contract.symbol === contract.symbol &&
          row.contract.lastTradeDateOrContractMonth === contract.expiry &&
          row.contract.strike === contract.strike &&
          row.contract.right?.charAt(0).toUpperCase() === contract.right?.charAt(0).toUpperCase(),
      );
      priceByKey[contract.key] = held && held.marketPrice > 0 ? held.marketPrice : null;
    }

    return priceByKey;
  } finally {
    connection.disconnect();
  }
}
