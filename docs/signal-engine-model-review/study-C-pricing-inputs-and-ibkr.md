# C — Option-pricing inputs study: American vs European, forwards, mid, rate, IBKR reproduction

Research DB `iorio_research` (local copy of staging), 12 capture days 2026-09-23 → 2026-10-09, read-only. All numbers below were computed by the `C_*.mts` scripts in this folder; full tables are in `C_data/C_0*_report.md`. "vol pt" = 0.01 of annualised implied volatility. "Material" = more than 0.5 vol pt at the traded deltas and DTEs (signal settings: DTE 1–45, |delta| ≤ 0.40; trading settings: |delta| 0.10–0.50). The "traded region" below is DTE 1–45, |delta| 0.1–0.5 including ATM (n = 26,060 quotes).

---

## 0. What this means for the model

| # | Effect | Traded region (DTE 1–45, \|Δ\| 0.1–0.5) | Where it is largest | Verdict |
|---|---|---|---|---|
| 1 | **Time to expiry measured midnight-to-midnight (T = D/365) instead of from the capture time to the 16:00 ET close** | IV overstated by 10.3% of IV at 1 DTE, 4.7% at 2–3, 2.2% at 4–7, 1.15% at 8–14, 0.56% at 15–30. In vol pts: 1 DTE −6.1 to −10.7, 2–3 DTE −2.7 to −4.3, 4–7 DTE −1.0 to −1.7, 8–14 DTE −0.55 to −0.79, 15–30 DTE −0.33 to −0.40 | 1–3 DTE, every delta | **MATERIAL for DTE ≤ 14.** IBKR itself uses calendar time to ≈16:00 ET (C6). Production IVs at 10:00 are too high for short expiries, so Edge = IV − RV is overstated there. T = D/365 amounts to valuing at 16:00 on the trading date. The missing time is therefore (16 − hour)/24 days: 0.25 at the 10:00 fit, shrinking to 0 at the close as live scoring runs through the day. The fix has to be decided together with the RV clock (calendar vs trading time, overnight share). |
| 2 | Forward source: parity forward (production) vs spot/dividend forward | Using the spot/dividend forward instead would move IVs by mean \|Δ\| 1.7–3.3 vol pts at 1–3 DTE and 0.4–1.2 beyond | 1–3 DTE; AAOI, COHR, HOOD, MRNA, TLT | Production already uses parity for 1,319/1,366 expiries: **keep it.** The 47 fallback expiries (13 of them `ok`) carry errors of this size. |
| 3 | Anchor offset for live rescaling: IBKR tick-13 underlying vs the option-implied spot (short-dated parity basis) | Per snapshot, median 5.1 bp (4.0 bp excl. 09:31 opens), p90 19 bp (15 bp). At ATM 1 vol pt ≈ 5.3 bp at 1 DTE, 7.7 bp at 2–3, 11 bp at 4–7, 15 bp at 8–14 | Live scoring of 1–7 DTE | **Potentially material (DTE ≤ 7)**, but only if the offset is transient: snapshot data alone cannot tell whether it persists intraday. Needs a live check before acting. |
| 4 | American vs European exercise (pure early-exercise premium, literal spot + q = 0 inputs) | mean −0.031, p05 −0.130, max \|.\| 0.278 vol pts (puts: mean −0.067, max 0.238) | ATM puts 61+ DTE: mean −0.30, worst −0.37 | **Negligible.** No binomial trees needed in production. |
| 5 | Parity forward biased low under American exercise (European put-call parity on American quotes) | Forward biased low by a median 0.1–3.3 bp up to 60 DTE (6.5 bp at 61+), so the European-forward mean \|ΔIV\| is ≤ 0.12 from 2 DTE on and up to 0.30 at 1 DTE. Total production vs a calibrated American model: E0 − A_impl mean +0.068, p95 +0.197, share > 0.5 vol pt 0.82% | ATM, 61+ DTE: about +0.17 | **Negligible.** The European parity forward partly absorbs the put premium, so it is a reasonable de-Americanisation. |
| 6 | Per-quote re-anchoring to each quote's own underlying | 98.2% of passing quotes carry exactly the anchor value; mean \|Δ\| ≤ 0.035 vol pts in every traded cell | Opening captures (max 6.5) | **Not needed.** |
| 7 | Risk-free rate ±50 bp | Production pipeline: ≤ 0.011 mean (15–30 DTE), ≤ 0.031 (61+), max 0.32 | Spot-forward fallback 61+: ±0.18 mean \|Δ\| | **Negligible.** The rate cannot be measured from these chains (C5), and it does not need to be. |
| 8 | Mid vs IBKR model price vs size-weighted microprice | No systematic bias (means −0.37 … +0.07 by DTE), but per-quote mean \|Δ\| 0.6–1.4 vol pts. The microprice gives *noisier* smiles than the mid (SVI RMSE 0.53 vs 0.42 vol pts; noisier in 66% of slices) | Wide spreads: 35–50% spread mean \|Δ\| 1.9–2.4 | **Keep the mid.** Neither alternative is better. IBKR's model price lies outside the quote for 13.1% of quotes. |
| 9 | Quote discreteness | One $0.01 tick = 0.9–1.6 vol pts for $0.01–$0.25 options at 1–3 DTE, 0.7–1.1 at 4–7. Half-spread = 0.8–1.5 vol pts (median by DTE) | $0.01–0.05 wings: mid IV is +0.64 vol pts above the SVI on average (n = 130) | Quote-level noise, not bias. Already handled by the spread-weighted fit (SVI lies inside the bid–ask IV band for 96.4% of quotes). The cheap-wing upward bias sits mostly below 0.1 delta. |
| 10 | Production delta vs IBKR delta | mean \|Δdelta\| 0.002–0.006 | 61+ ATM 0.008 | **Negligible** for a 0.10–0.50 band, except right at its edges. |

