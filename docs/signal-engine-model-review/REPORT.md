# Signal Engine model review — 2026-10-10

Scope: every assumption between the captured market data and the Edge / grade that Signals and Pluto act on, tested on the
data we have. Data: a read-only copy of staging in the local DB `iorio_research` (12 capture days 2026-09-23 → 10-09,
184 snapshots, 51,288 quotes, 1,366 fitted slices; daily bars 2021-09 → 2026-10 for ~25 tickers incl. IBKR's daily 30-day
implied vol; hourly bars 2026-06 → 10). Prod reads were not available to me; prod captures are the same market.
Fits for 09-23..09-30 were made by older code (before the parity forward) and were re-fitted with current code in the
research DB (originals kept in `option_surface_fits_original`); every option study below was re-run on the re-fit.
No application code was changed during the review (the approved design was implemented afterwards, see "Round 4"). 95%
confidence intervals are cluster/block bootstraps (clusters stated per test).

## Plain-language summary

- **The surface itself is sound.** Turning option prices into a volatility curve (SVI fit, parity forward, European model,
  mid prices) is accurate to under 1 volatility point where we trade. Nothing to fix there.
- **Time is measured wrongly, in three places.** The market and the stocks both behave as if time = trading sessions, not
  calendar days: a weekend is worth about one extra tenth of a session, not three days. Our forecast also forgets the part
  of today that is still ahead at 10:00 (about 0.3 of a session), which flatters 1–2-day contracts; and an old surface is
  rolled to a new day by calendar days, which is wrong after every weekend. These are clear and fixable (high confidence).
- **Comparing in total variance, not annualised vol points, removes the 365-vs-252 question entirely.** The market's own
  price encodes the total variance to expiry; the forecast should be the expected total variance over the same time. Both
  are then in the same units for every expiry and every day of the week.
- **The forecast is the weak link.** The 63-day Yang-Zhang forecast is right on average over years, but badly wrong at
  the moments that matter: right after a volatility spike, and whenever the option price disagrees with it. In our 12
  captured days it was 2× too high, which is why almost every Edge was negative. A large Edge mostly measures the
  forecast's own error.
- **The idea still works, with a better forecast.** On 5 years of history (IBKR's daily implied vol, ~20,000 ticker-days
  per horizon), selling when implied vol is high relative to a forecast does earn more than selling when it is low. With
  the 21-day forecast the gap between the richest and cheapest fifth is 16–24% of the premium at 1–5 sessions, in both
  halves of the history. With the production 63-day forecast it is smaller and not significant in the last two years.
- **On average there is no free premium in these stocks.** Selling at-the-money options on these tickers without a signal
  earned about nothing over 5 years (slightly positive at 1 session, negative at 21). Only the top fifth by signal paid.
- **Puts are not systematically expensive.** Outside earnings, these stocks' big moves are fat-tailed on both sides, with
  no downside skew; the market's smile inside our delta band matches that. The flat forecast's real strike error is that
  it makes at-the-money contracts look worse than low-delta ones (by 5–7 vol points at 1 session).
- **Short-dated contracts are not penalised by the model; they were flattered.** Fixing the rest-of-day error makes them
  slightly less attractive, not more. Whether short-dated contracts actually pay is not settled by our data (12 days say
  no, 5 years of 30-day implied vol say a little; neither measures real short-dated option prices).

## Findings by assumption

