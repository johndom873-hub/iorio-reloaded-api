import { EventName, SecType, type Contract, type IBApi } from "@stoqey/ib";
import { sharedLiveConnection } from "./sharedReadConnection.js";

/** One calendar day of an IBKR liquidHours/tradingHours string, in the contract's own time zone. */
export interface SessionHours {
  dateIso: string;
  openHhmm: string | null;
  closeHhmm: string | null;
  closed: boolean;
}

function hhmmWithColon(hhmm: string): string {
  return `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`;
}

function isoFromCompact(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * Pure parser for the two formats IBKR uses:
 *   current  "20261127:0930-20261127:1300;20261128:CLOSED"
 *   legacy   "20090507:0700-1830,1830-2330;20090508:CLOSED"
 * A day's open is its first range's start and its close is the last range's end on that same day
 * (a range ending on another date, as futures do overnight, is ignored for the close).
 */
export function parseIbkrLiquidHours(text: string): SessionHours[] {
  const days: SessionHours[] = [];
  for (const segment of text.split(";")) {
    const trimmed = segment.trim();
    const match = trimmed.match(/^(\d{8}):(.+)$/);
    if (!match) continue;
    const dateCompact = match[1]!;
    const dateIso = isoFromCompact(dateCompact);
    const rest = match[2]!;
    if (rest === "CLOSED") {
      days.push({ dateIso, openHhmm: null, closeHhmm: null, closed: true });
      continue;
    }
    let openHhmm: string | null = null;
    let closeHhmm: string | null = null;
    for (const range of rest.split(",")) {
      // After the leading "YYYYMMDD:" is consumed, a range is "HHMM-HHMM" (legacy), "HHMM-YYYYMMDD:HHMM"
      // (current, first range) or "YYYYMMDD:HHMM-YYYYMMDD:HHMM" (current, later ranges).
      const parts = range.trim().match(/^(?:(\d{8}):)?(\d{4})-(?:(\d{8}):)?(\d{4})$/);
      if (!parts) continue;
      const startsSameDay = (parts[1] ?? dateCompact) === dateCompact;
      const endsSameDay = (parts[3] ?? dateCompact) === dateCompact;
      if (startsSameDay && openHhmm === null) openHhmm = hhmmWithColon(parts[2]!);
      if (endsSameDay) closeHhmm = hhmmWithColon(parts[4]!);
    }
    days.push({ dateIso, openHhmm, closeHhmm, closed: false });
  }
  return days;
}

export interface ContractHours {
  liquidHours: string;
  tradingHours: string;
  timeZoneId: string;
}

/** One reqContractDetails round trip that keeps only the hours fields. Rejects on IBKR error or after `timeoutMs`. */
export function lookupContractHours(ib: IBApi, contract: Contract, reqId: number, timeoutMs = 15_000): Promise<ContractHours> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let result: ContractHours | null = null;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ib.off(EventName.contractDetails, onContractDetails);
      ib.off(EventName.contractDetailsEnd, onEnd);
      ib.off(EventName.error, onError);
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error(`No contract details for ${contract.symbol}`));
    };
    const onContractDetails = (id: number, details: { liquidHours?: string; tradingHours?: string; timeZoneId?: string }) => {
      if (id !== reqId) return;
      result = { liquidHours: details.liquidHours ?? "", tradingHours: details.tradingHours ?? "", timeZoneId: details.timeZoneId ?? "" };
    };
    const onEnd = (id: number) => {
      if (id === reqId) finish(null);
    };
    const onError = (error: Error, code: number, id: number) => {
      if (id === reqId) finish(new Error(`IBKR error ${code}: ${error.message}`));
    };
    const timer = setTimeout(() => finish(new Error(`reqContractDetails(${contract.symbol}) timed out after ${timeoutMs} ms`)), timeoutMs);
    ib.on(EventName.contractDetails, onContractDetails);
    ib.on(EventName.contractDetailsEnd, onEnd);
    ib.on(EventName.error, onError);
    ib.reqContractDetails(reqId, contract);
  });
}

/** SPY's liquid hours on the shared live connection: the US equities session schedule, half days included. */
export async function fetchSpyLiquidHours(): Promise<SessionHours[]> {
  const borrowed = await sharedLiveConnection.borrow();
  try {
    const hours = await lookupContractHours(borrowed.ib, { symbol: "SPY", secType: SecType.STK, exchange: "SMART", currency: "USD" }, sharedLiveConnection.allocateReqId());
    if (hours.timeZoneId && !/US\/Eastern|America\/New_York/.test(hours.timeZoneId)) throw new Error(`SPY liquid hours are in ${hours.timeZoneId}, expected US/Eastern`);
    return parseIbkrLiquidHours(hours.liquidHours);
  } finally {
    borrowed.release();
  }
}