Side findings that affect other work:

- **Stored `option_surface_fits` for 2026-09-23 … 09-30 come from older code** (before the parity forward). Their forwards differ from current code by a median of 24 bp and up to 425 bp (HOOD 2026-09-30), and their SVI parameters differ. Any study reading stored fits for those dates is reading a different model. Only the 747 slices from 10-02 onwards match current code.
- **Dividend data is missing for most payers.** TLT (monthly), QQQ, SMH, IGV, AAPL, MU, NOK, NVDA and WDC have no future ex-dividend in `ticker_calendar_events` for these dates; only CSCO and DELL do. The parity forward covers this, but the fallback forward does not. Example: TLT's parity-implied carry is −3.8%/yr, roughly its yield.
- **Latent edge case (not observed in this data):** `computeForwardPrice` subtracts a dividend whose ex-date equals the trading date (`yearsToExDividend >= 0`). On that morning the stock already trades ex, so the spot forward would be one dividend too low. This only affects the parity window reference and the fallback.
- The header spot is fetched once for the whole universe at run start, so it is up to 15 min older than a ticker's quotes. It sits a median 19 bp, p90 70 bp, max 430 bp from the quotes' underlying. Current code anchors to the quotes' median underlying and so does not use it, except as a fallback.

---

## 1. Data, scope and exclusions

- Snapshots: 184 rows; 150 `complete` (28 tickers; 27 have quotes that pass the filter, BSBR has none), 34 `failed`. No `partial`. Production fits only complete/partial snapshots.
- Quotes: 51,288 in total = 49,981 in fitted expiries + 1,038 at 0 DTE (production skips T ≤ 0) + 269 in failed snapshots.
- Production quote filter on the 49,981: **39,748 pass** (OTM w.r.t. the production forward, two-sided, spread ≤ 50% of mid, IV solvable). Excluded: spread > 50%: 5,197; ITM side: 4,173; no two-sided quote: 863; no IV: 0.
- Expiries fitted: 1,366 (parity forward 1,319; spot/dividend fallback 47). Parity pairs: 3,988.
- IBKR tick-13 fields (IV, delta, model price, underlying) are present on 38,293 of the 39,748 passing quotes.
- Rates stored: 3.72% (TB3MS) on every date except 2026-10-09 (3.94%).
- Captures: 10:00–10:15 ET on 8 days, 09:31 on 09-29/09-30, 10:28 on 09-28, 11:05 on 09-23. `captured_at` is the ticker's save time. `capture_duration_ms` is cumulative since the run started, so each ticker's quotes fall between the previous ticker's save and its own (≈ 15–60 s).
- Buckets: DTE = expiry − trading date in calendar days. ATM = \|K/F − 1\| ≤ 2% and takes precedence; other quotes are bucketed by \|forward delta\| at the production IV.

## 2. Reproduction of production (prerequisite for C1)

The current `fitSurfaceForSnapshot` was re-run on every snapshot, with inputs loaded exactly as in `optionSurfaceStore.ts` (C_01):

