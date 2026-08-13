import { Router } from "express";
import { requireAuth } from "../middleware/requireAuth.js";
import { fetchTickerDetail } from "../ibkr/fetchTickerDetail.js";
import { fetchPriceBars, type ChartRange } from "../ibkr/fetchTickerOverview.js";

export const tickerDetailRouter = Router();
tickerDetailRouter.use(requireAuth);

const validChartRanges: ChartRange[] = ["1D", "5D", "1M", "3M", "6M", "1Y", "5Y", "All"];

// Platform-wide: any screen showing a ticker symbol opens the same modal
// backed by this route, not a Screener-specific endpoint.
tickerDetailRouter.get("/:symbol/detail", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const detail = await fetchTickerDetail(symbol);
  response.json(detail);
});

tickerDetailRouter.get("/:symbol/chart", async (request, response) => {
  const symbol = request.params.symbol.toUpperCase();
  const range = request.query.range as string | undefined;
  if (!range || !validChartRanges.includes(range as ChartRange)) {
    response.status(400).json({ error: "A valid range query parameter is required." });
    return;
  }

  const bars = await fetchPriceBars(symbol, range as ChartRange);
  response.json(bars);
});
