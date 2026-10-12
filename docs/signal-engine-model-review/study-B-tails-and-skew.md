# Study B — Is a flat volatility forecast the fair price across strikes? (realized-fair smile vs the Signals model)

Research only. No application code changed, no remote database touched. Everything below was computed from the LOCAL research copy (`iorio_research`) by the `B_*.mts` scripts listed at the end. Numbers in brackets are 95% block-bootstrap confidence intervals unless stated otherwise.

## Plain-language summary (for Juan)

- Signals judges every strike of an expiry against one number per stock: the recent realized volatility (the "forecast"). That implicitly assumes a stock's moves follow a bell curve with that width. The worry was that real moves have **lopsided crash risk**. If so, the market's higher prices for downside puts would be fair, and Signals would wrongly call puts "rich" and calls "cheap".
- **Over 2021–2026, these stocks did not show lopsided crash risk once earnings days are removed.** Big down days and big up days happened about equally often. Both happened about 3.7× more often than a bell curve predicts (e.g. a 3-sigma one-day drop: 0.50% of days vs 0.135%).
- What "fat tails on both sides" means for prices:
  - **Options near the current price are worth LESS than the forecast implies.** The fair at-the-money volatility is about **91–96% of the forecast**.
  - **Options far from the price (around 0.10 delta) are worth about what the forecast implies.**
- So the model's error is not "puts rich / calls cheap". It is **"at-the-money contracts look cheaper than they are, relative to far-out ones"**, by up to about **7 volatility points** on 1-day contracts and about **2–5 points** on 2–5 day contracts. Calls and puts are affected alike.
- **The market's own smile matches this realized "fair smile" closely inside the 0.10–0.50 delta band Signals trades** (within about 2 volatility points). The market charges clearly more than history justifies only for very far out-of-the-money puts (below roughly 0.05 delta), which Signals never trades.
- During the 12 days of captured option chains (23 Sep – 9 Oct 2026), market at-the-money volatility was 14–30% below the forecast. That is why almost every contract shows a negative Edge right now. Over 5 years of IBKR history, at-the-money options on these stocks were **not** systematically overpriced either.

## 1. What was tested

Production (`src/lib/volatilityEdge.ts`, `src/lib/realizedVolatility.ts`): Edge(K) = IV_SVI(K) − σ_f·√(N/T), with σ_f = Yang-Zhang 63-session per-session volatility (`computeYangZhangVolatility(bars, 63)`), N = sessions to expiry, T = calendar years. That is Black-Scholes with ONE volatility σ_f at every strike of a ticker. The study measures the volatility that would have been fair at each strike, given what actually happened after each date, and compares it with σ_f and with the market.

## 2. Data and exclusions (exact)

- `daily_price_bars`: 33 tickers. Derived session calendar (dates where ≥ 50% of tickers with data have a bar): 1,282 sessions 2021-09-01 → 2026-10-09 (2022: 251, 2023: 250, 2024: 252, 2025: 250). No bars on non-session dates.
- **NBIS**: the 2022-02-28 → 2024-10-18 halt is filled with **665 synthetic zero-volume flat bars** (constant 18.94, with a fake 18.94→8→18.94 round trip in March 2022). There is no calendar gap, so the brief's "> 5 calendar days" rule would not have caught it. These bars were dropped, which creates a 969-day segment break (2022-02-25 → 2024-10-21). No return or forecast crosses it.
- **BMNR**: all 927 bars before 2025-06-05 dropped (NYSE American uplisting). Before that it was an OTC micro-cap: median daily volume 10–37 shares in 2022–2024, 486 flat bars, 257 zero-volume bars, ±50–90% bid-ask bounce days. Its options only exist from July 2025 (IBKR IV starts 2025-07-23).
- Any other zero-volume or invalid bar: none found. COHR is missing one session (2022-09-08); windows spanning it are dropped (forecast left as production computes it).
- Flagged but kept (real events, verified by follow-on trading and IV):
  - MRNA 2026-08-19 +101.9% log (+177%), z = +22.9
  - NBIS 2022-02-24 −51.6% (invasion day)
  - NOK 2025-10-28 z = +11.5
  - BE 2024-11-15 z = +11.1
  - SMCI 2026-03-20 z = −10.2
  - MRNA has a dedicated sensitivity run without it.
- Origins t from 2021-09-24 (the first origins with a forecast are 2021-12-23 for most tickers). Short-history tickers are included (AMAT 196, DRAM 69, SPY 191, LITX 94, SPCX 20, SNDK 10, GS 9 origins) and tested separately ("long-history only" scope).
- Window counts (pooled, all tickers):

| h (sessions) | 1 | 2 | 3 | 5 | 10 | 21 |
|---|---|---|---|---|---|---|
| all windows | 30,068 | 30,033 | 29,998 | 29,928 | 29,754 | 29,392 |
| earnings-free (Signals rule) | 29,289 | 28,864 | 28,439 | 27,589 | 25,466 | 20,862 |
| earnings-free, strict ±2 sessions | 27,725 | 27,300 | 26,875 | 26,025 | 23,904 | 19,315 |
| earnings-free since 2024-10-01 | 13,023 | 12,820 | 12,617 | 12,211 | 11,197 | 9,013 |

