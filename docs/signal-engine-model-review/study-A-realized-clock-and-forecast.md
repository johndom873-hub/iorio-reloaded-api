# Study A — volatility forecast: time unit, intraday start, forecaster accuracy, earnings, conditional bias

Research DB `iorio_research` (local, read-only copy of staging), daily bars 2021-09-24 .. 2026-10-09, hourly bars 2026-06-01 .. 2026-10-09. No application code and no remote database were touched. Every number below is produced by the `A_*.mts` scripts in this folder; the long tables are in the `A_out_*.md` files (paths at the end).

## Plain-language summary

- **Counting trading sessions (not calendar days) is right.** A weekend gap moves a stock about 1.2–1.3× as much as an ordinary overnight gap, not 3×. A Monday session as a whole is the same size as any other session (1.00×). Holidays behave like weekends.
- **The forecast forgets the rest of today.** Signals scores at about 10:00 but counts only the sessions after today. About 0.31 of a session's variance is still ahead at 10:00, so the variance to expiry is understated:
  - 24% for a 1-session contract
  - 13% for 2 sessions
  - 6% for 5 sessions
  - 1.4% for 21 sessions

  This is the clearest finding of the study (high confidence).
- **Accuracy on average.** On earnings-free windows the production forecast (YZ63) averaged about 9% too high over 2023–2026 (realized/forecast 0.92, not statistically different from 1). In the last 12 months it was on target (1.00).
- **It is badly wrong in specific situations.** Two cases:
  - Right after a volatility spike, realized variance comes in at 0.72× the forecast.
  - When option prices (implied vol) are low relative to YZ63, realized is 0.48× the forecast. When implied vol is high relative to YZ63, realized is 1.51× the forecast.

  The options market's own implied volatility was close to right in every one of those situations.
- **This matters for "Edge".** Edge = implied vol − YZ63. The largest Edges are therefore mostly YZ63 errors, not cheap premium.
- **The live 2× overstatement (Sep 23 – Oct 9 2026) reproduces in this data:** realized/forecast is 0.43–0.46. It is real but unusual. Over the past 5 years only about 2–3% of comparable two-week stretches were this extreme; the worst were in May 2025, after the April 2025 spike.
- **Earnings.** 97% of 63-session windows contain an earnings reaction, which inflates YZ63 by about 12% on average. Removing earnings from the window fixes the 2023–2026 average but makes the forecast too low in the last 12 months. The data does not clearly favour either version (low confidence).

---

## 0. Data, exclusions and method notes

Details: `A_out_dataQuality.md`.

**Calendar**
- Master calendar: 1,266 sessions. A date counts as a session when ≥ 15 tickers have a bar with volume > 0.
- The inferred holidays match the NYSE schedule exactly, including the 2025-01-09 day of mourning.
- There are no weekend or holiday bars.

**Exclusions**

| item | rule / reason |
| --- | --- |
| NBIS before 2024-10-21 | Yandex history (a different company). The 2022-02-28 .. 2024-10-18 halt is stored as **665 flat zero-volume bars, not as a calendar gap**, so a ">5-day gap" rule cannot detect it. The 2024-10-21 bar is an anchor only: its "overnight" 18.94 → 14.29 spans 2.6 years. 493 usable sessions remain. |
| BMNR before 2025-06-05 | OTC era: 257 zero-volume and 486 O=H=L=C bars, median volume 0–500 shares. The 2025-06-04 → 06-05 move (19.00 → 7.25) is the OTC-to-NYSE-American switch. 338 usable sessions remain. |
| COHR 2022-09-08 | Missing bar. The 2022-09-09 return, which spans 2 sessions, is dropped. No other ticker misses a session. |
| A4 universe | Tickers with ≥ 252 usable sessions. Excluded as too short: DRAM 131, GS 71, LITX 156, SNDK 72, SPCX 82. Flagged as short (< 2 years): AMAT 258, SPY 253, BMNR 338, NBIS 493. AMAT and SPY never reach the common sample, because YZ252 and LHAR need ≥ 252 sessions. |
| BSBR implied vol | Junk: median 1.2, range 0.18–6.3, against about 0.35 realized; per-ticker IV bias 0.03. Removed from IV30 and LHAR_IV_xE. |
| Hourly sessions | 2,342 ticker-days accepted on 92 dates. 22 rejected: 20 incomplete hourly sets; DELL 2026-06-26 (last hourly close 394.05 vs daily 399.49); DRAM 2026-07-30 (high mismatch). |

**Suspicious bars, kept:** these are real events, not errors.
- MRNA 2026-08-19: +0.61 overnight, +1.02 close-to-close, not earnings.
- BMNR 2025-06-30: +2.07 (ETH-treasury pivot).
- BE 2024-11-15: +0.46.
- NBIS 2025-01-27 (DeepSeek) and 2025-09-09.
- SMCI 2026-03-20.
- AAOI earnings days.

No unadjusted splits were found: no ±ln 2/3/10 moves with reversals, and NVDA/SMCI 2024 are smooth. Inside the usable sample no bar violates H ≥ max(O,C), L ≤ min(O,C) or volume > 0.

**Production formula reproduced exactly:** 3,244 windows checked against `computeYangZhangVolatility`, maximum relative error 1.0e-15 (`A_checkYangZhangMatchesProduction.mts`).

