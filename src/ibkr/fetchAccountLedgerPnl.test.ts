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
  it("subscribes to all account updates and returns the BASE ledger realized and unrealized P&L when the download ends", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
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
    accountValue("$LEDGER-UnrealizedPnL", "12.5", "BASE");
    accountValue("$LEDGER-UnrealizedPnL", "", "BASE");
    accountValue("$LEDGER-RealizedPnL", "0", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: 0, unrealizedPnl: 12.5 });
  });

  it("keeps the last numeric BASE value when IBKR sends a figure several times", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-RealizedPnL", "100", "BASE");
    accountValue("$LEDGER-RealizedPnL", "200", "BASE");
    accountValue("$LEDGER-RealizedPnL", "oops", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toMatchObject({ realizedPnl: 200 });
  });

  it("returns a zero figure as a real value", async () => {
    const result = fetchAccountLedgerPnl();
    await vi.advanceTimersByTimeAsync(0);
    accountValue("$LEDGER-RealizedPnL", "0", "BASE");
    ib.emit(EventName.accountDownloadEnd, "U21518308");
    expect(await result).toEqual({ realizedPnl: 0, unrealizedPnl: null });
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