- **Earnings rule** (identical to Signals' `expirySpansEarnings` + the before-open exception in `signalsStore`): a window from the close of t to the close of t+h is excluded when an earnings date E satisfies t ≤ E ≤ t+h, except a before-open report (`event_time = '-1'`) on t itself.
  - In close-to-close terms this excludes exactly the windows whose returns contain the reaction: before-open → return of session E; after-close or unknown → return of E or E+1.
  - Timing codes: `-1` before open, `1` after close, `0`/NULL unknown. All pre-2026 history (API Ninjas) is NULL, so unknown timing is treated as either.
  - Calendar validated against prices: the median max overnight gap at the event bar/next bar is 1.81σ vs 0.47σ on non-event pairs; 46.0% of events exceed 2σ vs 1.6% baseline. NULL-coded events gap at e+1 (median 1.19σ vs 0.47σ at e), i.e. mostly after-close.
  - Robustness: a strict rule (any earnings bar within [t−2, t+h+2]) changes nothing material (tables below).
- Forecast: the production function itself. My own Yang-Zhang implementation (used only for the ex-earnings variant) matches it with max relative difference 0.0 over all origins.

## 3. Methods

- **z_h** = ln(C_{t+h}/C_t) / (σ_f(t)·√h), σ_f(t) = production YZ63 per-session volatility from bars ≤ t (no look-ahead).
- **Strike grids.**
  - x-grid: ln(K/S_t) = x·σ_f√h, x ∈ {−3, −2.75, …, 3}; puts at x ≤ 0, calls at x ≥ 0.
  - δ-grid: strike at zero-rate Black-Scholes delta δ computed with σ_f (puts −0.05…−0.50, calls 0.05…0.50).
- **Empirical value**: mean of max(K−S_T,0)/S_t (put) or max(S_T−K,0)/S_t (call). Three return variants:
  - **raw** — actual returns.
  - **trail** — r − h·g(t), with g(t) = ln(mean of the trailing ≤ 252 daily gross returns). This uses information at t only and makes the trailing price process a martingale.
  - **full** — r − c_ticker, with c chosen so the ticker's sample mean of e^r is exactly 1. This is a look-ahead sensitivity: a per-ticker martingale.
- **Fair-vol multiplier λ\***: solves Σ_windows BS(K_i, λ·σ_f,i√h) = Σ_windows payoff_i (zero rate, S = 1). This is premium-weighted pooling; equal-weight pooling is a robustness scope.
  - λ\* = fair vol / σ_f. Solved on a 61-point log grid 0.20–4.06.
  - Brute-force bisection check (`B_07`) agrees to ≤ 0.0005 at every checked cell.
- **LEVEL** = λ\* of the x = 0 straddle. **SHAPE** = λ\*(cell) / LEVEL. "x′" = moneyness in fair-ATM units, ln(K/S)/(LEVEL·σ_f√h), which is the same standardization as the market's ln(K/F)/√w_ATM.
- **CIs**: circular moving-block bootstrap over origin dates (block 63 sessions, all tickers of a date drawn together, so both overlap and cross-ticker correlation are preserved). 1,000 resamples for pooled scopes, 400 for groups/tickers/robustness scopes; 95% percentile intervals.
  - Block-length sensitivity (21 / 63 / 126) changes CI widths by ≤ 0.015 (T7 in `B_06_tables.txt`).
- **Market (B4)**: all 1,231 `ok` SVI slices.
  - N = sessions in (trading_date, expiry], using the derived calendar plus `market_calendar` for future dates.
  - σ_f from bars strictly before the snapshot date, i.e. the information at the ~10:00 ET capture.
  - Earnings-spanning slices (471) are excluded from all comparisons.
  - Shape points are only used inside each slice's fitted [k_min, k_max].
  - Horizon buckets: N = 1, 2, 3, 4–6 (≈5), 8–12 (≈10), 18–24 (≈21).

## 4. B1 — standardized returns

### Pooled, earnings-free (the sample that matters for Signals)

| h | n | mean | std | skewness | excess kurtosis | robust skew (1%/99%) |
|---|---|---|---|---|---|---|
| 1 | 29,289 | 0.024 [−0.008, 0.057] | 1.006 [0.962, 1.050] | 0.39 [−0.19, 1.34] | 13.86 [3.73, 32.93] | −0.007 [−0.040, 0.023] |
| 2 | 28,864 | 0.034 [−0.012, 0.084] | 1.007 [0.958, 1.050] | 0.08 [−0.32, 0.62] | 5.87 [2.24, 11.80] | −0.007 [−0.049, 0.037] |
| 3 | 28,439 | 0.042 [−0.017, 0.101] | 1.005 [0.958, 1.051] | 0.01 [−0.36, 0.47] | 4.34 [1.69, 7.86] | −0.011 [−0.055, 0.042] |
| 5 | 27,589 | 0.054 [−0.028, 0.126] | 0.992 [0.948, 1.035] | 0.01 [−0.35, 0.40] | 3.24 [0.98, 5.99] | −0.015 [−0.074, 0.044] |
| 10 | 25,466 | 0.074 [−0.037, 0.183] | 0.983 [0.931, 1.033] | 0.04 [−0.21, 0.35] | 1.69 [0.63, 3.06] | 0.000 [−0.068, 0.060] |
| 21 | 20,862 | 0.104 [−0.049, 0.263] | 0.984 [0.926, 1.040] | 0.09 [−0.15, 0.31] | 0.94 [0.44, 1.59] | 0.036 [−0.056, 0.093] |

Quantiles (normal in the first row; earnings-free; CIs in `B_03_standardized_returns.txt`):

| h | 0.5% | 1% | 2.5% | 5% | 10% | 25% | 50% | 75% | 90% | 95% | 97.5% | 99% | 99.5% |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| normal | −2.58 | −2.33 | −1.96 | −1.64 | −1.28 | −0.67 | 0 | 0.67 | 1.28 | 1.64 | 1.96 | 2.33 | 2.58 |
| 1 | −3.00 | −2.49 | −1.97 | −1.55 | −1.14 | −0.55 | 0.02 | 0.61 | 1.18 | 1.57 | 1.96 | 2.50 | 3.02 |
| 2 | −2.97 | −2.48 | −1.93 | −1.57 | −1.15 | −0.56 | 0.04 | 0.63 | 1.22 | 1.60 | 1.98 | 2.53 | 2.96 |
| 3 | −2.87 | −2.46 | −1.96 | −1.55 | −1.16 | −0.55 | 0.05 | 0.65 | 1.23 | 1.63 | 1.99 | 2.51 | 2.94 |
| 5 | −2.75 | −2.37 | −1.91 | −1.56 | −1.17 | −0.55 | 0.06 | 0.66 | 1.25 | 1.63 | 1.97 | 2.42 | 2.87 |
| 10 | −2.67 | −2.31 | −1.88 | −1.51 | −1.14 | −0.54 | 0.08 | 0.69 | 1.27 | 1.64 | 2.00 | 2.47 | 2.85 |
| 21 | −2.52 | −2.23 | −1.82 | −1.49 | −1.11 | −0.53 | 0.11 | 0.72 | 1.30 | 1.68 | 2.08 | 2.62 | 2.97 |

Tail frequencies, earnings-free (normal: P(z<−3) = 0.135%, P(z<−2) = 2.28%, P(z<−4) = 0.0032%):

| h | z<−4 | z<−3 | z<−2 | z>2 | z>3 | z>4 |
|---|---|---|---|---|---|---|
| 1 | 0.13% [0.06, 0.23] | 0.50% [0.35, 0.70] | 2.38% [1.92, 2.84] | 2.34% [1.99, 2.72] | 0.51% [0.40, 0.62] | 0.16% [0.10, 0.23] |
| 5 | 0.08% [0.03, 0.16] | 0.31% [0.16, 0.52] | 2.08% [1.47, 2.81] | 2.41% [1.81, 3.05] | 0.40% [0.23, 0.60] | 0.10% [0.02, 0.21] |
| 21 | 0.03% [0.00, 0.07] | 0.20% [0.05, 0.45] | 1.70% [0.96, 2.61] | 2.96% [1.73, 4.55] | 0.49% [0.19, 0.85] | 0.13% [0.02, 0.29] |

What B1 says:

- **Fat tails, no negative skew.** The body is narrower than normal (5%/95% quantiles ±1.55–1.57 vs ±1.645) and the extreme tails are fatter. Both tails are equally heavy: robust skew is 0 ± 0.04 at every horizon.
- The moment skewness is positive and fragile. **Removing the MRNA 2026-08-19 windows** moves h=1 skewness from 0.39 to −0.01 [−0.27, 0.24] and excess kurtosis from 13.86 to 5.00 [3.33, 6.87] (h=21: 0.05 and 0.82).
- **Std(z) ≈ 1.00 in earnings-free windows**, so the forecast's variance is unbiased there, but only because two effects cancel (see §8, B5).
- All windows (earnings included): std 1.070 (h=1) and 1.070 (h=21); P(z<−3) 0.70%, P(z>3) 0.71% at h=1.
- Since 2024-10-01 (earnings-free): std 1.035 (h=1), 0.959 (h=21); mean +0.052 [0.012, 0.097] at h=1, i.e. a significant positive drift.
- Per ticker (earnings-free, h=5 shown in `B_03`):
  - Significantly negative skew (CI excludes 0): QQQ −0.33 [−0.53, −0.12], SMH −0.22 [−0.46, −0.00], CSCO −0.43 [−0.81, −0.01], NOK −0.35 [−0.79, −0.03], PLTR −0.25 [−0.52, −0.01].
  - Significantly positive skew: AAOI 0.49 [0.14, 0.72], INTC 0.53 [0.18, 0.84], BE 1.11 [0.02, 2.11].
  - TLT is nearly normal (excess kurtosis 0.1 at h=5).

## 5. B2 — fair value of OTM options under the empirical distribution

### LEVEL: fair ATM vol / σ_f (x = 0 straddle)

| scope | h=1 | h=2 | h=3 | h=5 | h=10 | h=21 |
|---|---|---|---|---|---|---|
| **earnings-free, raw** | **0.907** [0.857, 0.948] | **0.925** [0.875, 0.967] | **0.930** [0.884, 0.969] | **0.926** [0.881, 0.965] | **0.933** [0.880, 0.987] | **0.960** [0.883, 1.044] |
| earnings-free, trail (drift removed, info at t) | 0.911 [0.861, 0.954] | 0.933 [0.881, 0.977] | 0.941 [0.891, 0.984] | 0.942 [0.893, 0.987] | 0.958 [0.900, 1.010] | 0.984 [0.925, 1.048] |
| earnings-free, full-sample drift (look-ahead) | 0.906 [0.856, 0.948] | 0.922 [0.870, 0.964] | 0.924 [0.875, 0.964] | 0.916 [0.870, 0.958] | 0.913 [0.856, 0.966] | 0.917 [0.857, 0.982] |
| earnings-free, equal weight per window, raw | 0.930 [0.884, 0.970] | 0.951 [0.904, 0.992] | 0.956 [0.907, 0.996] | 0.958 [0.912, 1.002] | 0.970 [0.917, 1.020] | 0.994 [0.927, 1.081] |
| earnings-free, strict ±2, raw | 0.903 | 0.920 | 0.925 | 0.921 | 0.929 | 0.955 |
| earnings-free, without MRNA jump, raw | 0.905 | 0.923 | 0.928 | 0.923 | 0.927 | 0.953 |
| earnings-free, long-history tickers only, raw | 0.907 | 0.926 | 0.933 | 0.932 | 0.944 | 0.967 |
| earnings-free raw, since 2024-10-01 | 0.909 [0.826, 0.978] | 0.921 | 0.927 | 0.918 | 0.904 [0.818, 0.987] | 0.946 [0.850, 1.051] |
| earnings-free raw, before 2024-10-01 | 0.906 [0.861, 0.952] | 0.929 | 0.934 | 0.935 | 0.961 | 0.973 [0.872, 1.110] |
| ALL windows (earnings inside), raw | 0.937 [0.887, 0.978] | 0.962 | 0.973 | 0.979 | 1.004 | 1.062 [0.984, 1.144] |
| earnings-free, forecast = YZ63 without earnings-reaction sessions | 0.956 [0.906, 1.002] | 0.976 | 0.981 | 0.977 | 0.984 | 1.012 [0.936, 1.107] |

### Fair vol / σ_f along the strike grid (earnings-free)

Trail = drift removed with information at t; raw = actual returns. The full grid with CIs is in `B_06_tables.txt` (T2a–T2f).

| x | trail h=1 | trail h=5 | trail h=21 | raw h=1 | raw h=5 | raw h=21 | full h=1 | full h=5 | full h=21 |
|---|---|---|---|---|---|---|---|---|---|
| put −3 | 1.278 | 1.213 | 1.319 | 1.271 | 1.158 | 1.046 | 1.280 | 1.181 | 1.137 |
| put −2 | 1.092 | 1.075 | 1.127 | 1.070 | 0.999 | 0.918 | 1.085 | 1.036 | 1.006 |
| put −1 | 0.967 | 0.987 | 1.017 | 0.931 | 0.894 | 0.823 | 0.958 | 0.955 | 0.941 |
| put 0 | 0.916 | 0.954 | 0.998 | 0.844 | 0.790 | 0.697 | 0.906 | 0.916 | 0.917 |
| call 0 | 0.906 | 0.930 | 0.969 | 0.970 | 1.063 | 1.224 | 0.906 | 0.916 | 0.917 |
| call +1 | 0.980 | 0.984 | 1.013 | 1.005 | 1.039 | 1.118 | 0.976 | 0.970 | 0.973 |
| call +2 | 1.138 | 1.096 | 1.125 | 1.151 | 1.128 | 1.198 | 1.137 | 1.088 | 1.106 |
| call +3 | 1.369 | 1.296 | 1.297 | 1.374 | 1.313 | 1.346 | 1.365 | 1.290 | 1.267 |

Empirical mean payoff ÷ BS(σ_f) value (raw, earnings-free; this is the ratio the brief asked for):

| x | h=1 | h=5 | h=21 |
|---|---|---|---|
| put −3 | 10.19 [5.27, 16.15] | 4.55 [1.60, 8.00] | 1.65 [0.22, 3.99] |
| put −2 | 1.51 [1.08, 2.01] | 0.99 [0.62, 1.41] | 0.56 [0.26, 0.98] |
| put −1 | 0.81 [0.67, 0.94] | 0.71 [0.55, 0.90] | 0.54 [0.34, 0.77] |
| put 0 | 0.84 [0.77, 0.91] | 0.79 [0.69, 0.90] | 0.70 [0.54, 0.86] |
| call 0 | 0.97 [0.92, 1.01] | 1.06 [0.97, 1.16] | 1.22 [0.98, 1.50] |
| call +1 | 1.01 [0.89, 1.12] | 1.11 [0.93, 1.31] | 1.36 [0.90, 1.93] |
| call +2 | 2.26 [1.78, 2.71] | 2.02 [1.29, 2.83] | 2.76 [1.20, 5.06] |
| call +3 | 18.4 [10.9, 26.4] | 13.1 [3.5, 24.3] | 15.7 [2.6, 34.7] |

Ratios explode in the far tails because the Black-Scholes value there is tiny. In volatility terms the same tails are only λ\* ≈ 1.2–1.4.

Reading B2:

- With drift removed (trail or full), the realized-fair curve is a **symmetric U-shaped smile**:
  - about 0.91σ_f at the money at h=1,
  - crossing 1.0 near |x| ≈ 1.2–1.5,
  - about 1.09–1.14σ_f at |x| = 2,
  - about 1.27–1.37σ_f at |x| = 3.
- The call side is slightly heavier than the put side at short horizons.
- With raw returns, the strong positive drift of this sample (a survivorship effect, §10) cheapens puts and enriches calls. At h=21 the ATM put is 0.697σ_f and the ATM call 1.224σ_f.

## 6. B3 — the same in delta terms (strikes at σ_f-delta)

Fair vol / σ_f (λ\*) and shape (λ\*/LEVEL), earnings-free, **trail** (drift removed with information at t):

| delta | h=1 λ / shape | h=2 | h=3 | h=5 | h=10 | h=21 |
|---|---|---|---|---|---|---|
| put −0.10 | 0.994 / **1.092** [1.061, 1.125] | 0.995 / 1.066 [1.029, 1.104] | 1.002 / 1.065 [1.025, 1.105] | 1.003 / 1.065 [1.011, 1.113] | 1.019 / 1.064 [0.988, 1.128] | 1.034 / 1.051 [0.943, 1.140] |
| put −0.20 | 0.950 / **1.043** [1.016, 1.070] | 0.957 / 1.025 [0.990, 1.058] | 0.969 / 1.030 [0.988, 1.068] | 0.975 / 1.035 [0.976, 1.086] | 0.991 / 1.034 [0.952, 1.103] | 1.008 / 1.024 [0.903, 1.129] |
| put −0.30 | 0.927 / **1.018** [0.987, 1.046] | 0.942 / 1.010 | 0.954 / 1.014 | 0.962 / 1.021 | 0.981 / 1.024 | 1.000 / 1.016 |
| put −0.50 | 0.917 / 1.007 | 0.943 / 1.010 | 0.952 / 1.011 | 0.958 / 1.017 | 0.982 / 1.025 | 1.008 / 1.025 |
| call 0.50 | 0.907 / 0.996 | 0.928 / 0.994 | 0.935 / 0.993 | 0.933 / 0.991 | 0.946 / 0.987 | 0.979 / 0.995 |
| call 0.30 | 0.937 / **1.029** [0.996, 1.063] | 0.951 / 1.019 | 0.955 / 1.015 | 0.956 / 1.014 | 0.964 / 1.006 | 0.999 / 1.015 |
| call 0.20 | 0.965 / **1.060** [1.024, 1.096] | 0.975 / 1.044 [1.004, 1.088] | 0.978 / 1.039 | 0.977 / 1.037 [0.979, 1.097] | 0.983 / 1.026 | 1.016 / 1.032 [0.926, 1.148] |
| call 0.10 | 1.019 / **1.119** [1.073, 1.167] | 1.018 / 1.091 [1.043, 1.146] | 1.021 / 1.085 [1.033, 1.142] | 1.017 / 1.079 [1.012, 1.148] | 1.018 / 1.063 [0.981, 1.151] | 1.052 / 1.069 [0.950, 1.189] |

Shape at δ 0.10 / 0.20 / 0.30 under the other drift treatments:

| scope | h | put −0.10 | put −0.20 | put −0.30 | call 0.10 | call 0.20 | call 0.30 |
|---|---|---|---|---|---|---|---|
| full-sample drift | 1 | 1.086 | 1.039 | 1.014 | 1.122 | 1.062 | 1.032 |
| full-sample drift | 5 | 1.056 | 1.024 | 1.008 | 1.093 | 1.049 | 1.024 |
| full-sample drift | 21 | 1.022 | 1.007 | 1.000 | 1.113 | 1.059 | 1.028 |
| raw (with drift) | 1 | 1.059 | 1.003 | 0.970 | 1.145 | 1.095 | 1.074 |
| raw (with drift) | 5 | 0.985 | 0.939 | 0.905 | 1.145 | 1.118 | 1.112 |
| raw (with drift) | 21 | 0.864 | 0.822 | 0.789 | 1.187 | 1.169 | 1.180 |
| equal weight, trail | 1 | 1.098 | 1.047 | 1.020 | 1.099 | 1.048 | 1.022 |
| equal weight, trail | 21 | 1.039 | 1.017 | 1.009 | 1.047 | 1.020 | 1.008 |

The **platform's band (|δ| 0.10–0.50)** sits where the fair curve is close to σ_f in absolute terms: λ\* = 0.91–1.05 across all horizons. At the 0.10-delta edges λ\* ≈ 0.99–1.05. Near 0.40–0.50 delta λ\* ≈ 0.91–1.01.

## 7. B4 — market smile vs realized-fair smile

### Market LEVEL vs the forecast, 12 capture days (earnings-free slices)

| bucket | slices (tickers) | market √(w_ATM/N)/σ_f | rest-of-day adjusted √(w_ATM/(N+f))/σ_f | realized-fair LEVEL (raw) | market ÷ realized-fair |
|---|---|---|---|---|---|
| 1 | 31 (18) | 0.802 [0.749, 0.851] | 0.706 [0.667, 0.747] | 0.907 | 0.78 |
| 2 | 35 (20) | 0.747 [0.685, 0.828] | 0.698 [0.643, 0.770] | 0.925 | 0.75 |
| 3 | 31 (16) | 0.823 [0.695, 0.996] | 0.784 [0.667, 0.944] | 0.930 | 0.84 |
| ≈5 | 117 (24) | 0.800 [0.713, 0.921] | 0.776 [0.694, 0.891] | 0.926 | 0.84 |
| ≈10 | 152 (23) | 0.833 [0.697, 1.014] | 0.819 [0.687, 0.996] | 0.933 | 0.88 |
| ≈21 | 109 (19) | 0.868 [0.727, 1.032] | 0.862 [0.722, 1.023] | 0.960 | 0.90 |

f = share of a close-to-close day's variance still ahead at 10:00 ET. Measured from hourly bars: f = 0.268 over 2,351 ticker-days (June–Oct 2026); per ticker 0.11 (MRNA) to 0.48 (SPCX). CIs are ticker-cluster bootstrap.

5-year check (IBKR historical 30-day IV, `B_08`; h=21, earnings-free, no earnings within 30 calendar days; BSBR excluded as unusable IV):

| scope | market ATM / σ_f | realized-fair ATM / σ_f | realized-fair ATM ÷ market ATM |
|---|---|---|---|
| pooled | 0.905 [0.866, 0.936] | 0.965 [0.892, 1.057] | 1.066 [0.982, 1.168] |
| since 2024-10-01 | 0.895 [0.820, 0.958] | 0.956 | 1.068 [0.951, 1.224] |
| before 2024-10-01 | 0.914 | 0.973 | 1.065 [0.960, 1.212] |

Per-ticker fair ÷ market: QQQ 0.983, SMH 1.029, IGV 0.988, TLT 0.924, single names 0.85 (NOK) – 1.26 (NBIS).

- Over 5 years, ex-event ATM options on this universe were priced at or slightly **below** what realized moves justified. There is no measurable ATM variance risk premium (CI includes 1).
- In the 12-day capture window the market sat 10–25% below realized-fair ATM.

### SHAPE, pooled (earnings-free, own-ATM units x′)

Market = mean IV(x′)/IV_ATM over slices containing the point. Realized = trail. "vp" = (market − realized) × bucket median ATM IV.

| x′ | b1 market / realized / vp | b2 | b3 | b≈5 | b≈10 | b≈21 |
|---|---|---|---|---|---|---|
| −2.00 | 1.235 / 1.170 / **+4.3** | 1.218 / 1.146 / +4.9 | 1.217 / 1.146 / +3.7 | 1.189 / 1.128 / +3.6 | 1.158 / 1.141 / +1.0 | 1.170 / 1.141 / +1.8 |
| −1.50 | 1.103 / 1.106 / −0.2 | 1.080 / 1.085 / −0.3 | 1.092 / 1.086 / +0.3 | 1.083 / 1.082 / +0.1 | 1.094 / 1.085 / +0.5 | 1.094 / 1.075 / +1.2 |
| −1.00 | 1.037 / 1.053 / −1.1 | 1.033 / 1.037 / −0.3 | 1.040 / 1.040 / 0.0 | 1.038 / 1.044 / −0.3 | 1.044 / 1.043 / 0.0 | 1.054 / 1.032 / +1.3 |
| −0.50 | 1.006 / 1.016 / −0.6 | 1.007 / 1.009 / −0.1 | 1.010 / 1.013 / −0.1 | 1.013 / 1.020 / −0.4 | 1.013 / 1.022 / −0.5 | 1.017 / 1.012 / +0.3 |
| +0.50 | 1.010 / 1.021 / −0.7 | 1.009 / 1.012 / −0.2 | 1.007 / 1.008 / −0.1 | 1.004 / 1.005 / −0.1 | 1.003 / 0.996 / +0.4 | 0.997 / 1.003 / −0.4 |
| +1.00 | 1.036 / 1.065 / −1.9 | 1.037 / 1.049 / −0.8 | 1.034 / 1.044 / −0.5 | 1.030 / 1.039 / −0.6 | 1.027 / 1.026 / +0.1 | 1.022 / 1.029 / −0.4 |
| +1.50 | 1.059 / 1.129 / **−4.6** | 1.077 / 1.102 / −1.7 | 1.070 / 1.095 / −1.3 | 1.074 / 1.086 / −0.7 | 1.071 / 1.069 / +0.1 | 1.049 / 1.072 / −1.4 |
| +2.00 | 1.088 / 1.213 / **−8.2** | 1.105 / 1.177 / −4.9 | 1.102 / 1.163 / −3.1 | 1.131 / 1.146 / −0.9 | 1.146 / 1.132 / +0.8 | — |

Against **raw** realized (with drift) the picture becomes "market puts rich by 1–15 vp, market calls cheap by 2–14 vp". That is purely the sample's drift (§10), not tail shape.

### SHAPE, ticker-matched

Each ticker's market smile minus that ticker's own realized-fair smile (full-sample drift), weighted by slices. CI = ticker-cluster bootstrap.

| x′ | b1 | b2 | b3 | b≈5 | b≈10 | b≈21 |
|---|---|---|---|---|---|---|
| −2.0 | +0.082 [0.034, 0.130] (5.4 vp) | +0.125 [0.040, 0.189] (8.5) | +0.127 [0.044, 0.198] (6.6) | +0.129 [0.042, 0.183] (7.5) | +0.130 [0.047, 0.188] (7.7) | +0.138 [0.014, 0.227] (8.4) |
| −1.5 | +0.002 [−0.037, 0.033] | +0.019 [−0.028, 0.060] | +0.021 [−0.054, 0.070] | +0.033 [−0.014, 0.072] (2.0) | +0.060 [−0.011, 0.121] (3.6) | +0.084 [0.038, 0.132] (5.1) |
| −1.0 | −0.011 [−0.032, 0.008] | +0.003 [−0.037, 0.034] | +0.015 [−0.033, 0.044] | +0.009 [−0.023, 0.035] | +0.027 [−0.022, 0.070] | +0.035 [−0.021, 0.089] (2.1) |
| +1.0 | −0.034 [−0.058, −0.011] (−2.3) | −0.024 [−0.041, −0.005] (−1.6) | −0.027 [−0.050, −0.004] (−1.4) | −0.023 [−0.047, 0.001] (−1.4) | −0.011 [−0.035, 0.017] | −0.036 [−0.063, 0.005] (−2.2) |
| +1.5 | −0.076 [−0.114, −0.034] (−5.0) | −0.031 [−0.059, 0.002] | −0.028 [−0.065, 0.011] | −0.019 [−0.051, 0.015] | +0.011 [−0.025, 0.043] | −0.024 [−0.065, 0.014] |
| +2.0 | −0.099 [−0.152, −0.020] (−6.5) | −0.095 [−0.178, −0.018] (−6.4) | −0.001 | −0.001 | −0.005 | (1 ticker) |

Where the market is richer or cheaper than realized tails justify:

- **Far put wing (x′ ≈ −2, roughly 0.02–0.03 delta): market richer by 5–8.5 vol points at every horizon.** This is significant (every CI excludes 0), and the market is richer in 34 of the 44 ticker-bucket cells with data.
- At x′ = −1.5 (≈ 0.07 delta) it is significant only at h≈21 (+5.1 vp).
- **Inside the 0.10–0.50 band, puts are priced within about ±2 vp of realized-fair (no CI excludes 0).**
- **Calls inside the band are priced 1.4–2.3 vp below realized-fair at x′ = +1**; significant at h = 1–3.
- At short horizons (h ≤ 2) the far call wing (x′ ≥ 1.5) is 5–6.5 vp cheap.
- Per ticker (`B_05` per-ticker tables):
  - The rich put wing comes from the index and mega-cap names. At h=1, x′ = −2: QQQ 1.34 vs 1.22, SMH 1.32 vs 1.19, NVDA 1.30 vs 1.14. At h≈5: TLT 1.25 vs 1.02.
  - The cheap call wing comes from high-vol single names. At h=1, x′ = +1: MRNA 1.05 vs 1.20, INTC 1.04 vs 1.14, BE 1.02 vs 1.07.

### At the strikes Signals actually trades (market-IV delta, as `signalCandidates.ts` computes it)

Same-strike shape, market IV(K)/IV_ATM minus realized λ\*(x_f)/λ\*_ATM (trail):

- all buckets and deltas 0.10–0.50 lie in [−0.026, +0.026];
- largest: put −0.10 at h≈21 +0.026; call 0.10 at h=1 −0.026.

Production impact (pooled curve). The column is fair edge − production edge = (1 − λ\*)·σ_f·√(N/T), in calendar-annualized vol points as Signals shows Edge. **Positive = production says the contract is cheaper than it is.** Trail / full-sample drift:

| bucket | put −0.50 | put −0.30 | put −0.20 | put −0.10 | call 0.10 | call 0.20 | call 0.30 | call 0.50 |
|---|---|---|---|---|---|---|---|---|
| 1 | 7.0 / 7.8 | 6.5 / 7.1 | 5.2 / 5.9 | 2.4 / 3.2 | 0.7 / 0.9 | 4.2 / 4.4 | 5.9 / 6.1 | 7.8 / 7.7 |
| 2 | 5.2 / 6.8 | 5.3 / 6.7 | 4.7 / 6.0 | 2.9 / 4.1 | 1.2 / 1.7 | 3.8 / 4.3 | 5.1 / 5.6 | 6.5 / 6.8 |
| 3 | 3.6 / 5.4 | 3.5 / 5.1 | 2.9 / 4.4 | 1.3 / 2.7 | 0.5 / 1.3 | 2.8 / 3.5 | 3.9 / 4.5 | 4.8 / 5.4 |
| ≈5 | 3.4 / 6.2 | 3.1 / 5.7 | 2.5 / 5.0 | 1.1 / 3.5 | 0.8 / 1.9 | 3.1 / 4.2 | 4.2 / 5.3 | 5.1 / 6.2 |
| ≈10 | 1.8 / 6.4 | 1.7 / 6.0 | 1.3 / 5.4 | 0.0 / 4.2 | 0.6 / 2.4 | 2.5 / 4.7 | 3.5 / 5.7 | 4.4 / 6.4 |
| ≈21 | 0.2 / 6.1 | 0.5 / 5.8 | 0.1 / 5.3 | −1.2 / 4.3 | −2.1 / 0.6 | 0.0 / 3.6 | 1.0 / 5.0 | 2.1 / 6.0 |

Notes on the impact table:

- Point counts: 31–152 slices per cell. Trail CI half-widths (ticker-cluster) are 0.1–1.7 vp; full table in `B_05_market_smile.txt`.
- Sign flips of Edge (production negative → fair positive or vice versa) occur in 0–26% of points at h=1 and in ≤ 7% at h ≥ 2. This is because nearly every Edge in the capture window was strongly negative (production −11.6 to −25.7 vp; fair −11.4 to −20.4 vp).
- Signals' market-delta 0.10 strikes sit at x_f ≈ −1.0 to −1.15 (puts) and +1.05 to +1.24 (calls) in σ_f units. That is closer to the money than σ_f-delta 0.10 (x ≈ ∓1.28), because market IV < σ_f in this period.
- 16% of put −0.10 and 22% of call 0.10 strikes lie outside the slice's fitted SVI range, i.e. extrapolated wings.

## 8. B5 — LEVEL vs SHAPE, periods, heterogeneity

### Decomposition of the LEVEL

Earnings-free, equal weight per window, from `B_09`:

| h | std(z) | σ_f / σ_f,ex-earnings | std(z) with ex-earnings forecast | E\|z\|/std ÷ √(2/π) (kurtosis factor) | std × kurtosis factor ≈ ATM level |
|---|---|---|---|---|---|
| 1 | 1.006 [0.959, 1.046] | 1.059 [1.048, 1.071] | 1.059 [1.009, 1.100] | 0.922 [0.904, 0.941] | 0.928 |
| 2 | 1.007 | 1.059 | 1.059 | 0.941 | 0.948 |
| 3 | 1.005 | 1.059 | 1.057 | 0.947 | 0.951 |
| 5 | 0.992 | 1.059 | 1.044 | 0.957 [0.941, 0.973] | 0.950 |
| 10 | 0.983 | 1.059 | 1.035 | 0.971 | 0.955 |
| 21 | 0.984 [0.922, 1.044] | 1.057 | 1.035 | 0.978 [0.960, 1.004] | 0.962 |

- 96.9% of origins have at least one earnings reaction inside the 63-session lookback. That reaction inflates σ_f by 5.9%.
- The ex-earnings forecast under-predicts by 3.5–5.9%. The two effects cancel, so std(z) ≈ 1.
- **The ATM level below 1 is therefore almost entirely the kurtosis effect**: a peaked center makes the straddle worth E|z|, which is 2–8% below what the normal assumes. It fades with horizon, 0.922 at h=1 to 0.978 at h=21.
- With an ex-earnings forecast the LEVEL rises to 0.956–1.012 (T1).
- Premium weighting gives a 0.02–0.03 lower level than equal weighting, because high-vol names have more kurtosis.

### Periods

LEVEL since 2024-10-01 vs before (raw, earnings-free):

| h | 1 | 2 | 3 | 5 | 10 | 21 |
|---|---|---|---|---|---|---|
| since 2024-10-01 | 0.909 | 0.921 | 0.927 | 0.918 | 0.904 | 0.946 |
| before | 0.906 | 0.929 | 0.934 | 0.935 | 0.961 | 0.973 |

There is no significant period difference.

SHAPE (trail):

| period | h | put −0.10 | put −0.20 | put −0.30 | call 0.10 | call 0.20 | call 0.30 |
|---|---|---|---|---|---|---|---|
| since 2024-10-01 | 1 | 1.113 | 1.063 | 1.032 | 1.138 | 1.065 | 1.026 |
| since 2024-10-01 | 5 | 1.102 | 1.062 | 1.046 | 1.100 | 1.044 | 1.008 |
| since 2024-10-01 | 21 | 1.129 [0.996, 1.216] | 1.090 | 1.082 | 1.023 | 0.983 | 0.966 |
| before | 1 | 1.070 | 1.024 | 1.003 | 1.099 | 1.055 | 1.033 |
| before | 5 | 1.027 | 1.008 | 0.996 | 1.057 | 1.031 | 1.020 |
| before | 21 | 0.976 | 0.964 | 0.956 | 1.106 | 1.074 | 1.060 |

- The recent period is more put-heavy at h ≥ 5: the DeepSeek day of 2025-01-27, the April 2025 tariff crash, BMNR and NBIS drawdowns. The CIs overlap.

### Heterogeneity

Groups, earnings-free, trail. Shape at put −0.10 / call 0.10:

| group | h=1 | h=5 | h=21 | LEVEL h=1 / h=21 |
|---|---|---|---|---|
| equity ETFs (QQQ, SMH, IGV, SPY) | 1.11 / 1.04 | 1.07 / 0.98 | 1.03 / 0.99 | 0.99 / 0.99 |
| rates (TLT) | 1.03 / 0.98 | 1.01 / 1.00 | 0.99 / 1.02 | 1.02 / 0.96 |
| mega/large caps (9) | 1.09 / 1.11 | 1.05 / 1.06 | 1.00 / 1.07 | 0.90 / 0.95 |
| high-vol small/mid caps (9) | 1.10 / 1.16 | 1.03 / 1.14 | 0.98 / 1.13 | 0.89 / 0.97 |
| crypto-linked (COIN, HOOD, BMNR) | 1.09 / 1.09 | 1.16 / 0.99 | 1.23 [0.90, 1.48] / 0.96 | 0.93 / 1.14 |
| foreign ADRs (NOK, BSBR) | 1.09 / 1.10 | 1.06 / 1.06 | 1.07 / 1.00 | 0.94 / 0.90 |

- **The shape is not stable across ticker types.**
  - ETFs: put-heavy, with an ATM level ≈ 1.0 (no kurtosis discount).
  - High-vol single names: call-heavy, with the strongest ATM discount (0.89).
  - TLT: close to Black-Scholes (flat).
  - Crypto: put-heavy at h ≥ 5, but the CIs are very wide.
- Per ticker, 1–7 of 28 tickers have a 95% CI excluding the pooled shape value at each δ (T5). This is more than the 1.4 expected by chance at h = 1–10.

## 9. B6 — sample-size honesty

Pooled earnings-free; full table T6 in `B_06_tables.txt`.

- Non-overlapping windows ≈ windows/h: ~29,300 (h=1), ~5,500 (h=5), ~990 (h=21).
- Effective independent windows for the ITM indicator, n_eff = p(1−p)/Var_boot:

| cell | h=1 | h=5 | h=21 |
|---|---|---|---|
| put δ −0.10 | 1,826 | 886 | 412 |
| put δ −0.20 | 1,732 | 862 | 301 |
| call δ 0.10 | 5,428 | 2,691 | 544 |
| call δ 0.20 | 4,595 | 2,003 | 444 |
| ATM | 6,611 | 1,294 | 268 |

- Concentration in the band (|δ| ≥ 0.10): the largest single ticker-episode contributes ≤ 10% of payoff (put −0.10 at h=21: 8%, BMNR Sep 2025), except call 0.10 at h=21 (18%, AAOI May 2023; top-5 35%, "caution").
- **THIN cells** (< 20 ticker-episodes, top-5 episodes > 50% of payoff, or clamped λ):
  - |x| = 3 at h ≥ 5;
  - |x| ≥ 2 at h=21 (put x=−2: 14 market episodes, top-5 share 62%; call x=+2: 15 episodes, 64%);
  - call x=+3 at h ≥ 2 (MRNA 2026-08-18 alone is 22–52% of payoff at h ≤ 10; AAOI May 2023 is 58% at h=21);
  - call δ 0.05 at h=21.
- **None of the 0.10–0.50 delta cells is THIN.**
- Clamped λ draws: ≤ 0.1% everywhere.
- Market side: 12 capture days, 1–16 slices per ticker per bucket. The x′ = ±2 market points rest on 5–41 slices and 5–13 tickers.

## 10. Challenges to the assumptions

1. **Overlapping windows.** Handled by the date-block bootstrap. Block 21/63/126 changes CI half-widths by ≤ 0.015.
2. **Drift dominates at h ≥ 10.** The h=21 ATM level is 0.917 (full) / 0.960 (raw) / 0.984 (trail). The trailing-mean estimator required by the brief is extremely noisy for jump-driven names: the mean trailing drift used was BMNR 943%/yr, LITX 495%, NBIS 158%, AAOI 106%, against realized means of 84%, 202%, 40% and 54%. It overcorrects momentum and inflates the put side at long horizons. **At h ≤ 5 all three treatments agree within ≈0.03 in shape; at h ≥ 10 trust only statements that hold under all three.**
3. **Survivorship and selection.** The ticker list is today's Signals universe — mostly 2021–2026 winners:
   - multiples: MU ×14.6, AAOI ×15.1, BE ×14.7, SMCI ×11.2, LITE ×10.9, NVDA ×11.0, DELL ×10.7;
   - median annualized log return of the 24 long-history names +24%/yr; 11 of 24 above +30%/yr.
   - This biases raw results toward rich calls / cheap puts, and the realized level upward (winners realized more volatility than was implied). It is the main reason to trust the drift-neutral shape over the raw one, and to read the "no ATM risk premium" finding as specific to this universe.
4. **Jumps dominate the tails.** One MRNA day changes h=1 kurtosis from 5.0 to 13.9 and supplies 22–52% of the x=+3 call payoff at h ≤ 10. One NBIS day (war) is the top put-tail episode at h ≤ 3. Band cells are not dominated (≤ 8% top episode).
5. **Earnings-date errors.** The strict ±2-session rule moves nothing by more than 0.01.
6. **Pooling weight.** Premium-weighted pooling (headline) tilts toward high-vol names. Equal weight makes the smile almost exactly symmetric (put −0.10 1.098 vs call 0.10 1.099 at h=1) and the level 0.02–0.03 higher.
7. **Forecast information set.** Realized windows use bars ≤ t (close to close). The market comparison uses bars < snapshot date with the option bought at ~10:00. The 10:00 → close variance (f = 0.268) is real exposure the production N ignores; see §11.
8. **Delta convention.** B3 uses σ_f-delta as asked. Signals uses surface-IV delta, so the impact table uses the market-delta strikes.
9. **Rates and dividends.** The realized side is zero-rate, spot-centered (drift-neutral variants); the market side is forward-centered. These are consistent under the drift-neutral variants. Raw results mix in the risk-free drift (≈ 0–5%/yr, negligible vs the stock drifts above).
10. **IBKR historical IV** (`B_08`). Methodology unknown; BSBR unusable (IV 1.68× σ_f); 14 other windows rejected by the 0.33–3× filter. Treated as supplementary evidence only.
11. **Market sample.** 12 days in one regime (implied far below trailing realized). The shape comparison is far more stable than the level comparison, because shapes are ratios within the same slice.

## 11. What this means for the model

1. **The feared bias (OTM puts systematically "rich", OTM calls "cheap" because of fair put skew) is not supported for the 0.10–0.50 delta band.**
   - Realized earnings-free returns show no negative skew: robust skew 0 ± 0.04 at every horizon.
   - The market's put side in the band is within ±2 vp of realized-fair.
   - If anything, market calls are 1.4–2.3 vp cheap at x′ ≈ +1 on 1–3 session contracts.
   - **Do not add a put-skew premium to the forecast.**
2. **The real flat-forecast error is kurtosis, and it is symmetric.**
   - A single σ_f values the money as if returns were normal. Fair ATM vol is 0.91–0.96 σ_f (earnings-free, raw), while fair 0.10-delta vol is ≈ 0.99–1.05 σ_f.
   - Production therefore **understates the edge of near-ATM contracts by 5–8 vp at N = 1–2 and 3.4–6.2 vp at N = 3–5** (1.8–6.4 vp at N ≈ 10, drift-dependent), and that of 0.10-delta contracts by only 0.5–4 vp at N ≤ 5.
   - Signals therefore over-ranks low-delta contracts relative to near-ATM ones on both sides by roughly the difference: 4.6–7 vp at N = 1, 2.3–5.3 vp at N = 2–5.
3. **Level and shape must be modelled separately and by horizon.**
   - LEVEL: ≈ 0.91 (h=1) → 0.93 (h=2–10) → 0.96 (h=21), raw.
   - SHAPE at δ ±0.10: puts 1.09 → 1.05, calls 1.12 → 1.07 (trail, h=1 → 21).
   - The level factor is mostly kurtosis, not forecast bias. If the forecast is ever changed to exclude earnings (its σ_f is 5.9% higher than the ex-earnings one), the LEVEL moves to ≈ 0.96–1.01 and the table must be recomputed.
4. **Shape differs by ticker type.** ETFs are put-heavy with no ATM discount; high-vol single names are call-heavy with the largest ATM discount; TLT is flat. A single pooled curve would over-correct ETFs' ATM and under-correct small caps' calls.
5. **A related issue of similar size at N ≤ 2 (outside this brief's question, but it interacts):**
   - The production horizon N counts sessions after the scoring date. It omits the ≈ 0.27 session of variance still ahead at 10:00 ET.
   - That understates the forecast's total vol by a factor √(N/(N+0.268)): −11.2% at N=1, −6.1% at N=2, −2.6% at N=5, −0.6% at N=21.
   - At N=1 this offsets the ATM kurtosis discount (0.911 × 1.126 = 1.026) and leaves the 0.10-delta wings 12–15% under-forecast (put 0.994 × 1.126 = 1.119; call 1.019 × 1.126 = 1.147). Any fix to the flat smile at N ≤ 2 must be decided together with this one.

Options for Marcelo to decide on (none implemented; formulas need sign-off per the working agreements):

- **(a)** Keep the flat σ_f and only document the bias.
- **(b)** Replace it with fair_vol(K) = σ_f · λ\*(x, N), a pooled realized-fair table by horizon (one curve, simplest; mis-fits ETFs vs small caps).
- **(c)** The same per ticker group (ETF / large / small-mid / crypto / rates); more accurate, noisier, needs ≥ 1,000 windows per group.
- **(d)** Fix only the ATM discount, via a horizon-dependent level factor applied with a kurtosis-shaped correction.

In every option the rest-of-day horizon (point 5) should be decided first, because at N = 1–2 it is the same order of magnitude.

Confidence:

- **High**: no negative skew in the band, a symmetric fat-tailed smile, and an ATM level < 1 for h ≤ 10 (CIs exclude 1 at h = 1–5).
- **Moderate**: the market matching realized-fair shape inside the band (12 days of market data); the h=21 numbers (drift-dependent).
- **Low**: tail cells |x| ≥ 2 at h ≥ 10 (THIN), and per-ticker curves.

## 12. Scripts and outputs (all in `tmp/model-research/`)

| file | purpose |
|---|---|
| `B_common.mts` | research-DB access (hard-coded local URL, read-only session), accurate normal CDF/inverse, BS on unit spot, production YZ wrapper |
| `B_01_screen_bars.mts` → `B_01_screen.txt`, `B_session_calendar.json` | numeric self-checks, session calendar, bar screen, earnings calendar sanity |
| `B_windows.mts` | clean segments, exclusions, production σ_f per origin, ex-earnings σ_f, trailing drift, windows h = 1…25, earnings flags |
| `B_02_dataset_summary.mts` → `.txt` | window counts, exclusions, earnings-date validation, largest earnings-free moves |
| `B_bootstrap.mts` | circular moving-block bootstrap helpers |
| `B_03_standardized_returns.mts` → `.txt/.json` | B1 |
| `B_04_fair_smile.mts <h> [B] [b] [block]` → `B_04_fair_smile_h<h>.json` | B2/B3/B5/B6 engine (headline h with 1,000/400 resamples; h = 4…25 point estimates; block 21/126 sensitivity for h = 5, 21) |
| `B_05_market_smile.mts` → `.txt/.json` | B4: market level/shape, ticker-matched comparison, production impact at market-delta strikes |
| `B_06_report_tables.mts` → `B_06_tables.txt` | all B2/B3/B5/B6 tables with CIs (T1–T7) |
| `B_07_verify.mts` → `.txt` | brute-force check of the engine |
| `B_08_ibkr_iv_level.mts` → `.txt` | 5-year market ATM level from IBKR historical IV |
| `B_09_level_decomposition.mts` → `.txt` | LEVEL decomposition, lookback-earnings share, drift/survivorship context |

Run order: `B_01` → (`B_02`, `B_03`) → `B_04` per horizon → `B_06`, `B_07`, `B_09`, `B_08` → `B_05`. All are `npx tsx tmp/model-research/<file>.mts` from the repo root.