| # | Assumption | Test | Result | Verdict | Confidence |
|---|---|---|---|---|---|
| 1 | Market prices options on calendar time (prod IV T = D/365, rebase by calendar days) | D1 first-interval ratios (138 snapshots), D1b forward intervals (72 pairs, 12 day-clusters), D2 roll-forward across capture days (173) | Weekend-following session = **1.08 [0.96, 1.15]** weekday sessions (calendar implies 3.0). Spread of weekday-group mean errors: calendar 0.52, sessions 0.09, sessions + rest-of-day 0.05. Roll-forward RMS: calendar 0.135 [0.105, 0.167], τ clock **0.077 [0.064, 0.092]** | False | High |
| 2 | Realized variance accrues per calendar day | A1/A2: 5 years, 26 tickers, overnight gaps by type; weekday variance | Weekend overnight gap 1.29× [1.01, 1.61] a weeknight gap (robust 1.15–1.20) = **+0.098 session**; Monday close-to-close **1.003 [0.889, 1.122]** × average; holidays like weekends; early-close days ~half the intraday variance | False: sessions are the unit | High |
| 3 | Forecast horizon = N whole sessions after today (prod) | A3/A7: hourly bars 2,289 ticker-days; 5 years open-based | Share of a session still ahead at 10:00 = **0.309 [0.264, 0.358]** (study B: 0.268); 11:00 0.19, 12:00 0.14, 13:00 0.11, 14:00 0.08, 15:00 0.06. Realized-from-10:00 ÷ realized-from-prior-close = 1.273 at N=1 vs 1.309 predicted by N+0.31, 1.000 by prod. Prod understates variance to expiry by 24% (N=1), 13% (N=2), 6% (N=5), 1.4% (N=21) | False | High |
| 4 | SVI fit reproduces the market where we trade | S6 on 39,447 fit points (re-fit) | Mean SVI − mid IV −0.04 vp, RMS 0.73; traded band 1 DTE RMS 1.07, 2–3 DTE 0.95; ATM level bias −0.11 vp | True | High |
| 5 | European Black-76 on American options is adequate | C1 Leisen-Reimer, 400 vs 1600 steps checked | Pure early-exercise effect in the traded band: mean −0.03 vp, max 0.28 | True | High |
| 6 | Parity forward is right | C2, C3 | American bias of the parity forward ≤ 0.12 vp from 2 DTE (0.30 at 1 DTE); spot/dividend forward would be 1.7–3.3 vp off at 1–3 DTE → keep parity; per-quote re-anchoring unnecessary | True | High |
| 7 | Mid is the best price | C4: vs IBKR model price, microprice, SVI re-fits | Microprice re-fits noisier (RMSE 0.53 vs 0.42); IBKR model price outside bid/ask 13% | True | High |
| 8 | Risk-free rate matters | C5 ±50 bp | ≤ 0.03 vp | Negligible | High |
| 9 | Linear Edge $ (net Edge × vega × 100) ≈ exact repricing | S13, 3,830 contracts | Median error 5–7%, zero sign disagreements | True (but the exact form costs nothing) | High |
| 10 | Daily bars free of partial days at scoring time | Bar write times since 09-25 | Written 18:00 ET; a partial same-day bar exists only when something fetches bars intraday (3 rows on 10-05; the old 09:30 schedule before 09-24). The forecast reads bars ≤ today, so on those days it includes a partial day | True since 09-25, edge case remains | High |
| 11 | YZ63 forecast level is right | A4: 2023–26, ~20k rows/horizon; S11 live captures (203 slices, 45 clusters) | Long run realized/forecast 0.92 (CI includes 1), 0.97–0.99 since 2024-10, 1.00–1.02 last 12 months. Live window **0.48 [0.34, 0.64]**, a 2nd–3rd percentile 13-day block (worst comparable: May 2025) | True on average | High |
| 12 | YZ63 is right conditionally | A8 quintiles | Top quintile of YZ63/YZ252 → realized 0.72× forecast. Implied²/YZ63 lowest quintile → **0.48×**, highest → **1.51×**; the market's implied vol stayed ~unbiased across the same quintiles (1.03 → 0.97) | False: large Edges are mostly YZ63 error | High |
| 13 | YZ63 is the best available forecaster | A4 QLIKE vs 24 alternatives | Best: IBKR 30-day IV and a log-regression including it; realized-only log-regression (YZ10/21/63/252) significantly better than YZ63; YZ63 in a statistically tied middle group | False | High |
| 14 | Earnings handling | A5 | 96.8% of 63-session windows contain an earnings reaction (8.9× a normal session), inflating YZ63 ~12%; windows containing earnings realize 2.29× forecast → the exclusion of earnings-spanning contracts is essential. Ex-earnings forecast: no clear winner | Exclusion right; window choice undecided | High / Low |
| 15 | Flat forecast across strikes is fair (no skew) | B: standardized returns, 5 years, earnings-free | No negative skew (robust skew −0.007 [−0.040, 0.023] at h=1); fat tails both sides (P(z<−3) 0.50% vs 0.135% normal). Fair ATM vol = 0.91 σ_f at h=1, 0.93 at h=5, 0.96 at h=21; fair vol at 0.10 delta ≈ 1.09–1.12 × fair ATM at h=1, ~1.07 at h=5 | False: kurtosis, not skew | High |
| 16 | Market skew is mispriced vs realized tails | B4 | Inside the 0.10–0.50 band: puts within ±2 vp of realized-fair shape, calls 1.4–2.3 vp cheap at 1–3 sessions; far put wing (≈0.02 delta) 5–8 vp rich | No exploitable skew in band | Moderate |
| 17 | Edge ranks contracts by realized P&L (live captures) | S13: 3,830 contracts, 42 ticker×expiry clusters, 11 days | Prod Edge $ Spearman **−0.357 [−0.496, −0.188]**; prod net Edge vp −0.183 [−0.294, −0.040]; realized +6.4 per $1k vs predicted −10.6 | False in this window (mechanism: forecast 2× too high × vega) | Moderate (one regime) |
| 18 | YZ63 carries cross-sectional information | S13b ATM premium, 203 slices | Spearman(predicted, realized premium) **0.512 [0.332, 0.646]**; level off by e^1.07 ≈ 2.9× in variance | True for ranking, wrong level | Moderate |
| 19 | "IV high vs forecast" predicts seller profit (5 years) | S17: IBKR 30-day IV, ATM straddle and variance-swap P&L, 13–21k earnings-free ticker-days per horizon, month-block CIs | See table below | True for good forecasts; weakest with YZ63 | Moderate–High |
| 20 | There is an average premium to sell | S17 unconditional; B5-year IV level | ATM straddle seller: +4.7% of premium [1.1, 8.5] at 1 session, +2.4 at 2, −0.2 at 5, −3.3 at 10, −8.2 at 21 (before friction); variance-swap seller −4% to −20%. Fair/market ATM 1.066 [0.982, 1.168] | No: only conditional | Moderate–High |
| 21 | Intraday: a fixed date-based T keeps Edge honest through the day | S14: Pluto's live quotes (256 obs) | BMNR flat, COIN decays as predicted, SMCI drifts up: vol moves swamp the ~1.5%/hour decay | Untested (data too noisy); logically wrong (variance consumed intraday is ignored) | — |
| 22 | IBKR's IV as a reference | C6 | IBKR = American model, calendar time to ~16:10 ET ÷ 365, no weekend effect; after moving production to that convention the mean IV gap by DTE drops from −7.2…−0.1 to ≈0 | IBKR fully reproduced | High |

### S17 — 5-year signal test (ATM straddle seller P&L, % of premium, before friction)

Quintiles of the signal log(IV² ÷ forecast) pooled across tickers and days; Q5 − Q1 with month-block 95% CIs; "same day" = top minus bottom half of tickers ranked on the same date.