- **Slices stored by current code (10-02 → 10-09): 747/747 reproduced.** Status matches 747/747, point count 747/747, SVI parameters within 1e-6 on 747/747, ATM SVI vol \|diff\| ≤ 0.0002 vol pts. Forward \|diff\| ≤ 0.08 bp, which is the 4-decimal rounding of `forward_price`.
- Slices stored before 10-01 (619) were made by older code: forward median diff 24 bp, max 425 bp; statuses differ on 56.
- Production IV solver (A&S 7.1.26 erf, 80-step bisection) vs an independent Black-76 solver (Hart double-precision CDF, Brent): max \|diff\| 4.6e-4 vol pts over 39,748 quotes.

## 3. C1 — American vs European IV

**Method.** For every passing quote, IVs were solved from the same mid, with the same T (production D/365) and the same r:

- **E0**: production Black-76 IV on the production forward.
- **A_spec** (the brief taken literally): Leisen-Reimer American tree, 401 steps plus a European control variate, on the quote's own underlying, with the snapshot's projected dividend schedule (escrowed discrete dividends) and q = 0.
- **E_spec**: the European twin of A_spec.
- **A_same**: American tree with the carry set so that the tree's forward equals the production forward. This isolates the early-exercise premium.

**Convergence** (1,984-quote sample, IV on A_same):

| comparison | mean \|ΔIV\| | p95 | max |
|---|---:|---:|---:|
| LR 401 + CV vs LR 1601 + CV (400 vs 1600 check) | 0.00085 | 0.0029 | 0.0080 |
| LR 401 + CV vs LR 3201 + CV (reference) | 0.00100 | 0.0033 | 0.0095 |
| CRR 400 raw vs CRR 1600 raw | 0.021 | 0.051 | 0.074 |
| CRR 400 + CV vs reference | 0.00097 | 0.0040 | 0.016 |
| European LR 401 lattice vs closed-form Black-76 | 0.000017 | 0.000043 | 0.00011 |

Tree error is ≤ 0.01 vol pt everywhere. A literature benchmark (S = K = 100, T = 1, r = 5%, σ = 20%) gives 6.0902 at 1,601 steps vs 6.0903 published.

**C1.a Literal brief, A_spec − E0** (vol pts):

| right | n | mean | median | p05 | p95 | p95 \|.\| | max \|.\| |
|---|---:|---:|---:|---:|---:|---:|---:|
| calls | 20,807 | +0.09 | +0.10 | −1.53 | +1.65 | 2.38 | 30.49 |
| puts | 18,941 | −0.13 | −0.15 | −1.57 | +1.37 | 2.14 | 33.02 |

This difference is almost entirely the **forward**, not the exercise style. The two parts:

