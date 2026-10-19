import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyDownThrottled: vi.fn(),
  clearDownState: vi.fn(),
  notifyTelegramTracked: vi.fn(),
}));

vi.mock("./throttledAlert.js", () => ({ notifyDownThrottled: mocks.notifyDownThrottled, clearDownState: mocks.clearDownState }));
vi.mock("./undeliveredAlerts.js", () => ({ notifyTelegramTracked: mocks.notifyTelegramTracked }));

const { reconciliationAgreesAgainMessage, reconciliationCouldNotRunMessage, reconciliationMismatchMessage, reconciliationRanAgainMessage, reportPositionReconciliation } = await import(
  "./positionReconciliationAlert.js"
);

const mismatchKey = "position_reconciliation_mismatch";
const couldNotRunKey = "position_reconciliation_could_not_run";
const timeoutReason = "reqPositions timed out waiting for positionEnd.";

/** Which alert keys are currently in the alerted state, and for how long (ms). */
let alertedForMs: Record<string, number>;

beforeEach(() => {
  vi.clearAllMocks();
  alertedForMs = {};
  mocks.clearDownState.mockImplementation(async (alertKey: string) => {
    const durationMs = alertedForMs[alertKey];
    delete alertedForMs[alertKey];
    return durationMs ?? null;
  });
  mocks.notifyDownThrottled.mockResolvedValue(true);
  mocks.notifyTelegramTracked.mockResolvedValue(undefined);
});

describe("messages", () => {
  it("counts mismatches in words, singular and plural, one bullet each", () => {
    expect(reconciliationMismatchMessage(["AAPL: leg missing"])).toBe("⚠️ Position reconciliation: 1 mismatch between IBKR and our records —\n• AAPL: leg missing");
    expect(reconciliationMismatchMessage(["AAPL: leg missing", "MSFT: quantity differs"])).toBe(
      "⚠️ Position reconciliation: 2 mismatches between IBKR and our records —\n• AAPL: leg missing\n• MSFT: quantity differs",
    );
  });

  it("says a run that could not run is not a mismatch, naming the positions timeout in plain words and keeping the raw reason", () => {
    expect(reconciliationCouldNotRunMessage(timeoutReason)).toBe(
      "⚠️ Position reconciliation couldn't run: IBKR didn't return the positions list in time. Nothing was compared, so this is not a mismatch. Pluto won't trade until a check completes.\n(reqPositions timed out waiting for positionEnd.)",
    );
    expect(reconciliationCouldNotRunMessage("db is down")).toBe(
      "⚠️ Position reconciliation couldn't run: it hit an error. Nothing was compared, so this is not a mismatch. Pluto won't trade until a check completes.\n(db is down)",
    );
  });

  it("states how long a mismatch lasted when it clears", () => {
    expect(reconciliationAgreesAgainMessage(40 * 60_000)).toBe("✅ Position reconciliation: IBKR and our records agree again (after ~40m).");
  });
});

describe("reportPositionReconciliation", () => {
  it("stays silent on a first could-not-run and touches no alert state", async () => {
    await reportPositionReconciliation({ kind: "couldNotRun", reason: timeoutReason, previousRunAlsoCouldNotRun: false });
    expect(mocks.notifyDownThrottled).not.toHaveBeenCalled();
    expect(mocks.clearDownState).not.toHaveBeenCalled();
    expect(mocks.notifyTelegramTracked).not.toHaveBeenCalled();
  });

  it("alerts a second could-not-run in a row through the hourly throttle, with its own reminder wording", async () => {
    await reportPositionReconciliation({ kind: "couldNotRun", reason: timeoutReason, previousRunAlsoCouldNotRun: true });
    expect(mocks.notifyDownThrottled).toHaveBeenCalledWith(couldNotRunKey, reconciliationCouldNotRunMessage(timeoutReason), 60 * 60_000, { reminderText: expect.any(Function) });
    const { reminderText } = mocks.notifyDownThrottled.mock.calls[0]![3] as { reminderText: (message: string, alertedFor: string, interval: string) => string };
    expect(reminderText("M", "1h", "1h")).toBe("M\n\n(First alerted ~1h ago. Reminders are sent at most every 1h.)");
    expect(mocks.clearDownState).not.toHaveBeenCalled();
  });

  it("alerts mismatches through the hourly throttle and silently clears an alerted could-not-run", async () => {
    alertedForMs[couldNotRunKey] = 20 * 60_000;
    await reportPositionReconciliation({ kind: "mismatches", mismatches: ["AAPL: leg missing"] });
    expect(mocks.notifyDownThrottled).toHaveBeenCalledWith(mismatchKey, reconciliationMismatchMessage(["AAPL: leg missing"]), 60 * 60_000, { reminderText: expect.any(Function) });
    expect(alertedForMs).toEqual({});
    expect(mocks.notifyTelegramTracked).not.toHaveBeenCalled();
  });

  it("announces 'ran again' when a clean run follows an alerted could-not-run", async () => {
    alertedForMs[couldNotRunKey] = 20 * 60_000;
    await reportPositionReconciliation({ kind: "clean" });
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledWith(reconciliationRanAgainMessage);
  });

  it("announces 'agree again' with the mismatch's duration when a clean run follows an alerted mismatch", async () => {
    alertedForMs[mismatchKey] = 40 * 60_000;
    await reportPositionReconciliation({ kind: "clean" });
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledWith(reconciliationAgreesAgainMessage(40 * 60_000));
  });

  it("sends one message, the mismatch one, when both states clear on the same clean run", async () => {
    alertedForMs[mismatchKey] = 90 * 60_000;
    alertedForMs[couldNotRunKey] = 20 * 60_000;
    await reportPositionReconciliation({ kind: "clean" });
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTelegramTracked).toHaveBeenCalledWith(reconciliationAgreesAgainMessage(90 * 60_000));
    expect(alertedForMs).toEqual({});
  });

  it("sends nothing on a clean run when nothing was alerted", async () => {
    await reportPositionReconciliation({ kind: "clean" });
    expect(mocks.notifyTelegramTracked).not.toHaveBeenCalled();
    expect(mocks.notifyDownThrottled).not.toHaveBeenCalled();
  });
});