| Forecast in the signal | h=1 Q5−Q1 | h=2 | h=5 | h=10 | h=21 | Q5 level h=1 / 2 / 5 | same day h=1 |
|---|---|---|---|---|---|---|---|
| YZ63 (prod) | 8.2 [0.9, 14.4] | 10.9 [4.3, 16.7] | 11.5 [3.4, 19.7] | 11.5 [−1.6, 24.8] | 19.7 [4.1, 41.2] | +9.9 / +9.4 / +8.3 | 6.2 [3.4, 8.6] |
| YZ21 | **19.7 [11.8, 27.9]** | **19.3 [11.0, 27.8]** | **17.8 [8.3, 30.8]** | 17.8 [−0.3, 33.2] | −1.8 [−19.4, 14.2] | +17.9 / +15.1 / +9.8 | 8.0 [4.9, 11.2] |
| Log-regression (YZ10/21/63/252, ex-earnings training) | 16.0 [7.5, 23.6] | 16.3 [8.4, 24.6] | 13.0 [5.7, 21.0] | 13.0 [−1.7, 28.1] | 24.4 [3.1, 41.8] | +14.1 / +12.2 / +9.1 | 7.2 [4.4, 10.2] |
| HAR (ex-earnings) | 18.4 [12.0, 24.8] | 16.3 [9.9, 23.4] | 15.7 [7.2, 24.1] | 14.8 [−2.0, 32.0] | 8.2 [−14.6, 33.2] | +14.8 / +11.8 / +8.7 | 7.9 [5.4, 11.1] |
| YZ252 | 3.4 [−4.2, 11.1] | 6.3 | 8.7 [2.7, 16.7] | 16.1 [3.9, 26.0] | 31.2 [7.8, 51.9] | | 4.9 |
| IV level alone | −4.4 [−9.0, 0.6] | −2.2 | −0.2 | 1.1 | 2.0 | | 0.2 |

Split by period (Q5 − Q1, h = 1 / 2 / 5):

| Forecast | 2023-02 → 2024-09 | 2024-10 → 2026-10 |
|---|---|---|
| YZ63 (prod) | 12.7 / 13.2 / 12.4 (all significant) | 4.7 / 9.2 / 12.3 (none significant) |
| YZ21 | 24.1 / 20.8 / 23.1 (all significant) | **16.2 [4.1, 29.5] / 17.3 [4.6, 31.3]** / 14.3 [−0.8, 31.2] |
| Log-regression | 23.3 / 20.1 / 19.1 (all significant) | 9.1 / 13.8 / 8.5 (none significant) |

Unconditional ATM straddle seller, recent half: +2.1% (h=1), −0.1% (h=2), −1.2% (h=5). Friction (λ = 0.5 half-spread,
median spreads of captured quotes in the 0.10–0.50 band): 2.6% of premium at 1 DTE, 1.6% at 2–3, 1.4% at 4–7, 2.0–2.2% at 8+.

Caveats on S17: the "price" is IBKR's 30-day ATM implied vol used for every horizon (no history of real 1–5-day option
prices, strikes or spreads); ATM only; 6 signals × 5 horizons × 2 periods were examined, so single significant cells
should be discounted — YZ21 is credible because it holds at h ≤ 5 in both halves and in the same-day cross-section.

### Live-capture tests on the clock (re-fit surfaces)

| Clock | D1 first-interval mean log error | D1 sd of weekday-group means | D2 roll-forward RMS [CI] | D2 weekend − weekday |
|---|---|---|---|---|
| calendar days from midnight (prod IV and rebase) | +0.349 | 0.516 | 0.135 [0.105, 0.167] | +0.143 |
| calendar hours (IBKR convention) | +0.249 | 0.498 | 0.119 [0.086, 0.152] | +0.144 |
| whole sessions N (prod forecast) | +0.104 | 0.094 | 0.106 [0.085, 0.124] | −0.102 |
| sessions + rest-of-day (τ) | −0.038 | 0.052 | 0.077 [0.064, 0.092] | −0.080 |

## Defects found in production (independent of the redesign)

1. **Forecast horizon ignores the rest of today** (`forecastOnCalendarDayBasis` uses N): 24% too little variance at N=1. Flatters short contracts.
2. **Rebase by calendar days** (`rebaseSlicesToToday` scales total variance by calendar days): on Monday a Friday surface loses 3/7 of a 7-day contract's variance; the market loses ~1/5. Measured error +14–16% on weekend pairs.
3. **Live scoring keeps a date-only T all day**: a contract's live mid IV is solved with T from midnight, so intraday time decay reads as falling IV and the forecast side does not shrink either. Edge drifts as the day passes.
4. **Edge mixes clocks in vol points**: grade cut points (5 / 10 vp) depend on the unit; dollar Edge does not.
5. **Forecast window can include a partial day** if anything fetches daily bars intraday (`loadVolatilityForecast` reads bars ≤ today).
6. **Macro calendar has no jobs report (NFP)**; 2026-10-02 NFP fell inside the captured window. No PPI/PCE either.
7. **Ex-dividend calendar is empty for most payers** (TLT, QQQ, SMH, IGV, AAPL, MU, NOK, NVDA, WDC); harmless while the parity forward is available (47 expiries fell back to the spot forward, 13 of them 'ok').
8. **Underlying anchor offset**: IBKR's underlying price sits a median 4–5 bp (p90 15–19 bp) from the spot the options imply; at 1 DTE ATM 10 bp ≈ 1.9 vp in live rescaling. Whether it persists intraday is untested.
9. Latent: `computeForwardPrice` would subtract a dividend going ex on the trading date itself.

## Proposed design (approved in rounds 2–4 below; implemented, see Round 4)

**P1. One variance clock τ, in trading sessions, from now to the expiry's 16:00 close.**
τ(t → expiry) = r(t) + Σ c_s over sessions after today up to the expiry.
r(t) = share of today's session still ahead: 1.0 before the open, then by the measured intraday curve (10:00 0.31,
11:00 0.19, 12:00 0.14, 13:00 0.11, 14:00 0.08, 15:00 0.06, 16:00 0). c_s = 1 for every full session (post-weekend and
post-holiday sessions measured 1.00–1.08, use 1), ≈ 0.7 for early-close days, 0 for holidays.
Example: Thu 10:00 → Fri expiry: τ = 0.31 + 1 = 1.31 (prod uses 1). Fri 10:00 → Mon expiry: 0.31 + 1 = 1.31.

