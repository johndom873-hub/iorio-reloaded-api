# Backtesting — formula sheet

Status: approved by Marcelo 2026-10-12, with the mockup (https://claude.ai/artifact/YKWFqLm2Q79wkKQQd1i86T) and both open points below.

## Account value and returns

Every trading day at 10:00 ET the account is marked to market:

- account value = cash − Σ (open short option's 10:00 mid × 100 × contracts) + Σ (shares × 10:00 stock price)
- **daily return** = account value today ÷ account value on the previous trading day − 1
- **total return** = end value ÷ start value − 1
- **CAGR** = (end value ÷ start value) ^ (365 ÷ calendar days from start to end) − 1
- **monthly return** = the month's daily returns compounded: Π (1 + daily return) − 1

Example: $1,000,000 → $1,418,000 over 2,095 calendar days: total return +41.8%, CAGR = 1.418^(365 ÷ 2,095) − 1 = +6.3%.

Daily returns compound exactly to the total return, so daily, monthly, total and CAGR always agree.

## Risk

- **Sortino** = mean(daily return) × 252 ÷ (downside deviation × √252), with downside deviation = √(mean of min(daily return, 0)²) over all days. 252 because returns exist only on trading days: a year holds about 252 of them, not 365.
- **max drawdown** = the largest fall from a previous peak of account value, as a % of that peak
- **worst month** = the lowest monthly return

Example: mean daily return 0.025%, downside deviation 0.35%: Sortino = 0.00025 × 252 ÷ (0.0035 × 15.87) = 1.13.

## Trades

- **win rate** = trades with P&L > 0 ÷ all closed trades
- **average win / average loss** = mean P&L of the winning / losing trades, in dollars
- **edge capture** = Σ trade P&L ÷ Σ Edge $ the model predicted for those trades at entry (1.0 = the model was exactly right on average)
- **capital in use** = mean over days of (Σ EXP $ of open positions ÷ account value)
- **return on capital in use** = Σ trade P&L ÷ Σ (EXP $ × calendar days held) × 365, the same basis as Edge Yield
- **contracts in the money at expiry** = expired contracts with the strike crossed ÷ all expired contracts

EXP $ is net of premium, as everywhere else: a put's (strike − premium) × 100 × contracts; a covered call's (share price − premium) × 100 × contracts.

## Interest on idle cash

Each day the cash balance earns the 3-month Treasury bill rate (FRED series DTB3, the latest value on or before that day):

- interest = cash balance × rate × calendar days since the previous trading day ÷ 365

Example: $600,000 cash, rate 4.2%, Friday → Monday (3 days): 600,000 × 0.042 × 3 ÷ 365 = $207.12.

## Simulation rules

- **Stock price at 10:00**: from the option quotes, because ThetaData's free stock tier has no intraday history before 2023-06: the median of C − P + K × e^(−r × T) over the three strikes nearest the money of the nearest expiry with at least one day left.
- **Forecast**: the valuation model's forecast (Yang-Zhang over the last 21 sessions) on IBKR daily bars up to the previous close, as Pluto does live.
- **Filters and sizing**: Pluto's filters, ranking and sizing with the session's settings. Open interest is the previous day's (what Pluto sees at 10:00). Volume is the previous day's full-day volume, because the history has no volume as of 10:00. Expiries spanning a known earnings date are skipped.
- **Trade**: Pluto's deterministic top pick (the first of Pluto's own ranking of the eligible candidates). The AI model's own choice is not replayed.
- **Fill**: sale price = mid − spread cost share × (ask − bid) ÷ 2, less the commission Pluto's model uses (`optionFriction.ts`).
- **Settlement**: held to expiry and settled at that day's close. A put that ends in the money loses (strike − close) × 100 per contract; a covered call's shares are valued at min(close, strike). Version 1 does not model assignment followed by selling calls on the assigned shares, nor Pluto's buybacks and rolls.
- **Model history tables**: walk-forward by default: a session day in year Y uses tables built only from data before 1 January of Y.

## Baseline: buy and hold

On the first day at 10:00, buy as many whole shares as the starting value allows at the 10:00 stock price; the rest stays in cash and earns the same interest. Marked to market and measured with the same formulas.

## Also decided (2026-10-12)

1. Interest on the whole cash balance, including cash that secures puts (it is still cash at IBKR).
2. No dividends in version 1, for the sessions or for buy and hold. This understates buy and hold for dividend payers; most shortlist names pay little or nothing.