**Earnings rule**
- 981 of 1,034 events have no time of day. The TradingView rows use event_time 1 = after close, −1 = before open, 0 = unknown; this was confirmed against the price gaps (23 of 26 rows with a known time agree: 19 of 21 after-close, 4 of 5 before-open).
- s0 = first session on or after event_date; s1 = the next session. The reaction is the larger of the two opening gaps: 69.2% at s1 (after-close reports). 17.9% of events are ambiguous (larger/smaller gap < 2).
- A target window (t, t+h] is **earnings-contaminated if any event has s0 ∈ [t, t+h]**. This is production's rule (event_date ∈ [today, expiry]) plus weekend-dated events whose s1 falls in the window.
- Coverage check: 66 of 130 of the per-ticker top-5 gaps are earnings sessions. The rest are identifiable non-earnings news, e.g. 2024-08-05, 2025-04-09, DeepSeek, deals.

**Pooling and statistical inference**
- Squared returns are divided by a local scale before pooling, so every ticker and volatility regime weighs equally:
  - A1/A2: the ticker's ±31-session mean Rogers-Satchell variance (intraday, so it cannot leak overnight effects).
  - A3: the ticker's mean cc² over the hourly sample.
  - A4/A8: the ticker's mean YZ63.
- Raw pooled numbers are reported alongside.
- All confidence intervals come from a **moving-block bootstrap over calendar dates with all tickers resampled together**, so cross-sectional correlation and the overlap of windows are both respected. Block lengths: 21 sessions (A1/A2), 5 sessions (A3/A7 hourly), max(21, 3h) (A4/A8). Replicates: 1,000–2,000; 300–500 for medians.

---

## A1 — Overnight gap variance by gap type

Method: o = ln(Open_t / Close_t−1) for 32,041 usable sessions. Gap types:
- weekday: 1 calendar day
- weekend: Fri → Mon
- mid-week holiday: 2 calendar days
- long weekend: 4 calendar days (3-day weekends, Good Friday)

The ratio is mean(normalised o²) of the type divided by that of weekday nights. Drift is negligible: mean²/mean-square of o is 0.0005–0.0034.

**Pooled, earnings candidate sessions excluded (headline):**

| ratio | n (type / weekday) | mean o², normalised | mean o², raw pooled | median o² | 10% two-sided trimmed | 2.5% trimmed |
| --- | --- | --- | --- | --- | --- | --- |
| weekend / weekday | 5,695 / 24,228 | **1.286 [1.010, 1.612]** | 1.838 [1.011, 3.250] | 1.200 [0.963, 1.465] | 1.145 [0.967, 1.355] | 1.169 [0.989, 1.382] |
| mid-week holiday / weekday | 354 / 24,228 (14 dates) | 1.063 [0.641, 1.650] | 0.721 | 0.926 [0.557, 1.718] | 1.001 | 1.034 |
| long weekend / weekday | 917 / 24,228 (36 dates) | 1.203 [0.932, 1.520] | 1.018 | 1.590 [1.023, 2.347] | 1.474 [1.110, 1.990] | 1.402 [1.071, 1.836] |
| all holidays / weekday | 1,271 / 24,228 | 1.164 [0.919, 1.429] | 0.935 | 1.334 [0.934, 1.935] | 1.334 [1.037, 1.726] | 1.290 [1.004, 1.647] |

**Including earnings sessions**, weekend/weekday drops to 0.977 [0.768, 1.237]. Earnings gaps fall almost entirely on weekday nights, which inflates the denominator.

Robustness:
- Per ticker (≥ 20 weekends): median ratio 1.212, mean 1.410; 24 of 30 tickers above 1.
- Single stocks 1.353 [1.050, 1.713]; ETFs 1.103 [0.871, 1.383].
- Year to year it is unstable: 2022 0.86, 2023 0.85, 2024 1.52, 2025 2.15 (tariff weekends), 2026 0.96.
- In units of an average session's close-to-close variance:

| gap | variance, in sessions | excess over a weekday night, in sessions |
| --- | --- | --- |
| weekday night | 0.341 | — |
| weekend | 0.439 | **+0.098** |
| long weekend | 0.411 | +0.069 |
| mid-week holiday | 0.363 | +0.021 |

Benchmarks: a calendar-time model predicts 3.0 (calendar days) or 3.7 (65.5 h / 17.5 h). Measured: 1.15–1.29. **A weekend is about one extra night of moderately elevated variance, not three days** (high confidence; the point estimate of the uplift is moderate confidence).

## A2 — Variance by weekday

Method: per session, normalised cc², open-to-close² and o², each divided by the all-sessions mean. Post-holiday sessions (n = 1,146) and the 10 early closes (n = 251) are taken out of their weekday. Earnings candidate sessions excluded.

| category | n | close-to-close / all-days mean | open-to-close / all | overnight / all |
| --- | --- | --- | --- | --- |
| Mon | 5,671 | **1.003 [0.889, 1.122]** | 0.956 [0.874, 1.039] | 1.215 [0.982, 1.447] |
| Tue | 5,820 | 0.894 [0.814, 0.969] | 0.902 [0.832, 0.976] | 0.894 [0.768, 1.034] |
| Wed | 6,298 | 1.030 [0.923, 1.161] | 1.054 [0.928, 1.208] | 0.896 [0.765, 1.052] |
| Thu | 6,014 | 1.094 [1.009, 1.186] | 1.138 [1.025, 1.264] | 1.108 [0.975, 1.259] |
| Fri | 5,994 | **0.982 [0.901, 1.076]** | 0.985 [0.904, 1.079] | 0.891 [0.783, 1.008] |
| post-holiday | 1,146 | 1.024 [0.855, 1.227] | 0.881 [0.717, 1.065] | 1.079 [0.865, 1.317] |
| early close (13:00) | 251 | 0.700 [0.392, 1.133] | **0.496 [0.342, 0.636]** | 0.868 [0.307, 1.637] |