**P2. Compare total variance, not annualised vol.** Market: w(K) = SVI total variance (unchanged). Forecast:
V = forecast per-session variance × τ. A stale surface rolls forward as w × τ_now/τ_fit (replaces the calendar rebase).
Live mids are converted to total variance (independent of the T used to solve them). Displayed IV, when needed:
√(252 · w/τ) (same units as the forecast); IBKR-comparable IV can be shown alongside (calendar hours to 16:10 ÷ 365).

**P3. Replace YZ63 as the forecast.** Evidence: YZ21 gives the strongest and only period-robust signal at 1–5 sessions;
the realized-only log-regression is the most accurate realized-only forecaster and the strongest signal in 2023–24, but
not significant since 2024-10; YZ63 is weakest. Recommendation: YZ21 for horizons ≤ 5 sessions; above 5 sessions no
forecaster is robustly significant, so either keep the trade window short or use the log-regression there (decision).

**P4. Value each strike with fat tails, not a flat Black-Scholes.** Fair value = expected payoff under the forecast
variance and the pooled empirical standardized return distribution (earnings-free, per horizon bucket; zero drift on the
forward). Simpler equivalent: a fair-vol multiplier table by horizon and delta (study B, e.g. h=1: ATM 0.91 σ_f,
0.10-delta ≈ 1.0 σ_f). Per-group tables (ETFs vs small caps vs TLT) are more accurate but noisier (decision).

**P5. Edge in dollars and per unit of risk-time.** Edge $ = (mid − fair) × 100 − friction $ (exact, not linear).
Rank and grade on Edge $ ÷ capital at risk ÷ τ (expected return per dollar per session). Re-derive cut points from the
historical signal distribution (e.g. "sell only in the top fifth": log(IV²/YZ21) > ≈ 0.37, i.e. IV > 1.2 × YZ21).

**P6. Fix the defects** 1–6 above regardless of P3–P5 (1–3 are part of P1/P2).

## What the data cannot settle, and how to settle it

- Real short-dated (1–5 DTE) option P&L over many regimes: we have 12 days of chains. Shadow-run the new Edge on staging
  and log every scored contract with its prediction; evaluate monthly against realized outcomes (pre-registered metrics:
  Spearman with P&L per $ per session, top-fifth P&L net of friction).
- Strike-level history: none before 2026-09-23. Buying historical chains would make P4 testable on prices, not only on
  realized tails.
- Intraday decay: needs repeated quotes of the same contracts through the day (the Day Signals loop could store them).
- The weekend weight in option prices rests on 2 weekends of time series plus cross-sectional term structures (CI
  [0.96, 1.15]); it agrees with 5 years of realized data, so it is not a blocker.

## Round 2 — Marcelo's decisions and clarifications (2026-10-10)

**Decided:** P2, P3, P6 approved; P5's approach approved, extended below. The old Edge is replaced, not run in parallel.
**Open:** P1 (explained below, sign-off on the numbers), P4 (elaborated below), decisions 2 and 3 (clarified below).

**Round 3 (same day):** P4 approved (empirical fat-tail valuation). P5 approved as extended below. YZ21 is used for
**all tenors** (tested on staging, re-evaluated as session history grows). Two tail tables (ETFs incl. TLT / single
stocks) approved. The old Edge stays computed and shown on screen, but Pluto uses only the new model; it is phased out
later. Still open: P1's number (extended-hours question answered in the chat of 2026-10-10: a time share fails, see the
P1 section) and the ThetaData purchase (licence check).

### P1 — where "0.31 of a session at 10:00" comes from

It is a share of **variance**, not of time. For every ticker-day with a complete set of hourly bars (2,289 ticker-days,
31 tickers, 2026-06-01 → 10-09, earnings sessions excluded):

- r_rest = ln(close ÷ price at 10:00), where the price at 10:00 is the close of the 09:30–10:00 bar;
- r_day = ln(close ÷ previous close);
- per ticker, divide by that ticker's mean r_day² (so every ticker weighs the same), then
  **w_rest(10:00) = mean(r_rest²) ÷ mean(r_day²) = 0.309**, 95% CI [0.264, 0.358] (block bootstrap over dates).

Where the rest of a session's variance sits (same normalization): overnight gap 0.412, 09:30–10:00 0.255, 10–11 0.128,
11–12 0.071, 12–13 0.035, 13–14 0.033, 14–15 0.032, 15–16 0.061. So 10:00→16:00 is 92% of the trading minutes but only
31% of the day's variance: the overnight gap and the first half hour carry two thirds of it.

Worked example: SMCI at 61% annual volatility moves ±3.9% on a typical day (variance 0.00149). From 10:00 to the close
the expected variance is 0.309 × 0.00149 = 0.00046, a ±2.1% move. Scaling by minutes left (6 of 6.5 hours) would say
±3.7%, almost twice as much; ignoring the rest of the day (production) says 0.

The same curve from other times: 11:00 0.193, 12:00 0.143, 13:00 0.113, 14:00 0.082, 15:00 0.061, close 0; before the
open 1.0 (the whole session, overnight gap included, is still ahead).

How firm the number is:
- per ticker it ranges 0.10–0.51 (median 0.30) with wide CIs (e.g. AAOI 0.40 [0.28, 0.53]), so one pooled curve is
  used, not per-ticker values;
- by weekday it ranges 0.24 (Fri) to 0.37 (Thu); not significant;
- the hourly sample is one 4-month regime; 5 years of daily bars put more of the day after the open, which projects to
  ≈0.36 at 10:00; study B, with a different weighting, got 0.27;
