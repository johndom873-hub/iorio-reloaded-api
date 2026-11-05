import { EventEmitter } from "node:events";
import { EventName } from "@stoqey/ib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => ({ ib: null as unknown, disconnect: null as unknown as ReturnType<typeof import("vitest").vi.fn> }));
vi.mock("./connectIbkr.js", () => ({ connectToIbkrGateway: async () => ({ ib: connection.ib, disconnect: connection.disconnect }) }));

import { fetchAccountLedgerPnl } from "./fetchAccountLedgerPnl.js";

class FakeIbApi extends EventEmitter {
  reqAccountUpdates = vi.fn();
}

let ib: FakeIbApi;
const accountValue = (key: string, value: string, currency: string, account = "U21518308") => ib.emit(EventName.updateAccountValue, key, value, currency, account);

beforeEach(() => {
  vi.useFakeTimers();
  ib = new FakeIbApi();
  connection.ib = ib;
  connection.disconnect = vi.fn();
});
afterEach(() => vi.useRealTimers());

describe("fetchAccountLedgerPnl", () => {
  it("subscribes to all account updates and returns the BASE ledger realized and unrealized P&L (a USD-based account, rate 1) when the download ends", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-ExchangeRate", "1.00", "USD");
    expect(ib.reqAccountUpdates).toHaveBeenCalledWith(true, "");
    accountValue("$LEDGER-RealizedPnL", "1234.56", "BASE");
    accountValue("$LEDGER-UnrealizedPnL", "-78.9", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: 1234.56, unrealizedPnl: -78.9 });
  });

  it("ignores per-currency entries, other keys and non-numeric values", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-RealizedPnL", "999", "SGD");
    accountValue("$LEDGER-UnrealizedPnL", "888", "USD");
    accountValue("NetLiquidation", "50000", "BASE");
    accountValue("$LEDGER-RealizedPnL", "not-a-number", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: null, unrealizedPnl: null });
  });

  it("treats an empty or blank value string as no value, not as zero", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-UnrealizedPnL", "", "BASE");
    accountValue("$LEDGER-RealizedPnL", "  ", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: null, unrealizedPnl: null });
  });

  it("keeps an earlier real figure when a later empty one arrives, and still reads a genuine zero", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-ExchangeRate", "1.00", "USD");
    accountValue("$LEDGER-UnrealizedPnL", "12.5", "BASE");
    accountValue("$LEDGER-UnrealizedPnL", "", "BASE");
    accountValue("$LEDGER-RealizedPnL", "0", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: 0, unrealizedPnl: 12.5 });
  });

  it("keeps the last numeric BASE value when IBKR sends a figure several times", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-ExchangeRate", "1.00", "USD");
    accountValue("$LEDGER-RealizedPnL", "100", "BASE");
    accountValue("$LEDGER-RealizedPnL", "200", "BASE");
    accountValue("$LEDGER-RealizedPnL", "oops", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toMatchObject({ realizedPnl: 200 });
  });

  it("returns a zero figure as a real value", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-ExchangeRate", "1.00", "USD");
    accountValue("$LEDGER-RealizedPnL", "0", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: 0, unrealizedPnl: null });
  });

  it("gives an SGD-based account's BASE figures in US dollars at the USD entry's rate (base per USD)", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-UnrealizedPnL", "-89719.58", "BASE", "DUR854038");
    accountValue("$LEDGER-RealizedPnL", "0.00", "BASE", "DUR854038");
    accountValue("$LEDGER-ExchangeRate", "1.00", "SGD", "DUR854038");
    accountValue("$LEDGER-ExchangeRate", "1.2762129", "USD", "DUR854038");
    ib.emit(EventName.accountDownloadEnd, "DUR854038");
    const ledger = await result;
    expect(ledger.unrealizedPnl).toBeCloseTo(-70301.3, 0);
    expect(ledger.realizedPnl).toBe(0);
  });

  it("leaves both null, rather than another currency as dollars, when no USD rate came", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-UnrealizedPnL", "-89719.58", "BASE", "DUR854038");
    ib.emit(EventName.accountDownloadEnd, "DUR854038");
    expect(await result).toEqual({ realizedPnl: null, unrealizedPnl: null });
  });

  it("unsubscribes using the account name the values carried, removes its listeners and disconnects", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("AccountType", "INDIVIDUAL", "", "U21518308");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    await result;
    expect(ib.reqAccountUpdates).toHaveBeenLastCalledWith(false, "U21518308");
    expect(ib.listenerCount(EventName.updateAccountValue)).toBe(0);
    expect(ib.listenerCount(EventName.accountDownloadEnd)).toBe(0);
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
  });

  it("does not send an unsubscribe when no value ever named the account", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    await result;
    expect(ib.reqAccountUpdates).toHaveBeenCalledTimes(1);
  });

  it("fails after 15 s without the download end, still disconnecting and unsubscribing", async () => {
    const captured = fetchAccountLedgerPnl().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-RealizedPnL", "1", "BASE");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(connection.disconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(((await captured) as Error).message).toBe("Account ledger PnL timeout.");
    expect(ib.reqAccountUpdates).toHaveBeenLastCalledWith(false, "U21518308");
    expect(connection.disconnect).toHaveBeenCalledTimes(1);
    expect(ib.listenerCount(EventName.updateAccountValue)).toBe(0);
  });
});