Direct contrasts:

| contrast | ratio [95% CI] |
| --- | --- |
| **Monday / Tue–Fri, close-to-close** | **1.002 [0.863, 1.154]** |
| Monday / Tue–Fri, median | 0.917 [0.793, 1.047] |
| Monday / Tue–Fri, 10% trimmed | 0.952 [0.847, 1.048] |
| Monday / Tue–Fri, open-to-close | 0.937 [0.839, 1.041] |
| Monday / Tue–Fri, overnight | 1.283 [0.983, 1.622] |
| **Friday / Tue–Thu, close-to-close** | **0.975 [0.873, 1.096]** |

Monday per ticker:
- Median 0.981; 13 of 30 above 1.
- Only TSLA is clearly above: 1.52 [1.18, 1.88].
- IGV 0.81, INTC 0.75, QQQ 0.76 and SMCI 0.70 are below.

By year: 2022 0.84, 2023 0.96, 2024 0.96, 2025 1.27 [0.79, 1.89], 2026 0.88.

**Answer:** a Monday session, including the weekend gap, equals a typical session. The extra weekend-gap variance is offset by a quieter Monday day session. Friday is not different. Thursday is the largest day (1.09; 1.18 including earnings, because Wednesday after-close reports land there). Early-close days carry about half the intraday variance (high confidence for Monday and Friday ≈ 1; the Thursday excess is moderate confidence).

## A3 — Intraday split, hourly bars

**Structure verified:**
- The first bar starts at 09:30 and covers 09:30–10:00; the rest start on the hour, ending with the 15:00 bar.
- The hourly 09:30 open equals the daily open.
- The closing-auction residual |ln(daily close / last hourly close)| is a median 2.3 bp (95th pct 15.6 bp). It is folded into the last segment, so the segments sum exactly to the close-to-close return.
- 5-minute bars cross-check ln(C/P10:00) within a median 2.1 bp (47 ticker-days).
- No early closes fall in the hourly sample.

Sample: 2,289 ticker-days without earnings, 31 tickers, one 4-month regime.

| segment | mean seg² / mean cc² [95% CI] | robust: median-based share | robust: 5% trimmed share |
| --- | --- | --- | --- |
| overnight (prior close → 09:30) | **0.412 [0.357, 0.476]** | 0.428 | 0.409 |
| 09:30–10:00 | **0.255 [0.218, 0.300]** | 0.239 | 0.256 |
| 10:00–11:00 | 0.128 [0.108, 0.151] | 0.130 | 0.129 |
| 11:00–12:00 | 0.071 [0.058, 0.087] | 0.071 | 0.068 |
| 12:00–13:00 | 0.035 [0.028, 0.043] | 0.037 | 0.036 |
| 13:00–14:00 | 0.033 [0.025, 0.043] | 0.028 | 0.031 |
| 14:00–15:00 | 0.032 [0.025, 0.040] | 0.025 | 0.027 |
| 15:00–16:00 | 0.061 [0.040, 0.090] | 0.042 | 0.044 |
| sum of segments (1 = no autocorrelation) | 1.026 [0.939, 1.134] | | |

**Cumulative "rest of day" weight.** w_rest(τ) = E[ln(close/P_τ)²] / E[cc²], i.e. the share of a full session's variance still ahead at time τ:

| seen from | w_rest [95% CI] | robust: ratio of medians | sum of remaining hourly variances |
| --- | --- | --- | --- |
| 09:30 (open) | 0.551 [0.501, 0.601] | 0.501 | 0.614 |
| **10:00** | **0.309 [0.264, 0.358]** | 0.313 | 0.360 |
| 11:00 | 0.193 [0.158, 0.235] | 0.185 | 0.232 |
| 12:00 | 0.143 [0.119, 0.170] | 0.137 | 0.161 |
| 13:00 | 0.113 [0.093, 0.142] | 0.090 | 0.126 |
| 14:00 | 0.082 [0.070, 0.097] | 0.064 | 0.093 |
| 15:00 | 0.061 [0.040, 0.090] | 0.037 | 0.061 |

Robustness of w_rest(10:00):
- Including earnings sessions: 0.290.
- Per ticker: median 0.302, mean 0.305, range 0.105 (MRNA) .. 0.513 (SPCX).
- By weekday, relative to the all-days mean: Mon 0.313, Tue 0.290, Wed 0.322, Thu 0.371, Fri 0.244.

The single 10:00→close return has less variance than the sum of its hourly pieces (0.309 vs 0.360), i.e. there is intraday mean reversion. For an unhedged option the single-return figure is the relevant one.

**Long-run caveat (moderate confidence).** Over 5 years of daily bars the open-to-close share is 0.644 (overnight 0.361). In the hourly period it is 0.562 (overnight 0.385). If 10:00→close stays about 56% of open-to-close, the long-run w_rest(10:00) is ≈ 0.36. Use 0.31 (measured) to 0.36 (regime-adjusted).