- the options market agrees with a rest-of-day term (D1: the first-expiry test fits best with it, error −0.04 vs +0.10
  without).

Sensitivity: for a 1-session contract τ = 1.27 / 1.31 / 1.36 for 0.27 / 0.31 / 0.36: ±4% in variance, ±2% in vol. For
5 sessions under ±1%. Proposal: 0.31 now; re-estimate from 5 years of IBKR hourly bars (fetchable through the Gateway,
no cost) before the curve is final.

### P4 — valuing each strike with fat tails

What changes: today a contract's fair price is Black-Scholes at the forecast volatility, which assumes normally
distributed returns. Real returns of these stocks (earnings excluded) have the same width but more mass in the middle
and in both tails: at 1 session P(|move| > 3 forecast σ) is 1.0% vs 0.27% for a normal distribution, and the 5%/95%
quantiles are ±1.56σ instead of ±1.64σ. No downside skew.

Method ("filtered historical simulation"): take every earnings-free h-session return of 25 tickers over 2021–2026 and
divide it by the forecast σ√h that was available at the time: z = return ÷ (σ_forecast √h). That gives ~28,000 values of
z per horizon. To value a contract: terminal price S_T = F · e^{σ√τ z} (normalized so its mean is the forward, i.e. no
drift view), payoff averaged over all z. The same set of outcomes gives the fair price, the probability of profit, the
average win and loss, the tail loss, all consistently.

Effect (study B, fair vol ÷ forecast, drift removed): at 1 session ATM 0.91, 0.20 delta 0.95–0.97, 0.10 delta 0.99–1.02;
at 5 sessions ATM 0.93–0.96, 0.10 delta 1.00–1.02; at 21 sessions ATM 0.98–1.01. So at short horizons Black-Scholes
overvalues near-the-money options by ~9% of vol relative to the wings; production therefore over-ranks low-delta
contracts versus near-ATM ones by 4.6–7 vp at 1 session and 2.3–5.3 vp at 2–5.

Worked example, SMCI 2026-10-07 10:0x, expiry 10-09 (τ = 2.31), YZ21 61.2%/yr (`P45_workedExample.mts`):

| contract | Δ | max yield (ann.) | fair: flat BS | fair: fat tails | PoP | avg win | avg loss | Edge $ | exp. return (ann.) | 5% worst-case avg | 2σ stress |
|---|---|---|---|---|---|---|---|---|---|---|---|
| put 40.5 | 0.08 | 28% | $9 | $11 | 93% | $10 | −$140 | −$1 | −4% | −$193 | −$132 |
| put 42 | 0.21 | 84% | $32 | $31 | 83% | $30 | −$147 | $0 | 0% | −$322 | −$260 |
| put 43.5 | 0.42 | 213% | $81 | $79 | 70% | $75 | −$160 | +$4 | +11% | −$420 | −$359 |
| call 44.5 | 0.43 | 200% | $78 | $75 | 73% | $73 | −$180 | +$3 | +8% | −$478 | −$413 |
| call 46 | 0.24 | 91% | $33 | $33 | 84% | $35 | −$171 | +$3 | +6% | −$372 | −$306 |
| call 48 | 0.09 | 30% | $8 | $10 | 95% | $11 | −$187 | $0 | +1% | −$196 | −$131 |

(Per contract, after λ = 0.5 half-spread and $0.68 commission; option leg only.) In total variance the market priced
SMCI that morning at the YZ21 forecast (IV 80% over 2 calendar days ≈ 61% per session over 2.31), so every Edge is
within ±$4: no trade. Under YZ63 (76%) the same chain shows large negative Edges — the forecast choice, not the market.

Open choice (decision 3): one pooled table, or separate tables for ETFs and single stocks (see below).

### P5 — what a trade assessment must contain, and the challenge

The four quantities proposed (probability of profit, max profit / yield, dollar edge, size) are all needed, but they
are not four independent factors, and two of them mislead if used to rank on their own:

- **Expected P&L already contains PoP and yield.** E[P&L] = PoP × average win + (1 − PoP) × average loss (a negative
  number). Put 43.5 above: 0.70 × $75 + 0.30 × (−$160) = +$4. "55% winners at 150% yield beat 60% at 75%" is true only
  if the losses are comparable — and they are not: higher-yield contracts are closer to the money and lose more when
  they lose (avg loss −$160 vs −$140, 5% tail −$420 vs −$193 above). In this chain PoP and max yield trade off almost
  exactly (93% / 28% … 70% / 213%) and the expected value is ≈0 throughout. Ranking by PoP favours tail-risk trades;
  ranking by max yield favours near-the-money high-IV trades. Neither says whether the price is good.
- **Yield enters correctly as expected return on capital per unit time**: Edge $ ÷ capital ÷ τ, annualized on
  sessions (the "exp. return (ann.)" column). That is the expected version of annualized yield; max yield is its
  best case.

What Pluto should receive per candidate — every number from the same distribution (P4), so they cannot contradict:
1. Expected P&L $ and expected annualized return on capital (the ranking quantity).
2. Probability of profit, average win, average loss.
3. Downside: 5% expected shortfall (average of the worst 5% of outcomes) and the 2σ stress loss.
4. Max profit and max annualized yield (context only).
5. **Calibration** (missing from the list, and the most important addition): how much of the model's expected value
   was actually realized historically for contracts with a similar signal. The 5-year test shows only the top fifth
   by signal earned money; the model's EV must be shrunk to what history delivered, or Pluto acts on overconfident
   numbers.
6. Proposed size: quarter-Kelly on the calibrated expected return and the P&L variance (approved 2026-09-16), capped by
   the stress budget, ticker/sector concentration and Pluto's budget. Size is an output of 1–5, not an input.
7. Portfolio context: existing exposure in the ticker and in correlated names (SMCI/INTC/AMD/NVDA move together), net
   delta of the book, cash/shares available.
