import { describe, expect, it } from "vitest";
import { isMajorMacroEvent } from "./macroEventCalendar.js";

// Titles are the exact strings TradingView's economic calendar stores (dev DB, 2026-09-24).
describe("isMajorMacroEvent", () => {
  it.each([
    "Fed Interest Rate Decision",
    "Fed Press Conference",
    "FOMC Economic Projections",
    "Inflation Rate MoM",
    "Inflation Rate YoY",
    "Core Inflation Rate MoM",
    "Core Inflation Rate YoY",
    "Non Farm Payrolls",
    "Unemployment Rate",
    "Core PCE Price Index MoM",
    "GDP Growth Rate QoQ Final",
    "GDP Growth Rate QoQ Adv",
    "FOMC Minutes",
    "PPI MoM",
    "Core PPI MoM",
  ])("matches %s", (title) => {
    expect(isMajorMacroEvent(title)).toBe(true);
  });

  it.each([
    "Durable Goods Orders MoM",
    "JOLTs Job Openings",
    "ISM Manufacturing PMI",
    "Michigan Consumer Sentiment Prel",
    "Existing Home Sales",
    "Personal Income MoM",
    "Retail Sales MoM",
    "President Trump and President Xi Summit",
    "3-Month Bill Auction",
  ])("ignores %s", (title) => {
    expect(isMajorMacroEvent(title)).toBe(false);
  });
});