- E_spec − E0 (spot/dividend forward on the quote's underlying vs the parity forward): mean \|Δ\| 1.67 (1 DTE), 1.90 (2–3), 0.60 (4–7), 0.74 (8–14), 0.66 (15–30), 0.58 (31–60), 0.45 (61+).
- A_spec − E_spec (early exercise): mean −0.004 … −0.062, max \|.\| 0.37.

**C1.b Early exercise with real inputs (A_spec − E_spec), puts, mean vol pts by DTE × delta**. Calls are ≈ 0 everywhere: there are no dividends except CSCO/DELL, and ex-dividend calls reach at most −0.28.

| DTE | ATM±2% | 0.4–0.5 | 0.3–0.4 | 0.2–0.3 | 0.1–0.2 | <0.1 | worst (ATM) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | −0.012 | – | −0.010 | −0.008 | −0.005 | −0.003 | −0.023 |
| 2–3 | −0.023 | – | −0.019 | −0.013 | −0.008 | −0.005 | −0.054 |
| 4–7 | −0.042 | −0.047 | −0.033 | −0.022 | −0.014 | −0.008 | −0.077 |
| 8–14 | −0.070 | −0.067 | −0.051 | −0.034 | −0.021 | −0.012 | −0.118 |
| 15–30 | −0.120 | −0.110 | −0.086 | −0.056 | −0.034 | −0.020 | −0.183 |
| 31–60 | −0.188 | −0.169 | −0.135 | −0.088 | −0.054 | −0.032 | −0.281 |
| 61+ | −0.300 | −0.285 | −0.223 | −0.142 | −0.085 | −0.051 | −0.366 |

The early-exercise premium on puts is 0.07% (1 DTE) to 0.42% (61+ DTE) of the mid (median), with p95 $0.23 at 61+ DTE. Traded region: mean −0.031, p05 −0.130, max \|.\| 0.278 vol pts.

**Where it matters.** Near-the-money puts at long DTE (61+ ATM −0.30). Calls spanning a known ex-dividend date (CSCO, DELL; n = 755): mean −0.011, max −0.28. Higher rates: +50 bp changes the put effect by at most −0.014 (61+ DTE, 0.4–0.5 delta). None of these reaches 0.5 vol pt.

**Caution on A_same − E0** (American on the production forward): traded mean −0.056, median −0.001, but 296 quotes exceed 0.5 vol pt (max 8.2). **70% of those sit in expiries whose parity forward implies a carry beyond ±20%/yr.** Examples: BE 2026-09-29 3 DTE, implied q = −294%/yr; HOOD 2026-09-30 2 DTE, +336%/yr. These are opening-minute asynchronies that an American tree reads as a dividend or borrow yield. They are artefacts of feeding noise into the tree, not real early-exercise value. On the same quotes A_spec − E_spec is ≤ 0.054.

## 4. C2 — Parity forward under American exercise

**Method.** For each parity pair (3,988), the carry q was solved so that the American model (LR 401 + CV) gives the call mid and the put mid the same IV. That fixes the American-implied forward F_A = (S − PV div)·e^{(r−q)T}. Production takes the median per expiry, and so does this study. Calibrated: **3,985 of 3,988**. The 3 failures have a put mid at or below its American intrinsic value. (A first run lost 294 low-vol, short-dated pairs (TLT, AAPL, NVDA) to a bracketing limitation in the solver; it was fixed and re-run.)

**Bias of the production (European) parity forward relative to F_A.** Theory says F_par = F_A − (EEP_put − EEP_call)·e^{rT}; the computed premia reproduce that identity.

| DTE | pair-level median (bp) | pair p05 / p95 | (EEP_put − EEP_call)·e^{rT}/F, median | expiry-level production − F_A, median | expiry-level spot/div forward − F_A: median / mean \|.\| |
|---|---:|---:|---:|---:|---:|
| 1 | −0.14 | −3.90 / +1.76 | 0.14 | −0.27 | −2.8 / 12.0 |
| 2–3 | −0.08 | −3.21 / +2.11 | 0.08 | −0.03 | +2.1 / 19.6 |
| 4–7 | −0.26 | −2.37 / +0.88 | 0.26 | −0.34 | −0.7 / 11.2 |
| 8–14 | −0.65 | −3.32 / +1.01 | 0.65 | −0.68 | −1.3 / 17.7 |
| 15–30 | −1.60 | −4.80 / +1.09 | 1.60 | −1.52 | −4.1 / 21.8 |
| 31–60 | −2.96 | −6.66 / +0.11 | 2.96 | −3.28 | −8.4 / 26.9 |
| 61+ | −5.57 | −9.15 / +2.18 | 5.57 | −6.53 | −12.6 / 34.4 |

- By pair moneyness (median): K/S < 0.98 −0.61 bp, 0.98–1.02 −1.32 bp, K/S > 1.02 (ITM put) −2.35 bp. The bias grows with the put's early-exercise value, as theory predicts.
- The spot/dividend forward is far noisier than the parity bias: mean \|.\| 11–34 bp, from asynchrony, missing dividends and borrow.

**Translation to IV, E0 − E_FA** (both Black-76; production forward vs American-implied forward). Mean vol pts at ATM and in the 0.1–0.5 delta band:

Cells show puts / calls:

| DTE | ATM±2% | 0.4–0.5 | 0.3–0.4 | 0.2–0.3 | 0.1–0.2 |
|---|---:|---:|---:|---:|---:|
| 1 | −0.18 / +0.20 | – | −0.21 / +0.17 | −0.30 / +0.26 | −0.19 / +0.21 |
| 2–3 | +0.01 / +0.05 | – / +0.77 (n=5) | −0.13 / +0.09 | −0.05 / +0.04 | −0.05 / +0.04 |
| 4–7 | −0.02 / +0.02 | +0.01 (n=2) / +0.03 | −0.03 / +0.03 | −0.03 / +0.03 | −0.02 / +0.02 |
| 8–14 | −0.03 / +0.05 | −0.02 / +0.05 | −0.04 / +0.04 | −0.03 / +0.03 | −0.02 / +0.02 |
| 15–30 | −0.05 / +0.08 | −0.06 / +0.07 | −0.06 / +0.05 | −0.04 / +0.04 | −0.03 / +0.04 |
| 31–60 | −0.10 / +0.12 | −0.10 / +0.12 | −0.09 / +0.09 | −0.08 / +0.07 | −0.06 / +0.06 |
| 61+ | −0.11 / +0.17 | −0.16 / +0.17 | −0.13 / +0.13 | −0.11 / +0.11 | −0.08 / +0.09 |

A low forward lowers put IVs and raises call IVs. Pooled: calls +0.064 mean (p95 +0.198), puts −0.055 (p05 −0.167). At 1 DTE a 1 bp forward error is worth about 0.19 vol pt at ATM, so the small 1-DTE forward differences show up as ±0.2.

**Total effect of staying European**, E0 − A_impl (production IV minus the American IV with the American-implied carry). Positive = production too high:

Cells show puts / calls, mean vol pts:

| DTE | ATM±2% | 0.4–0.5 | 0.3–0.4 | 0.2–0.3 | 0.1–0.2 |
|---|---:|---:|---:|---:|---:|
| 1 | +0.03 / +0.26 | – | +0.04 / +0.19 | −0.10 / +0.29 | −0.09 / +0.23 |
| 2–3 | +0.16 / +0.15 | – / +0.83 (n=5) | +0.29 / +0.27 | +0.12 / +0.18 | +0.05 / +0.12 |
| 4–7 | +0.05 / +0.06 | +0.05 (n=2) / +0.04 | +0.03 / +0.05 | +0.02 / +0.04 | +0.01 / +0.03 |
| 8–14 | +0.08 / +0.08 | +0.09 / +0.09 | +0.07 / +0.08 | +0.03 / +0.05 | +0.01 / +0.03 |
| 15–30 | +0.10 / +0.10 | +0.11 / +0.10 | +0.07 / +0.08 | +0.04 / +0.06 | +0.01 / +0.04 |
| 31–60 | +0.13 / +0.13 | +0.14 / +0.13 | +0.09 / +0.10 | +0.04 / +0.08 | +0.01 / +0.06 |
| 61+ | +0.17 / +0.18 | +0.19 / +0.17 | +0.13 / +0.14 | +0.05 / +0.11 | +0.01 / +0.09 |

- **Traded region:** n 25,897, mean +0.068, median +0.045, p05 −0.003, p95 +0.197, max \|.\| 5.43 (BE 09-29 opening asynchrony). Share > 0.5 vol pt: 0.82%.
- **By ticker (mean):** 0.027 (TLT) to 0.106 (COHR).
- **Skew distortion** (put minus call, mean): −0.25 at 1 DTE, −0.04 at 2–3, then −0.02 … −0.07 from 4 DTE on.

The European pipeline with a parity forward lands within about 0.2 vol pt of a calibrated American model, mostly as a small upward level shift at long DTE. The skew distortion (put minus call) is −0.25 at 1 DTE and inside ±0.07 from 2 DTE on.

## 5. C3 — Forward anchoring and quote asynchrony

- **The quotes' own underlying (tick-13) barely moves within a capture.**
  - Within one expiry, a single distinct value in 93.2% of 1,360 slices (p99 range 33 bp, max 231 bp).
  - Within a whole snapshot, a single value in 51.3% (p90 range 27.7 bp, max 266 bp: HOOD 09-30, BE 09-29, both 09:31 opens).
  - Per passing quote, the distance to the expiry anchor is exactly 0 for 98.2% (mean 0.26 bp, max 226 bp).
- **Per-quote re-anchoring (F·S_q/S_anchor) changes IV by mean \|Δ\| ≤ 0.035 vol pts in every DTE × delta cell** (max 6.5, all in opening captures). Not needed.
- **Sensitivity (exact re-solve): a +10 bp forward error moves IV (calls down, puts up) by:**

| DTE | ATM | 0.4–0.5 | 0.3–0.4 | 0.2–0.3 | 0.1–0.2 | <0.1 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 1.89 | – | 1.75 | 1.52 | 1.21 | 0.96 |
| 2–3 | 1.30 | 1.17 | 1.19 | 0.99 | 0.78 | 0.60 |
| 4–7 | 0.88 | 0.80 | 0.74 | 0.61 | 0.50 | 0.40 |
| 8–14 | 0.68 | 0.63 | 0.56 | 0.47 | 0.38 | 0.31 |
| 15–30 | 0.51 | 0.45 | 0.38 | 0.31 | 0.26 | 0.22 |
| 31–60 | 0.40 | 0.34 | 0.29 | 0.24 | 0.19 | 0.15 |
| 61+ | 0.29 | 0.25 | 0.21 | 0.17 | 0.14 | 0.12 |

(Calls; puts are within 0.06 with the opposite sign. Vol pts.)

- **Parity forwards are internally tight.** Within an expiry, the MAD of the per-strike parity forwards is 0.9–1.5 bp at 1–7 DTE, 2.1 bp at 15–30 and 2.6 bp at 31–60. That is a median 0.09× the single-pair half-spread (572 expiries with ≥ 3 pairs).
- **Parity forward vs anchor·e^{rT} (the basis):**
  - At DTE ≤ 7, where carry is ≤ 0.7 bp, the mean \|basis\| is 10.5–18 bp.
  - It is mostly a snapshot-level offset: within-snapshot RMS 6.6 bp, sd of snapshot means 12.1 bp, median \|snapshot mean\| 5.1 bp (4.0 bp excluding 09:31 opens), p90 19 bp (15 bp).
  - So the tick-13 underlying sits a few bp from the option-implied spot, consistently across a ticker's expiries. This does not affect the fitted surface, which uses parity. It does enter live scoring through `scaleSlicesToLiveSpot` (F_live = F·S_live/S_anchor) if the offset is transient.
- Header spot (run start) vs anchor: grows with delay since run start: mean 18 bp (< 2 min), 32 bp (2–4 min), 43 bp (4–6), 44 bp (≥ 6 min).
- **Spot/dividend forward instead of parity** (the fallback, and the old code): mean \|ΔIV\| by DTE × delta 1.7–3.3 (1–3 DTE, 0.1–0.4 delta), 0.4–1.2 (4+ DTE). By ticker, AAOI 1.12, COHR 1.09, MRNA 1.04, HOOD 1.05, TLT 0.96 vs PLTR 0.09, MU 0.11. Implied carry by ticker (DTE ≥ 15): TLT −3.8%/yr, CSCO −3.4%/yr (dividends); COHR +3.2%, MRNA +2.7% (forward above cost of carry).

**Answer:** per-quote re-anchoring is not needed. Parity anchoring is essential and already in place. The remaining exposure is the live rescaling reference (§0 item 3).

## 6. C4 — Mid vs alternatives; tick discreteness

**IBKR model price IV − mid IV** (production forward/T/r): mean −0.20 … +0.07 by DTE, mean \|Δ\| 1.17 (1 DTE), 1.26 (2–3), 0.65 (4–7), 0.81 (8–14), 0.84 (15–30), 0.79 (31–60), 0.62 (61+).

- By relative spread: ≤5%: 0.33; 5–10%: 0.56; 10–20%: 0.87; 20–35%: 1.45; 35–50%: 1.89.
- The model price lies outside [bid, ask] for 13.1% of quotes; at 1–7 DTE its position in the spread has p05/p95 of −1.4/+1.5.

**Microprice (bid·askSize + ask·bidSize)/(bidSize + askSize) IV − mid IV:** mean −0.37 … +0.01 by DTE (no directional bias), mean \|Δ\| 0.68–1.36. By spread: ≤5%: 0.24; 5–10%: 0.63; 10–20%: 1.22; 20–35%: 1.97; 35–50%: 2.39.

**Which estimate is better?** The production SVI fit was re-run on the same quotes and weights with each price. Median slice RMSE (898 ok slices):

| DTE | mid | micro | IBKR model |
|---|---:|---:|---:|
| 1 | 0.465 | 0.695 | 0.869 |
| 2–3 | 0.473 | 0.600 | 0.739 |
| 4–7 | 0.289 | 0.361 | 0.425 |
| 8–14 | 0.411 | 0.501 | 0.334 |
| 15–30 | 0.503 | 0.619 | 0.323 |
| 31–60 | 0.415 | 0.542 | 0.326 |
| 61+ | 0.424 | 0.470 | 0.267 |

- The microprice is noisier than the mid in 66% of slices, so displayed sizes add noise, not information.
- IBKR's model price is smoother beyond 8 DTE only because it *is* IBKR's own smoothed surface. It is not independent evidence, and at 1–7 DTE it is the worst of the three.

**When the mid is poor:**

- \|mid IV − SVI IV\| rises with the spread: 0.11 (≤5%), 0.24, 0.45, 0.78, 1.15 (35–50%).
- Cheap options are biased high vs the surface: $0.01–0.05 mean +0.64 (p95 2.73, n = 130), $0.05–0.10 +0.30, $0.10–0.25 +0.18.
- 1-tick-wide quotes (4.6% of passing) are fine: \|micro − mid\| mean 0.04–0.23.

**Tick value, vol pts per $0.01** (median):

| DTE | $0.01–0.05 | $0.05–0.10 | $0.10–0.25 | $0.25–1 | $1–5 | >$5 |
|---|---:|---:|---:|---:|---:|---:|
| 1 | 1.29 | 1.62 | 1.01 | 0.53 | 0.21 | 0.09 |
| 2–3 | 1.19 | 1.35 | 0.91 | 0.45 | 0.19 | 0.10 |
| 4–7 | 1.12 | 1.07 | 0.68 | 0.34 | 0.16 | 0.04 |
| 8–14 | 0.86 | 0.64 | 0.66 | 0.30 | 0.13 | 0.04 |
| 15–30 | 0.71 | 0.49 | 0.66 | 0.28 | 0.12 | 0.04 |

By delta at 1 DTE: 0.25 (ATM) to 0.73 (< 0.1 delta). Inferred minimum ticks: $0.01 below $3 for most names (nickel-only: AAOI, BSBR, COHR, LITE); $0.05 at or above $3 except QQQ ($0.01).

Half-spread in vol (median by DTE): 1.41, 1.02, 0.78, 1.19, 1.40, 1.47, 1.50.

## 7. C5 — Risk-free rate

- Values used: 3.72% on 11 dates, 3.94% on 2026-10-09 (TB3MS, monthly).
- **IV sensitivity to ±50 bp** (mean, vol pts; symmetric):

| DTE | production (parity re-derived) | forward fixed, discount only | spot-forward fallback (calls / puts) | American, forward held | American on spot, q = 0 (calls / puts) |
|---|---:|---:|---:|---:|---:|
| 1 | 0.000 | 0.000 | −0.019 / +0.020 | 0.000 | −0.019 / +0.018 |
| 2–3 | 0.001 | 0.001 | −0.030 / +0.031 | 0.001 | −0.030 / +0.029 |
| 4–7 | 0.002 | 0.002 | −0.045 / +0.048 | 0.002 | −0.045 / +0.044 |
| 8–14 | 0.004 | 0.004 | −0.063 / +0.068 | 0.004 | −0.063 / +0.063 |
| 15–30 | 0.010 | 0.011 | −0.095 / +0.106 | 0.010 | −0.095 / +0.096 |
| 31–60 | 0.020 | 0.020 | −0.131 / +0.152 | 0.018 | −0.131 / +0.137 |
| 61+ | 0.031 | 0.032 | −0.166 / +0.201 | 0.028 | −0.166 / +0.178 |

Production max \|Δ\| is 0.32 (61+ DTE). With a parity forward the rate enters only through discounting, which is why production is insensitive.

- **Can the data validate 3.72%?** No.
  - The European slope of (C_mid − P_mid) on K across ≥ 4 pairs (277 expiries, DTE ≥ 14) gives median −3.7%, IQR −14.7% … +9.3%.
  - The IBKR model-price parity regression is equally noisy (C6).
  - Since the production sensitivity is ≤ 0.03 vol pt, this does not matter.

## 8. C6 — Reproducing IBKR's tick-13 numbers

1. **One IV per strike.** IBKR's IV is identical for call and put in 98.6% of 3,884 same-strike pairs. It is a smoothed model surface, not a per-quote mid IV.
2. **Time convention: calendar time from the quote to ≈16:00 ET on expiry, /365.**
   - Solving T so that BS(IBKR underlying, IBKR IV, snapshot r) = IBKR model price, on short-dated OTM quotes (1–7 DTE, 5,029 quotes): δ = 365T − D has median 0.248 (1 DTE), 0.241 (2–3), 0.241 (4–7).
   - Per-snapshot medians by capture time: 0.249 (10:00–10:15, n = 91; rule predicts 0.246), 0.232 (10:28–10:45; rule 0.225), 0.205 (11:05–11:20; rule 0.20).
   - OLS without the 09:31 opens (120 snapshots): slope −0.0398 ± 0.0105 days per hour (calendar clock: −0.0417). Best expiry hour 16.08–16.15 ET; residual sd 0.0375 days.
   - **No weekend effect:** δ median 0.240 with 0 weekend days vs 0.245 with 2, so IBKR does not use a trading-day clock.
   - The earlier probe's "D + 0.26–0.32" mixes in the 09:31 opening captures (per-snapshot δ mean 0.33, p05–p95 −0.14 … 1.20) and longer DTE, where IBKR's rate/carry contaminate δ (r = 0 vs 3.72% shifts δ by 1.17 days at DTE ≥ 30).
3. **American model.** IBKR's Greeks match an American (binomial) model, not Black-Scholes. On 2,566 non-payer pairs sharing one IV and one underlying:
   - Δcall − Δput minus the American prediction: median 0.0001–0.0007 by DTE. Minus the European prediction (= 1): 0.0004–0.0036, and 0.0007–0.0040 for ITM puts.
   - Put/call vega ratio − 1: observed −0.082% (ITM puts), −0.002% (ATM), +0.031% (ITM calls) vs American −0.079% / −0.008% / +0.037%. European predicts exactly 0.
   - IBKR model-price parity cannot discriminate: after a per-expiry forward offset, the C − P residuals are $0.03 mean \|.\| under either model, against predicted put premia of $0.02–0.035. American is closer on 68% of ITM-put pairs.
4. **IBKR IV vs production mid IV.** Before any change (production T): −7.2 (1 DTE), −3.5 (2–3), −1.3 (4–7), −0.8 (8–14), −0.4 (15–30), −0.3 (31–60), −0.1 (61+) vol pts mean. After switching T to IBKR's convention: −0.06, −0.22, −0.04, −0.11, −0.04, −0.08, +0.01.
   - The time convention explains essentially the whole systematic gap.
   - What remains is mean \|Δ\| 0.5–1.0 vol pts of surface-vs-mid scatter, plus ATM −0.18 … −0.34 (IBKR below mid at ATM, the direction of American IV < European IV for puts, plus smoothing).
   - Re-pricing at IBKR's IV with the call-fitted T against IBKR's put model prices (C_03 §6.3) was inconclusive: it was contaminated by δ fits that mixed long-dated quotes. Item 3 is the clean test.
5. **Delta.**
   - IBKR delta − BS delta at IBKR's own IV and T: mean \|.\| ≤ 0.004 beyond 3 DTE. For 1–3 DTE puts: 0.014–0.018, p95 0.04–0.05, the same against an American delta, so this is IBKR model/timing noise.
   - Production delta (Black-76 on parity forward, SVI IV, T = D/365) − IBKR delta: mean −0.003 … +0.003, mean \|.\| 0.002–0.008 by cell.

## 9. Caveats

- 12 capture days at 10:00 ET (plus 09:31, 10:28 and 11:05 runs); 27 tickers, high-vol names dominate. Low-vol names (TLT, QQQ, AAPL, NVDA, MU) are a minority of the quotes.
- The American model uses the escrowed-dividend approximation and a continuous carry for anything the parity forward implies beyond known dividends. A_impl treats implied carry as a yield, which at short DTE is mostly asynchrony (see the C1 caution). Dividend inputs are only as complete as `ticker_calendar_events`.
- No per-quote timestamps exist. Quote timing is bounded by the ticker's capture window (≈ 15–60 s, up to minutes at the open).
- Whether the anchor offset (§0 item 3) persists intraday cannot be measured from snapshots. It needs live spot vs option-implied spot through a day.
- IBKR's internal rate and dividend assumptions are not identifiable from the stored fields (`pvDividend` from tick 13 is not captured).
- The time-convention verdict is about the IV side only. Whether Edge should use calendar time to the close, or a trading-time variance clock, must be decided with the RV forecast's annualisation.

## 10. Scripts and outputs (`tmp/model-research/`)

| file | what |
|---|---|
| `C_lib.mts` | normal CDF (Hart), Black-76, Brent, CRR / Leisen-Reimer trees with escrowed dividends and control variate, stats/table helpers |
| `C_00_libcheck.mts` | benchmarks (American put 6.0903, IV round-trips) |
| `C_01_extract_and_reproduce.mts` | reads the research DB, re-runs production `fitSurfaceForSnapshot`, compares with stored fits, writes `C_data/{snapshots,expiries,quotes}.json`, `C_data/C_01_reproduction.md` |
| `C_02_american_worker.mts` (8 shards) | American IVs (A_spec, A_same, A_impl), American-implied forwards, rate variants, convergence sample → `C_data/C_02_shard*.json` |
| `C_03_forward_mid_ibkr.mts` | C3, C4, C5 (data), C6 first pass → `C_data/C_03_report.md` |
| `C_04_american_report.mts` | C1, C2, C5 (American) tables → `C_data/C_04_report.md` |
| `C_05_ibkr_refined.mts` | C6 time convention from short-dated quotes → `C_data/C_05_report.md` |
| `C_06_ibkr_european_or_american.mts` | C6 European-vs-American test on Greeks and parity → `C_data/C_06_report.md` |
| `C_07_supplement.mts` | anchor-offset decomposition, put early-exercise table, artefact diagnosis, δ OLS without opens → `C_data/C_07_report.md` |

Run order: `DATABASE_URL=postgres://marcelo@localhost:5432/iorio_research npx tsx tmp/model-research/C_01_extract_and_reproduce.mts`, then the remaining scripts with plain `npx tsx` (no DB access). Run `C_02` as 8 shards: `npx tsx tmp/model-research/C_02_american_worker.mts <i> 8`.
