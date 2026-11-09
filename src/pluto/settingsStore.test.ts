import { describe, expect, it } from "vitest";
import { plutoSettingsColumns, validatePlutoSettingsInput, type PlutoSettings } from "./settingsStore.js";
import { plutoSafetyLimitsSettingsFixture, plutoVolFarmerV4SettingsFixture } from "./plutoSettingsFixture.js";

// The approved defaults (2026-09-28), as the store would read them back.
const current: PlutoSettings = {
  ...plutoSafetyLimitsSettingsFixture,
  ...plutoVolFarmerV4SettingsFixture,
  excessAllowancePct: 0,
  minCashReservePct: 2,
  windowStartEt: "10:45", windowEndEt: "15:30", dailyLossBreakerPct: 2,
  maxQuoteAgeMinutes: 10, maxFillSlippagePct: 25,
  bandQuotePollSeconds: 1, burstLines: 10, burstSettleSeconds: 4, maxEnabledTickers: 15,
  crashLoopRestartsPerHour: 3, telegramVerbosity: "actions",
  updatedAt: "2026-09-28T00:00:00.000Z", updatedByUserId: null,
};

describe("validatePlutoSettingsInput", () => {
  it("accepts an empty change and sane values", () => {
    expect(validatePlutoSettingsInput({}, current)).toBeNull();
    expect(validatePlutoSettingsInput({ excessAllowancePct: 25, telegramVerbosity: "off", windowEndEt: "15:00" }, current)).toBeNull();
  });
  it("rejects unknown fields, wrong kinds and out-of-range numbers", () => {
    expect(validatePlutoSettingsInput({ nope: 1 } as never, current)).toMatch(/not a Pluto setting/);
    expect(validatePlutoSettingsInput({ excessAllowancePct: "30" as never }, current)).toMatch(/must be a number/);
    expect(validatePlutoSettingsInput({ burstLines: 2.5 }, current)).toMatch(/whole number/);
    expect(validatePlutoSettingsInput({ maxActionsPerSession: 10 } as never, current)).toMatch(/not a Pluto setting/);
    expect(validatePlutoSettingsInput({ dailyLossBreakerPct: 101 }, current)).toMatch(/cannot be above 100/);
    expect(validatePlutoSettingsInput({ dailyLossBreakerPct: -1 }, current)).toMatch(/cannot be below 0/);
    expect(validatePlutoSettingsInput({ minGrade: "good" } as never, current)).toMatch(/not a Pluto setting/);
  });
  it("rejects bad enums and malformed times", () => {
    expect(validatePlutoSettingsInput({ telegramVerbosity: "all" as never }, current)).toMatch(/one of actions, off/);
    expect(validatePlutoSettingsInput({ windowStartEt: "9:45" }, current)).toMatch(/HH:MM/);
  });
  it("checks cross-field rules against the merged result", () => {
    expect(validatePlutoSettingsInput({ windowStartEt: "15:30" }, current)).toMatch(/before windowEndEt/);
    expect(validatePlutoSettingsInput({ windowStartEt: "15:30", windowEndEt: "15:45" }, current)).toBeNull();
  });
  it("checks each value's bounds", () => {
    expect(validatePlutoSettingsInput({ safetyMaxWorkingOrdersPerTicker: 0 }, current)).toMatch(/cannot be below 1/);
  });

  it("every settings field has a column mapping", () => {
    const fields = Object.keys(current).filter((key) => key !== "updatedAt" && key !== "updatedByUserId");
    expect(Object.keys(plutoSettingsColumns).sort()).toEqual(fields.sort());
  });
});