8. Execution: spread, size at the bid/ask, quote age, likelihood of a fill near the mid.
9. Events in the contract's life: earnings (excluded), macro releases (flagged; better: priced as extra variance),
   ex-dividend dates for calls (early assignment).

Deliberately left out until tested: a directional view (momentum tilt). The valuation assumes no drift; a CC/CSP is
directional, but no drift signal has been validated.

### Decision 2 — "above 5 sessions" means the option's remaining life, not YZ21's window

YZ21 looks **back** 21 sessions to estimate volatility. The horizon is how many sessions the option has **left** until
it expires. The 5-year test measured, for each horizon, whether "IV high vs forecast" predicted the seller's profit:

| options with … sessions left | 1 | 2 | 5 | 10 | 21 |
|---|---|---|---|---|---|
| YZ21 signal, Q5 − Q1, % of premium, 2023-02 → 2024-09 | 24.1 | 20.8 | 23.1 | 19.7 (n.s.) | −6.2 (n.s.) |
| same, 2024-10 → 2026-10 | 16.2 | 17.3 | 14.3 (borderline) | 17.3 (n.s.) | −0.6 (n.s.) |
| YZ252 signal, both periods at 21 sessions | | | | | 26.5 / 32.8 (both n.s.) |
| YZ63 (prod) signal at 21 sessions | | | | | −1.1 / 27.7 [5.6, 58.6] (inconsistent) |

So YZ21 is a proven signal for options expiring within about a week (1–5 sessions). For 2–4-week options nothing is
consistently significant (longer-window forecasts do better there, as volatility reverts to its long-run level, but
not significantly). Options: (a) restrict Signals/Pluto to ≤ 5 sessions until longer tenors are validated on
historical chains; (b) use YZ21 for all tenors and accept unproven behaviour beyond a week; (c) a horizon-dependent blend
of YZ21 and YZ252 (principled, untested). Recommendation: (a), then test (c) on the chains below.

### Decision 3 — one tail table, or one per type of underlying

The fat-tail shape differs by underlying (study B, 1 session, drift removed):

| group | fair ATM vol ÷ forecast | 0.10-delta put / call ÷ fair ATM |
|---|---|---|
| equity ETFs (QQQ, SMH, IGV, SPY) | 0.99 | 1.11 / 1.04 |
| TLT | 1.02 | 1.03 / 0.98 |
| mega/large caps | 0.90 | 1.09 / 1.11 |
| high-vol small/mid caps | 0.89 | 1.10 / 1.16 |
| crypto-linked (COIN, HOOD, BMNR) | 0.93 | 1.09 / 1.09 (wide CIs at longer horizons) |

ETFs and TLT are close to Black-Scholes at the money; single stocks are ~10% below it. One pooled table (ATM ≈ 0.91)
would undervalue ETF at-the-money options by ~8% of vol, making them look richer than they are; per-ticker tables are
too noisy (1–7 of 28 tickers differ significantly, CIs wide). Recommendation: two tables, **ETFs (incl. TLT)** and
**single stocks**, re-split later only if the chains show a group needs its own.

### Historical option chains: what is needed and who sells it

Needed: bid/ask (NBBO) for every strike and every expiry (weeklies and dailies included) of our ~30 underlyings, at
10:00 ET (plus a few other times of day for the rest-of-day and decay tests), 2021 → today. The underlying price can be
taken from put-call parity, as the fit already does.

| provider | what | history | price | fit |
|---|---|---|---|---|
| **ThetaData, Options Value** | 1-minute NBBO for all contracts; one request returns a whole chain at 10:00 (`expiration=*`, `start_time`) | since 2020-01 | **$40/month** (2 parallel requests) | Best: intraday, all strikes/expiries, ~36k requests ≈ a few hours. Licence says "individual personal use, no business use"; check whether trading through Menaris counts |
| ThetaData Standard / Pro | tick-level NBBO | 2016 / 2012 | $80 / $160 per month | not needed |
| MarketData.app Quant | end-of-day chains (closing quotes) | since 2005 | $125/month (10k credits/min; a chain costs ~1 credit per contract) | EOD only; no intraday tests |
| Massive (ex-Polygon) Options Advanced | historical quotes | 5+ years | $199/month | dearer than ThetaData for the same need |
| ORATS one-minute | 1-minute strikes with bid/ask, IV, underlying | since 2020-08 | $199/month + $1,500 backfill + S3 transfer $1–2k | all tickers only, ~50 TB |
| Databento OPRA cbbo-1m | 1-minute NBBO | since 2013 | usage-based ($/GB quoted per request), $125 free credit | possibly cheapest for 1 minute per day; needs a quote |
| Cboe DataShop Option EOD Summary | NBBO at 15:45 and close | since 2012 | $25 per underlying per month of history | ≈$20k+ for our list; no |

Recommendation: one or two months of ThetaData Value ($40–80) to pull 2021–2026 chains at 10:00 (plus 12:00 and 15:30),
after confirming the licence. Backup: a $125 Databento quote for the same minutes, or one month of MarketData.app Quant
for end-of-day chains.

## Round 4 — remaining decisions and the implementation (2026-10-10)

**Decided:** P1 approved (0.31 at 10:00, the hourly curve, half days ≈ 0.70). Grades on the edge margin before friction:
Strong ≥ 30%, Good ≥ 20%, Weak ≥ 10%, else Avoid. Long tenors graded normally and tested on staging. The drift gate is
measured in edge-margin points (default 10). Quarter-Kelly implemented now on the ATM calibration. The old Edge stays on
the Signals screen; the new figures get a UI mockup before any screen work. ThetaData tests wait for the subscription.

**Implemented (API, not yet deployed):**