## A4 — Forecast accuracy

Method:
- 25 forecasters, all per-session variances built from bars ≤ t. See `A_out_A4.md` for definitions:
  - YZ10, YZ21, YZ63 (production), YZ126, YZ252
  - YZ63x, YZ21x, YZ63xd (ex-earnings)
  - CC21, CC63 (demeaned) and CC0_21, CC0_63 (zero-mean)
  - EWMA λ = 0.94
  - GK21, GK63 (with overnight term)
  - HAR in levels: HAR_RS, HAR_RS_xE, HAR_CC (per-ticker expanding OLS, direct h-step, ≥ 250 pairs; 187 of 423k forecasts floored)
  - LHAR, LHAR_xE: panel log-regressions on ln YZ10/21/63/252, expanding, out-of-sample, smearing-corrected, ≥ 2,000 pairs
  - LHAR_IV_xE: adds ln IV30²
  - BLEND63_21, SHRINK25_252, SHRINK50_252
  - IV30 = IBKR 30-day implied vol² / 252, as a market benchmark
- Target: RV_h = Σ squared close-to-close log returns over t+1..t+h.
- Common sample: rows where every non-IV forecaster exists. That is 2023-02 .. 2026-10, 26 tickers, about 20k rows per horizon.
- QLIKE is the primary ranking because it is robust to the noisy RV proxy. The MSE-of-log ranking is also in the file, but it is not robust to that noise.

**Pooled, earnings-free target windows (the only ones production trades), full common sample:**

| h | YZ63 bias [95% CI] | YZ63 mean ratio | YZ63 QLIKE rank / 25 | best by QLIKE (ΔQLIKE vs YZ63 [95% CI]) | LHAR (no IV) ΔQLIKE | YZ63x bias | IV30 bias |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0.921 [0.815, 1.049] | 1.002 | 10 | IV30 −0.062 [−0.090, −0.036]; LHAR_IV_xE −0.061 | −0.027 [−0.051, −0.008] | 1.023 | 1.036 |
| 2 | 0.920 [0.829, 1.051] | — | 11 | IV30 −0.063 [−0.090, −0.039] | −0.025 [−0.045, −0.007] | 1.022 | 1.040 |
| 3 | 0.919 [0.823, 1.040] | — | 10 | IV30 −0.062 [−0.090, −0.035] | −0.024 [−0.044, −0.006] | 1.022 | 1.045 |
| 5 | 0.920 [0.821, 1.060] | 1.011 | 9 | IV30 −0.056 [−0.082, −0.033]; LHAR_IV_xE −0.055 | −0.021 [−0.039, −0.005] | 1.023 | 1.055 |
| 10 | 0.928 [0.808, 1.100] | — | 9 | LHAR_IV_xE −0.049 [−0.078, −0.016] | −0.018 [−0.035, −0.002] | 1.032 | 1.089 |
| 21 | 0.942 [0.776, 1.127] | 1.050 | 9 | LHAR_IV_xE −0.059 [−0.105, −0.024] | −0.020 [−0.036, −0.005] | 1.044 | 1.174 |

**YZ63 bias by period** (earnings-free):

| period | h = 1 | 2 | 3 | 5 | 10 | 21 |
| --- | --- | --- | --- | --- | --- | --- |
| full (2023-02 → 2026-10) | 0.921 | 0.920 | 0.919 | 0.920 | 0.928 | 0.942 |
| since 2024-10-01 | 0.968 [0.82, 1.17] | 0.968 | 0.968 | 0.970 [0.82, 1.18] | 0.980 | 0.994 [0.78, 1.27] |
| last 12 months | 1.010 [0.88, 1.14] | 1.005 | 1.002 | 0.999 [0.89, 1.14] | 1.013 | 1.020 [0.98, 1.17] |

By year of t (h = 5): YZ63 2023 0.80, 2024 0.86, 2025 0.95, 2026 1.01. YZ63x 2023 0.91, 2024 1.02, 2025 1.01, 2026 1.11.

**Ranking, consistent at every horizon and in non-overlapping subsamples:**

1. IV30 ≈ LHAR_IV_xE.
2. LHAR (P(best among non-IV) = 0.60–0.77), then LHAR_xE.
3. A tied pack that includes YZ63: BLEND63_21, SHRINK25/50, GK63, YZ63x, EWMA, YZ21x, CC63, HAR levels, YZ126, YZ252, YZ21. All of their ΔQLIKE CIs contain 0.
4. Significantly worse than YZ63: CC21 and CC0_21 at every h (+0.05 to +0.06), YZ10 at h ≥ 2 (+0.04 to +0.07).

GK63 is "significantly" better by −0.0008, which is economically zero.

In the recent periods YZ63's rank improves (6th–9th in the last 12 months), and YZ63x becomes significantly worse than YZ63: since 2024-10, ΔQLIKE +0.013 to +0.022 with CIs above 0.

Other checks:
- **Non-overlapping windows** give the same top 3 and the same YZ63 bias (0.921–0.937).
- **Without MRNA** (its +102% non-earnings day), the YZ63 bias is 0.899–0.923 and YZ63x is 1.000–1.024.
- **Per ticker** YZ63 bias at h = 5 ranges from PLTR 0.68, CSCO 0.73 and DELL 0.78 up to MRNA 1.45. ETFs (IGV 1.04, QQQ 0.99, SMH 1.05, TLT 0.98) are ≈ 1. YZ63x lifts the earnings names: CSCO 1.05, DELL 1.05, COHR 0.97.

