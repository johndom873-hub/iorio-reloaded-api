import type { ModelVolatilityForecast } from "../volatilityForecast.js";
import { modelForecastWindowDays, tradingSessionsPerYear } from "../volatilityForecast.js";

// Fixtures for the valuation model (model review, 2026-10-10), shared by the backtest tests.

/** A YZ21 forecast at an annualized (×252) volatility. */
export function fixtureModelForecast(annualizedVolatility: number): ModelVolatilityForecast {
  return { perSessionVariance: annualizedVolatility ** 2 / tradingSessionsPerYear, annualizedVolatility, windowDays: modelForecastWindowDays };
}
