import { describe, expect, it } from "vitest";
import { mapTradingSettingsRow, validateTradingSettingsInput, type TradingSettingsInput } from "./tradingSettingsStore.js";

const validInput: TradingSettingsInput = {
  maxPositionPctOfPortfolio: 15,
  maxConcentrationPerTickerPct: 20,
  minCashReservePct: 5,
  deltaTargetMin: 0.2,
  deltaTargetMax: 0.4,
  recoveryDteMin: 1,
  recoveryDteMax: 14,
  minAnnualizedYieldPct: 50,
  commissionWarnSharePctOfPremium: 5,
  priceCheckMaxDeviationPct: 10,
  priceCheckMinToleranceDollars: 0.05,
};

describe("validateTradingSettingsInput", () => {
  it("accepts a complete, in-range payload", () => {
    expect(validateTradingSettingsInput(validInput)).toBeNull();
  });

  it("names the first missing or non-numeric field", () => {
    const { minCashReservePct: _omitted, ...withoutField } = validInput;
    expect(validateTradingSettingsInput(withoutField)).toBe("minCashReservePct must be a number.");
    expect(validateTradingSettingsInput({ ...validInput, deltaTargetMax: "0.4" })).toBe("deltaTargetMax must be a number.");
    expect(validateTradingSettingsInput({ ...validInput, maxPositionPctOfPortfolio: Number.NaN })).toBe("maxPositionPctOfPortfolio must be a number.");
  });

  it("rejects percentages outside 0-100", () => {
    expect(validateTradingSettingsInput({ ...validInput, maxConcentrationPerTickerPct: 101 })).toBe("maxConcentrationPerTickerPct must be between 0 and 100.");
    expect(validateTradingSettingsInput({ ...validInput, minCashReservePct: -1 })).toBe("minCashReservePct must be between 0 and 100.");
  });

  it("rejects a price-check deviation outside 0-100 and a dollar floor outside 0-1000", () => {
    expect(validateTradingSettingsInput({ ...validInput, priceCheckMaxDeviationPct: 100.5 })).toBe("priceCheckMaxDeviationPct must be between 0 and 100.");
    expect(validateTradingSettingsInput({ ...validInput, priceCheckMaxDeviationPct: -1 })).toBe("priceCheckMaxDeviationPct must be between 0 and 100.");
    expect(validateTradingSettingsInput({ ...validInput, priceCheckMinToleranceDollars: -0.01 })).toBe("priceCheckMinToleranceDollars must be between 0 and 1000.");
    expect(validateTradingSettingsInput({ ...validInput, priceCheckMinToleranceDollars: 1000.01 })).toBe("priceCheckMinToleranceDollars must be between 0 and 1000.");
    expect(validateTradingSettingsInput({ ...validInput, priceCheckMaxDeviationPct: 0, priceCheckMinToleranceDollars: 0 })).toBeNull();
  });

  it("rejects an invalid delta band", () => {
    expect(validateTradingSettingsInput({ ...validInput, deltaTargetMax: 1.2 })).toBe("The delta band must be between 0 and 1.");
    expect(validateTradingSettingsInput({ ...validInput, deltaTargetMin: 0.5, deltaTargetMax: 0.4 })).toBe("deltaTargetMin cannot exceed deltaTargetMax.");
  });

  it("rejects an invalid Recovery Path DTE window", () => {
    expect(validateTradingSettingsInput({ ...validInput, recoveryDteMin: 20, recoveryDteMax: 14 })).toBe("recoveryDteMin cannot exceed recoveryDteMax.");
    expect(validateTradingSettingsInput({ ...validInput, recoveryDteMin: -1 })).toBe("recoveryDteMin cannot be negative.");
    expect(validateTradingSettingsInput({ ...validInput, recoveryDteMax: 14.5 })).toBe("The Recovery Path DTE window must be whole days.");
  });
});

describe("mapTradingSettingsRow", () => {
  it("turns the stored numeric strings into numbers", () => {
    const mapped = mapTradingSettingsRow({
      max_position_pct_of_portfolio: "15.00",
      max_concentration_per_ticker_pct: "20.00",
      min_cash_reserve_pct: "5.00",
      delta_target_min: "0.2000",
      delta_target_max: "0.4000",
      recovery_dte_min: 1,
      recovery_dte_max: 14,
      min_annualized_yield_pct: "50.00",
      commission_warn_share_of_premium_pct: "5.00",
      price_check_max_deviation_pct: "10.00",
      price_check_min_tolerance_dollars: "0.05",
    });
    expect(mapped).toEqual(validInput);
  });
});