**Mean ratio vs ratio of means.** The mean ratio mean(RV/(F·h)) is ≈ 1.00–1.05, while the ratio of means is ≈ 0.92. The difference means YZ63 is too high precisely when it is high, which is the conditional bias of A8.

**Calendar content of the window** (YZ63 bias):
- h = 2: 0.971 with no weekend or holiday gap, 0.857 with one, 0.714 with two.
- h = 1 by target session: Mon 0.88, Tue 0.80, Wed 1.06, Thu 0.98, Fri 0.89.

Windows with weekends are not under-forecast. Adding calendar-day weight would make things worse.

## A5 — Earnings

| item | YZ63 | YZ21 |
| --- | --- | --- |
| (stock, date) windows containing a detected reaction | **96.8%** | 33.3% |
| forecast with / without earnings: ratio of means | **1.125** | 1.122 |
| median ratio, all dates | 1.082 | 1.000 |
| median ratio when the window contains a reaction | 1.086 | 1.254 |
| mean ratio when the window contains a reaction | 1.165 | 1.499 |
| 90th percentile when the window contains a reaction | 1.407 | 2.300 |

Size of a reaction:
- Mean reaction cc² = **8.91×** an ordinary session's mean; the median reaction is 3.48× (427 reactions).
- One reaction adds about +12.6% to a 63-session window mean and +37.7% to a 21-session one.
- YZ63xd (drop only the detected reaction session) is within 0.003 of YZ63x (drop both candidates). The unknown timing does not matter.

Share of stock target windows that are earnings-contaminated:

| h | 1 | 2 | 3 | 5 | 10 | 21 |
| --- | --- | --- | --- | --- | --- | --- |
| contaminated | 3.2% | 4.7% | 6.3% | 9.4% | 17.4% | 35.3% |

On contaminated windows realized is far above YZ63: realized/forecast is 4.78 (h = 1), 2.29 (h = 5), 1.33 (h = 21). The production exclusion is essential (high confidence).

**On earnings-free targets**, ex-earnings vs production:

| period | YZ63 bias | YZ63x bias | ΔQLIKE (YZ63x − YZ63) |
| --- | --- | --- | --- |
| full | 0.92 | 1.02 | tie at every h, e.g. h = 5: +0.0009 [−0.010, +0.014] |
| since 2024-10 | 0.97 | 1.05 | +0.014 [+0.002, +0.036], significantly worse |
| last 12 months | 1.00 | 1.10 | worse |

YZ21x vs YZ21: bias 0.90 → 1.01; QLIKE improves slightly (n.s.).

With the 10:00 correction (A7), YZ63x × (N + 0.309) is the most nearly unbiased combination in the June–October 2026 hourly sample (0.98–1.00).

**Verdict (low confidence):**
- Including earnings inflates the window by about 12% on average.
- Over 2023–2026 that inflation roughly matched YZ63's over-forecast, so YZ63x is "unbiased on average".
- In the rising-vol 2025–26 regime, keeping earnings in happens to offset the trailing estimator's lag.
- Neither dominates on QLIKE. Removing earnings is not a free win.

## A6 — Annualisation and the unit of time

**Sessions per year** (from bars): 2022 251, 2023 250, 2024 252, 2025 250. The mean of full years is **250.75**, so 252 is 0.5% high.

**It is irrelevant to Edge.** `forecastOnCalendarDayBasis` computes vol·√(N/252/T), and vol² = 252·σ²_session, so the 252 cancels exactly. Only the displayed "annualised" forecast is off, by √(252/250.75) = 0.25%.

**Stability across the week:** see A2.
- Per-session variance is flat across weekdays: Mon 1.00, Fri 0.98; only Thursday is 1.09.
- Weekend gaps are about 1.2–1.3 weekday nights.
- Windows that include weekends do not show under-forecasting (A4).

**Trading sessions are the right unit (high confidence). A calendar-day unit would overweight weekends by 2–3×.**

## A7 — Starting point at 10:00