| piece | where | what it does |
|---|---|---|
| Variance clock | `varianceClock.ts`, `marketSessionStatus.ts` | τ = rest of today (the P1 curve; 1.0 before the open; half days compressed, weight 0.704) + 1 per session to the expiry close |
| Forecast | `volatilityEdge.ts`, `volatilityForecastStore.ts` | YZ21 per session for the model (YZ63 kept for the old Edge); never reads a bar dated today (defect 5) |
| Tail tables + calibration | `volatilityModelTables*.ts`, `scripts/build-volatility-model-tables.ts` (`npm run model:build-tables`) | 500 bucket means of z per horizon 1–35, ETFs and stocks; ATM calibration at 1, 2, 3, 5, 10, 21 sessions; built from `iorio_research`, 33 tickers, 2011-06 → 2026-10, committed as `volatilityModelTables.generated.ts` |
| Valuation | `contractValuation.ts` | fair price, edge margin, Edge $ (expected P&L after friction), calibrated Edge $, expected / calibrated annualized return, PoP, average win/loss, 5% shortfall, 2σ stress, max profit / yield, P&L variances, grade |
| Scoring | `signalCandidates.ts`, `rollSignalCandidates.ts`, `signalsLiveScoring.ts` | every candidate, held leg and roll carries a `model` block; each quote valued at its own instant (snapshot quotes at the capture, day quotes at their time, live at now) with that instant's forward and spot; a stale surface is rolled forward by τ (defect 2) |
| Day Signals seed | `daySignalsSeed.ts`, `signalModelPredictionsStore.ts` | pool expiries chosen by the model (expected P&L > 0, Pluto's ranking); every valued candidate logged to `signal_model_predictions` for the monthly check (a re-run replaces the day's set) |
| Pluto | `candidateFilters.ts`, `postModelGates.ts`, `prompt.ts` (v4.0), `passRunner.ts`, `closeActions.ts`, `inputHash.ts` | filters, ranking (calibrated annualized return, then Edge $), drift gate, stress cap on τ, Kelly cap, buy-back hold value and the prompt all read the model; the day-move limit uses YZ21 |
| Jobs report | `majorMacroEventSources.ts`, `macroEventTiming.ts` | FRED release 50 (Employment Situation) captured, weighted heavy (defect 6) |
| Migrations | `20261010100001..3` | `max_edge_margin_drift_pts` (10) + prompt v4.0; `signal_model_predictions`; `day_signal_expiries.seed_best_expected_pnl_dollars / seed_best_edge_margin` |
| App | `plutoParameters.ts`, `api/pluto.ts`, `PlutoModelInputs.tsx` | drift setting renamed (pts), help texts for grade / Edge $ / yield, hold value shown on buy-backs |

Choices made while implementing (flag any you disagree with):
- **Ranking:** Pluto and the seed rank by calibrated annualized return, then the model's Edge $. Kelly's bankroll is
  Pluto's budget (NLV × capital budget %). Calls on shares already held are Kelly-capped on the option alone; buy-writes on
  shares + call.
- **Yield rule:** Pluto's minimum yield now reads the model's max annualized yield (premium after friction ÷ capital,
  annualized on sessions), not the old calendar-day yield. The Signals trading settings' own minimum yield (calendar
  basis, 50% on dev) still screens what reaches Pluto at all.
- **Stale snapshots:** a snapshot quote is valued at the capture on any later day. Valuing Tuesday's price over
  Saturday's shorter τ turned theta into "edge" (TLT showed 60% margins); caught in the end-to-end run and fixed.
- **Tables include NBIS's Yandex-era history** (pre-halt); excluded only by the generic rules (volume, contiguity,
  earnings sessions, IV plausibility).

What the calibration implies for sizing (realized margin, % of premium, for a predicted margin of …; raw bins, before the
Round 5 monotone fit now used):

| sessions left | 10% | 20% | 30% | 40% |
|---|---|---|---|---|
| 1 | 3.1 | 7.8 | 16.0 | 24.5 |
| 3 | 0.8 | 4.0 | 13.7 | 23.1 |
| 5 | 0.8 | 2.9 | 12.4 | 22.5 |
| 10 | −1.6 | 0.4 | 11.8 | 19.6 |
| 21 | −4.7 | −7.8 | −2.6 | 1.9 |

Kelly allows nothing when the calibrated Edge $ (calibrated margin × premium − friction) is ≤ 0, so in practice Pluto
sells contracts with more than ~10 sessions left only at margins near 40% or more, and Good-grade (20–30%) contracts
mostly within a week. The 10-session row is not monotonic (15% → −5.1%, 5% → +2.5%: bin noise); a monotone fit of the
calibration (isotonic) would stop the ranking from preferring a lower margin there. Not done: it changes the approved
method.

How often the cut points are reached (`tmp/model-research/V1_gradeDistributionByDay.mts`, every captured snapshot valued
at its capture, |delta| 0.10–0.35, 1–45 DTE, spread ≤ 15%, no yield floor): Strong contracts every day, 2–295 per day
(median ~50), Good 7–88. Most of the very high margins are ETF wings (TLT, QQQ) whose calibrated Edge $ is a few dollars.

Verification: 5,350 API tests pass (tsc clean; new tests for the clock, valuation, scoring at each quote's instant, rolls,
seed, prediction log, forecast loader, Kelly, stress τ, drift, prompt v4.0, settings route); the seed was run end to end
on the dev DB (13 tickers, pool and 527 predictions written and read back); the Pluto settings screen checked on desktop
and mobile, light and dark.

Still to do: the UI mockup for the new figures (then the Signals screen and Pluto views), deploying to staging, and the
ThetaData tests (strike-level backtest and calibration, tenors, weekend and rest-of-day from option prices, fills).

## Round 5 — same day: covered calls, the history table, names (2026-10-10)