Method:
- Scoring day t; F = YZ63 from daily bars ≤ t−1, i.e. what exists at 10:00.
- Realized = (ln close_t / P_10:00)² + Σ_{t+1..t+h} cc², with expiry at the close of t+h (h = production's N).
- Earnings-free windows. Hourly sample June–October 2026.

Forecast-free scaling check: realized from 10:00 divided by realized from the close of t, on the same windows. If per-session variance is constant, this ratio should equal (h + w)/h.

| h | measured [95% CI] | predicted by (h + 0.309)/h | production predicts | (h+1)/h predicts |
| --- | --- | --- | --- | --- |
| 1 | **1.273 [1.197, 1.378]** | 1.309 | 1.000 | 2.000 |
| 2 | 1.138 [1.100, 1.189] | 1.155 | 1.000 | 1.500 |
| 3 | 1.093 [1.066, 1.128] | 1.103 | 1.000 | 1.333 |
| 5 | 1.056 [1.039, 1.079] | 1.062 | 1.000 | 1.200 |
| 10 | 1.029 [1.020, 1.041] | 1.031 | 1.000 | 1.100 |
| 21 | 1.016 [1.010, 1.022] | 1.015 | 1.000 | 1.048 |

Bias = Σ realized / Σ forecast (1 = unbiased):

| h (N) | (i) F·h (production) | (ii) F·(h + 0.309) | (iii) F·(h + 1) | (ii) with YZ63x |
| --- | --- | --- | --- | --- |
| 0 | undefined | 0.816 [0.620, 1.053] | 0.252 | 0.891 |
| 1 | 1.175 [0.853, 1.540] | **0.898** [0.651, 1.177] | 0.587 | 0.980 |
| 2 | 1.045 | **0.905** | 0.697 | 0.988 |
| 3 | 1.003 | **0.909** | 0.752 | 0.993 |
| 5 | 0.968 | **0.912** | 0.807 | 0.995 |
| 10 | 0.946 | **0.918** | 0.860 | 1.002 |
| 21 | 0.892 | **0.879** | 0.851 | 0.960 |

Leave-one-ticker-out w is 0.303–0.315, and the results are identical.

**5-year analogue from the 09:30 open** (daily bars only, w_open = 0.647, 20k–29k windows):
- Production scaling drifts with horizon: 1.560 [1.405, 1.726] (h = 1), 1.245, 1.140, 1.055, 0.995, 0.967 (h = 21).
- F·(h + 0.647) is flat: **0.947, 0.941, 0.938, 0.934, 0.934, 0.938**.
- Measured realized(from open)/realized(from close) vs predicted (h + 0.647)/h: 1.672 vs 1.647 (h = 1), 1.338 vs 1.324 (h = 2), 1.136 vs 1.129 (h = 5).

**Answer:**
- (ii) is the correct scaling. It removes the horizon pattern completely, in both the 4-month hourly sample and the 5-year open-based analogue; what remains is the forecaster's level error.
- Production (i) under-states the variance ahead by w/(N+w): 23.6% at N = 1, 13.4% at N = 2, 9.3% at N = 3, 5.8% at N = 5, 3.0% at N = 10, 1.4% at N = 21.
- In volatility terms the contract forecast is too low by 12.6% (N = 1), 7.0%, 4.8%, 3.0% (N = 5), 1.5%, 0.7% (N = 21). Edge on short-dated contracts is overstated by that much.
- Counting today as a whole session (iii) overcorrects.
- High confidence on the direction and size. Use the intraday curve for other scoring times: 0.309 at 10:00, 0.193 at 11:00, 0.143 at 12:00, 0.113 at 13:00, 0.082 at 14:00, 0.061 at 15:00. The long-run 10:00 value may be about 0.36.

## A8 — Conditional bias / mean reversion

Method:
- YZ63 bias = Σ RV / Σ F·h in quintiles of the state at t. Earnings-free windows, full common sample, pooled quintile breakpoints.
- Every forecaster and every h is in `A_out_A8_full.md`.

**YZ63 bias by quintile (Q1 = low state):**

| state at t | h = 5: Q1 | Q2 | Q3 | Q4 | Q5 | h = 21: Q1 | Q5 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| (a) YZ21/YZ252 | 0.73 [0.62, 0.87] | 0.89 | 1.10 | 0.91 | 0.93 [0.76, 1.13] | 0.81 | 0.89 |
| (b) YZ63/YZ252 | 1.08 [0.97, 1.23] | 1.04 | 1.16 | 0.91 | **0.72 [0.57, 0.90]** | 1.15 [1.03, 1.31] | **0.68 [0.48, 0.91]** |
| (c) YZ63 percentile in own trailing 252 | 0.98 | 1.13 | 1.07 | 0.84 | 0.79 [0.64, 0.98] | 1.10 | 0.74 |
| (d) abs. 21-session return | 0.88 | 0.97 | 0.88 | 0.91 | 0.96 | 0.90 | 0.97 |
| (d′) signed 21-session return | 0.98 | 0.96 | 0.91 | 0.82 | 0.92 | 1.05 | 0.93 |
| (e) IV30²/YZ63 | **0.48 [0.43, 0.57]** | 0.82 | 1.07 | 1.12 | **1.51 [1.28, 1.83]** | 0.46 [0.37, 0.62] | 1.50 [1.35, 1.71] |

Reading the table:
- **(b) and (c): when YZ63 is high relative to its own history, realized comes in at about 0.70–0.80× the forecast** (mean reversion after spikes).
- (a): when the last month is calm relative to the year, YZ63 (which still carries the older, higher vol) is also too high (0.73).
- (d) and (d′): momentum and the size of the 21-day move carry no bias signal.
- **(e) is by far the strongest conditioning variable.** The quintile spread is 3.1×, and IV30 itself is flat across those quintiles: 1.03 / 1.12 / 1.19 / 1.01 / 0.97 at h = 5.

**Does a conditional forecast remove it?** SD across the 5 quintiles of ln(bias); 0 means equal bias in every quintile.

| forecaster | h5 (a) | h5 (b) | h5 (c) | h5 (e) | h21 (b) | h21 (e) |
| --- | --- | --- | --- | --- | --- | --- |
| YZ63 (production) | 0.15 | 0.19 | 0.15 | 0.43 | 0.23 | 0.46 |
| SHRINK50_252 | 0.25 | 0.15 | 0.13 | 0.34 | 0.16 | 0.36 |
| LHAR (ln YZ10/21/63/252) | 0.14 | **0.11** | **0.08** | 0.30 | 0.13 | 0.32 |
| LHAR_xE | 0.14 | 0.11 | 0.08 | 0.29 | 0.14 | 0.30 |
| **LHAR_IV_xE** (+ ln IV30²) | 0.13 | 0.11 | 0.09 | **0.09** | 0.13 | **0.10** |
| IV30 | 0.16 | 0.12 | 0.10 | 0.08 | 0.12 | 0.10 |

Quintile biases of the conditional models:
- LHAR_IV_xE on (e): 0.92 / 1.07 / 1.19 / 1.06 / 1.12 (h = 5).
- LHAR_IV_xE on (b): 0.98 / 1.08 / 1.29 / 1.11 / 0.97.

The log-regression removes about half of the RV-state bias. Only adding implied vol removes the IV/RV-state bias. The final LHAR_IV_xE coefficients put 0.75–0.94 weight on ln IV30², with ln YZ63 negative.

Remaining issue: the earnings-free-trained LHAR_xE and LHAR_IV_xE run about 5–10% low on average (bias 1.06–1.11 in A4; LHAR trained on all windows is 0.92). That is the 2024–26 rising-vol regime drift: LHAR_xE is 0.91 in 2023, 1.06 in 2024, 1.09 in 2025 and 1.17 in 2026 (h = 5).

**Live period, scoring dates 2026-09-23 .. 2026-10-09.** 17 tickers: BE, BMNR, COIN, HOOD, INTC, NBIS, SMCI, AAOI, DRAM, TLT, MRNA, NOK, WDC, AMD, NVDA, AAPL, TSLA. Earnings-free windows ending by 2026-10-09.

| h | n | YZ63 bias (norm / raw / mean ratio) | YZ21 | YZ63x | SHRINK50 | LHAR_xE | LHAR_IV_xE | IV30 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 204 | **0.456** / 0.444 / 0.452 | 0.74 | 0.48 | 0.50 | 0.69 | 0.74 | 0.70 |
| 2 | 187 | 0.453 | 0.73 | 0.48 | 0.50 | 0.66 | 0.73 | 0.70 |
| 3 | 170 | 0.446 | 0.73 | 0.47 | 0.49 | 0.65 | 0.71 | 0.70 |
| 5 | 136 | **0.435** | 0.72 | 0.46 | 0.48 | 0.62 | 0.69 | 0.69 |
| 10 | 51 | 0.431 | 0.73 | 0.45 | 0.49 | 0.61 | 0.71 | 0.74 |

On the 10:00 basis (hourly, 16 tickers): F·N gives 0.587 / 0.500 / 0.476 / 0.455 / 0.437 for N = 1, 2, 3, 5, 10, and F·(N + w) gives 0.448 / 0.433 / 0.432 / 0.429 / 0.424.

Per ticker, realized over 09-23..10-09 vs YZ63 at the 09-22 close:
- Median 0.34; 16 of 17 below 1. TLT is the exception at 1.45.
- Examples: HOOD 0.19, DRAM 0.21, AMD 0.22, BMNR 0.30, SMCI 0.30, MRNA 0.33, AAOI 0.66.

**Reproduced: the ≈2.2× overstatement is in the data.** How unusual is it? Over 1,190 overlapping historical 13-scoring-date blocks (same tickers, same rules):

| statistic | h = 1 | h = 5 |
| --- | --- | --- |
| median block bias | 0.88 | 0.88 |
| 5th percentile | 0.49 | 0.48 |
| 25th percentile | 0.73 | 0.73 |
| percentile of the live block | **3.1st** | **1.9th** |
| lowest blocks | starts 2025-05-13..15: 0.28–0.35 (after the April 2025 spike) | |

Even the vol-flat YZ252 and the implied-vol series overstated in this window (IV30 0.70). So part of the gap is a calm fortnight that nobody predicted. The rest is the systematic post-spike bias in (b) and (c).

---

## Challenged assumptions (what was checked and the outcome)

1. **Squared returns vs drift.** Drift is 0.05–0.34% of the second moment for overnight gaps and ≤ 1.4% of E[(Σr)²] at h = 21. Negligible.
2. **Sum of squares vs terminal return.** The variance ratio VR_h = E[(Σr)²]/E[Σr²] is 0.985 (h = 2), 0.979 (3), 0.945 [0.891, 1.004] (5), 0.911 [0.836, 1.011] (10), 0.912 [0.802, 1.045] (21) (`A_out_varianceRatio.md`). There is mild daily mean reversion, individually not significant. For an unhedged short option the terminal variance is about 5–9% below the RV target at h ≥ 5; the same holds intraday (0.309 vs 0.360). Low–moderate confidence.
3. **Overlapping windows.** Block bootstrap over dates (block ≥ 3h) for every CI. Non-overlapping subsamples reproduce the rankings and biases.
4. **Jumps dominate means.** Medians and trimmed means are given for A1–A3. A4 includes a without-MRNA sensitivity and the mean ratio vs ratio of means. The weekend effect survives the robust estimators (1.15–1.20).
5. **Pooling weights.** Normalised (equal ticker/regime weight) and raw pooled numbers are both reported. The raw numbers are noisier and dominated by BMNR, MRNA and AAOI.
6. **Small samples.** < 252 sessions are excluded from A4; < 504 sessions are flagged. The hourly sample is one 4-month regime, which is why w_rest has a long-run cross-check.
7. **Data errors.** NBIS halt and BMNR OTC era excluded; COHR missing date handled; BSBR IV removed. No split errors found.
8. **Earnings timing unknown for 95% of events.** Conservative two-session rule; detecting the reaction session instead gives the same result to 0.003.
9. **IV30 caveats.** IV30 is IBKR's 30-day implied series (closing value at t, assumed available at the close). It is not the per-strike SVI IV that Signals uses. On earnings-free windows realized/IV30² was 1.04–1.17 in 2023–26, i.e. IBKR's IV30 slightly UNDER-predicted realized variance; no variance risk premium is visible in this series.
10. **Open item, not verified.** `loadVolatilityForecast(ticker, header.tradingDateIso)` includes bars ≤ today. Staging `daily_price_bars.captured_at` shows rows first written intraday, e.g. 09:31 or 11:17 ET on the same date, and later completed. If today's partial bar is present at 10:00, the YZ63 window contains a full overnight gap plus a near-zero intraday range. This study assumes bars ≤ t−1 at 10:00.

---

## What this means for the model

| assumption in production | verdict | confidence | evidence |
| --- | --- | --- | --- |
| Variance scales with **trading sessions**, weekends/holidays unscaled | **Holds.** A Monday session is 1.002× a normal one; the weekend gap is 1.15–1.29 nights (+0.10 session), offset by a quieter Monday; windows with weekends are not under-forecast | high | A1, A2, A4 |
| Expected variance = σ²_session × N, N = sessions after the scoring date | **Does not hold at 10:00.** 0.309 [0.264, 0.358] of a session is still ahead; production under-states the variance ahead by 24% at N = 1, 13% at N = 2, 6% at N = 5, 1.4% at N = 21. F·(N + w_rest(τ)) fixes it (bias flat across horizons) | high | A3, A7 (hourly and 5-year open analogue) |
| 252 sessions/year | 250.75 actual. Irrelevant to Edge (cancels) | high | A6 |
| YZ63 is an unbiased forecast on earnings-free windows | **Unconditionally roughly yes**: 0.92 [0.82, 1.06] in 2023–26, 1.00 in the last 12 months. **Conditionally no**: 0.72 after spikes, 0.48 when IV ≪ YZ63, 1.51 when IV ≫ YZ63 | high (conditional pattern); moderate (unconditional level) | A4, A8 |
| YZ63 is the best available trailing-RV forecaster | It is in the tied pack with blends, shrinkage, GK63 and EWMA. Short windows (YZ10, CC21) are significantly worse. LHAR is significantly better (ΔQLIKE −0.02) | high | A4 |
| Earnings in the window are acceptable | They inflate YZ63 by about 12.5% (ratio of means). The ex-earnings variant is not better on QLIKE and is too low in the last 12 months | low | A5 |
| Edge = IV − YZ63 measures rich premium | **Largely does not.** In the top IV/YZ63 quintile realized = 1.51× YZ63 but 0.97× IV30; in the bottom quintile realized = 0.48× YZ63 ≈ IV | moderate–high (IV30 ≠ SVI IV) | A8 (e) |

**Options for Marcelo to decide.** These are not implemented, and any new formula needs sign-off.

1. Use N_eff = N + w_rest(scoring time):
   - 0.31 at 10:00 measured (0.36 is the regime-adjusted long-run estimate).
   - The intraday curve for other times.
   - Smallest change, largest certain gain, concentrated on 1–5-session contracts.
2. Address the conditional bias:
   - (a) Replace YZ63 with an out-of-sample log-HAR on ln YZ10/21/63/252. It significantly better at every h and halves the post-spike bias, without touching IV.
   - (b) Add the market's IV as a regressor (LHAR_IV_xE). That makes the forecast conditionally unbiased, but it changes the meaning of Edge, because IV would sit on both sides.
3. Leave weekend/holiday handling and the 252 constant as they are.
4. Ex-earnings YZ: no change recommended on this evidence. Revisit only together with option 2.

---

## Files

Scripts, run with `npx tsx tmp/model-research/<file>` from the repo root:

| file | purpose |
| --- | --- |
| `A_lib.mts` | loading, cleaning, exclusions, calendar, earnings mapping, normalisation, bootstraps |
| `A_forecastPanel.mts` | all forecasters, targets, earnings flags, A8 states |
| `A_checkYangZhangMatchesProduction.mts` | exactness check against production |
| `A_dataQuality.mts` | exclusions, suspicious bars, earnings timing, early closes, A6 counts |
| `A_overnightWeekend.mts` | A1 |
| `A_weekday.mts` | A2 |
| `A_intraday.mts` | A3; also exports the hourly loader used by A7 |
| `A_forecastAccuracy.mts` | A4, A5, A8 |
| `A_tenOclock.mts` | A7 |
| `A_varianceRatio.mts` | target assumption check |

Outputs:
- `A_out_dataQuality.md`, `A_out_A1.md`, `A_out_A2.md`, `A_out_A3.md`
- `A_out_A4.md` (every horizon × period table with CIs, per-ticker views, year/weekday/calendar breakdowns)
- `A_out_A4_metrics.csv` (every metric × ticker × horizon × period × window set × forecaster)
- `A_out_A5.md`, `A_out_A7.md`
- `A_out_A8.md` (headline and dispersion), `A_out_A8_full.md` (all forecasters × horizons × states)
- `A_out_varianceRatio.md`