**Decided by Marcelo:**
- A covered call is judged exactly like a cash-secured put: the strategy holds shares only with the call, so its risk
  figures (chance of profit, average win and loss, worst 5%, 2σ) are computed on the shares and the call together,
  outcome_i = option P&L_i + (S_i − F) × 100. At a strike equal to the forward that is, outcome by outcome, the put's
  payoff (put-call parity; a unit test pins it). Edge $ and the margin are unchanged (the shares' move averages zero).
  Consequence: an out-of-the-money covered call now shows the risk of the equivalent in-the-money put, e.g. SMCI $46
  call over 2.19 trading days: chance of profit 57% (86% on the call alone), worst 5% −$492 per contract.
- The history table is fitted monotone (isotonic, pooled by premium weight), with a 95% range per bin from a bootstrap over
  calendar months. The bins that move:

| trading days left | bin (model margin) | raw realized | 95% range | used now |
|---|---|---|---|---|
| 10 | −5% / 5% / 15% | +1.8% / +2.5% / −5.4% | [−4.2, 7.2] / [−3.4, 8.1] / [−15.2, 2.0] | −0.1% each |
| 21 | 5% / 15% / 24% | −0.1% / −8.7% / −7.0% | [−8.8, 8.1] / [−18.8, −0.1] / [−21.1, 5.4] | −3.8% each |
| 21 | 36% | +1.9% | [−25.4, 24.9] | +1.9% |

  The 1- to 5-day rows barely move. The top 21-day bin's range is so wide that history says nothing there.
- Names: EXP $ means exposure only. The model's expected profit as a yearly rate on EXP $ is **Edge Yield**; the
  history-corrected version is **Hist Yield**; "max profit / max yield" is now **premium after costs / premium yield**
  (the premium kept, not a cap: a covered call's shares can add the rise to the strike). Prompt fields follow:
  `edge_yield_ann_pct`, `hist_yield_ann_pct`, `premium_after_costs`, `premium_yield_ann_pct`. Edge $ and Worst 5% are
  shown per $10,000 of EXP $ on the screens.
- **Parked until the ThetaData chains:** longer-dated contracts (Pluto sizes most of them to zero, because history says
  they lost money). Candidates to test: a forecast that leans on longer history as the option's life grows, and grading
  on the history-corrected margin.

## Round 6 — yields, Kelly, Pluto's minimum (2026-10-12)

- **Yields are annualized on calendar days** (Marcelo): Edge Yield = Edge $ ÷ EXP $ × 365 ÷ days to expiry; Hist Yield and
  premium yield the same. The variance clock values the contract; the capital is tied up on weekends too, and every
  other yield on the platform uses 365. INTC $24.5 put, 2 days: 5.79 ÷ 2,450 × 365 ÷ 2 = 43% (27% on trading days). A
  Friday-to-Monday contract is now annualized over 3 days, not 1.3, so it ranks below a weekday one with the same premium.
- **Kelly for every covered call on shares + call**, one cap across contracts on shares already held and buy-writes.
  SMCI $46 call: 26 contracts (92 on the call alone).
- **Pluto's minimum is on Edge Yield, not Edge $** (Marcelo: a per-contract dollar floor ignores days to expiry, so it
  penalizes the short-dated contracts; `min_edge_yield_pct`; a roll's net Edge $ per contract is turned into a yield on
  the new leg's exposure and days). Default 15% (approved by Marcelo 2026-10-12): of the 41 Good-or-better candidates the
  12 captured days offered Pluto under staging's settings (on net exposure), 10% keeps all 41, 15% keeps 26 (24 with a
  positive Hist Yield, median 4%), 20% keeps 17 (15 positive, median 6%), 30% keeps 8 (all positive, median 12%).
  `tmp/model-research/V3_edgeYieldThreshold.mts` (V2, per $10k, did not separate positive from negative Hist Yield:
  large per-$10k edges are longer-dated).
- **EXP $ is net of the premium received, everywhere** (Marcelo): a put's cash reserved less its premium, a covered
  call's shares less the call's premium; one figure for Positions (EXP $, EXP %, the P&L % base and so Telegram's P&L %),
  Pluto's budget and limits, the order gate, the model's yields and Signals' yield and dollar risk. Rolls count the strike
  difference less their net credit. Unchanged on purpose: free cash (IBKR's cash balance already holds every premium, so
  it stays cash less the full strike of each put; netting again would count the premium twice) and the live exposure
  behind concentration and allocation (Risk & Limits, Pulse, Dashboard, Pluto's ticker and sector room), which already
  takes the option off at its live price (both kept, approved by Marcelo 2026-10-12). Signals' dollar risk had mixed units (strike × 100 − the per-share mid); it is
  now (strike − mid) × 100.

## Files

- This report and the three study write-ups (appendices) are in `docs/signal-engine-model-review/`:
  `study-A-realized-clock-and-forecast.md`, `study-B-tails-and-skew.md`, `study-C-pricing-inputs-and-ibkr.md`.
- The scripts and raw outputs stay in `tmp/model-research/` (not in git): `shared.mts`, `D1_termStructureClock.mts`,
  `D1b_marketWeekendWeight.mts`, `D2_rollForwardClock.mts`, `S6_sviFitAccuracy.mts`, `S11_realizedVsImpliedVsForecast.mts`,
  `S13_edgeVariantsVsRealizedPnl.mts`, `S13b_vrpPredictionAndPnlBuckets.mts`, `S14_intradayDecay.mts`,
  `S16_modelFreeVariance.mts`, `S17_historicalSignalBacktest.mts`, `P45_workedExample.mts`, `R0_refitOldSnapshots.mts`,
  `C1_atmCalibrationNewModel.mts`, `V1_gradeDistributionByDay.mts`,
  plus `A_*`, `B_*`, `C_*` with their outputs.
- Run any script with `DATABASE_URL=postgres://marcelo@localhost:5432/iorio_research npx tsx tmp/model-research/<file>`.
