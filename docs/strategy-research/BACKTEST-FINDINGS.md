# CC + Put Ladder: what our backtests found

Research log of the backtests on the CC + Put Ladder, on the plain wheel before it, on the Steady Stake against it (Round 8), on Pluto's Edge Margin against it (Round 9), on Edge Margin's own model and a premium-first strategy (Round 10), on long-dated Put hedges (Round 11), and on cutting the Steady Stake's drawdown (Round 12), from 2026-10-13 to 2026-10-23.

Related files:
- [LITERATURE-REVIEW.md](LITERATURE-REVIEW.md): what published research says.
- [IDEAS-TO-TRY.md](IDEAS-TO-TRY.md): what is still to test.

All backtests ran locally on Marcelo's Mac, using ThetaData option prices and IBKR stock prices. The scripts and raw results are in the API repo's `tmp/` folders. Git ignores `tmp/`, so they exist only on that machine. The published reports linked below hold the full tables and charts.

## Plain-language summary

- **The strategy gives up return for much smaller falls, and ends about level with simply holding the stock.**
  - On 22 tickers from 2020 to October 2026 (lab settings of 19 October), the median CAGR was 8.2% a year when starting with Cash-Secured Puts and 11.5% when starting with shares. Buy and hold made 17.8%.
  - The median Max drawdown was −22% and −31%, against −67% for buy and hold.
  - Excess Calmar measures return above T-bills per point of Max drawdown. On it, the strategy beat buy and hold in 17 of 44 runs.
- **A different strategy beats it: the Steady Stake (Round 8).** Hold 80% of each ticker's pot in shares, traded back when off by 5 points, and sell Calls and Puts only on the day they expire. On 37 tickers: median CAGR 17.8% against the ladder's 10.7% (higher on 31), median Excess Calmar 0.46 against 0.31, above buy and hold's on 33. Its Max drawdown is deeper (median −55% against −33%). Most of the gain comes from the steady stake itself.
- **Against Pluto's Edge Margin, the ladder earns the same with far smaller falls (Round 9).** As one book each on 21 tickers, with the same $3.27M from August 2021: CAGR 10.0% against 10.3%, Max drawdown −14.9% against −38.6%, Excess Calmar 0.42 against 0.17. Edge Margin lost 31% in 2022 and did better from 2023.
- **Edge Margin's ranking doesn't pick better contracts, and selling premium on single stocks showed no alpha (Round 10).**
  - Its edge didn't sort about 890,000 contracts by how they turned out, before or after two fixes to its volatility model.
  - The only premium found was in Puts with 4–7 days left. One weekly Put per ticker, never holding stock, made 6.6% a year with a −5.2% Max drawdown on 11 tickers in our cash account. T-bills were 3.0 points of that, and most of the rest was the stocks' rise.
  - Marcelo closed the research.
- **Long-dated Puts can take most of the depth out of slow collapses, but not cheaply (Round 11).**
  - Puts on the shares each entry brought in made drawdowns shallower everywhere but beat the ladder on only 11 of 29 tickers. They missed the shares the ladder buys on the way down, which caused most of the deep losses.
  - Puts covering the whole position (shares plus short Puts) cut PTON's Max drawdown from −86% to −16% and MRNA's from −70% to −23%, but cost the steady riser MU 10–14 points of CAGR.
  - Skipping Puts while they were expensive didn't fix that. Marcelo stopped the research before a test on all 29 tickers.
- **The Steady Stake's drawdowns come from single stocks collapsing; only holding many tickers cuts them (Round 12).**
  - Put insurance made drawdowns shallower but cost 2–4 points of CAGR, and timing it by IV, trend or run-ups didn't help out of sample.
  - No per-ticker rule improved Excess Calmar: no buying back in a downtrend, a volatility-sized stake and an earnings collar all failed or simply took risk off.
  - As one book of 13 tickers in the engine: CAGR 24.1%, Max drawdown −36%, against single-ticker medians of 13.5% and −43%. About 81% of the account is in use at the median; the 0DTE Puts rarely find a contract they can sell, so most of the other 19% sits in T-bills.
- **No rule tested so far improves it on most tickers.** Each of these split the tickers about evenly between better and worse:
  - skipping contracts that span earnings;
  - the volatility edge filter;
  - a share stop-loss;
  - a deeper ladder;
  - dropping the minimum yield;
  - the new entry filters;
  - sizing new buying by the market: a falling-knife guard and dynamic Kelly sizing (Round 7).
- **Buying more below the 200-day average deepens drawdowns.** Kelly sizing that bought up to ×2 there made Max drawdown deeper on 14 to 16 of 22 tickers, and its best version (×1.5) was worse on 6 of 7 fresh hold-out tickers. Buying less at tops sat out rallies, and plain "commit less" did about as well on Excess Calmar but left cash idle (Round 7).
- **Big falls follow big run-ups, but skipping entries at those times doesn't pay.** A stock far above its 200-day average for its own volatility, or with implied volatility near the top of its yearly range, falls 30% more often afterwards. Skipping new entries on those days made Max drawdown shallower on 15 runs and deeper on 3. But the same filter sat out rallies (MU, SMCI, WDC), so Excess Calmar ended about where it started, both on the development tickers and on the hold-out.
- **The damage happens after the entry.** In almost every run the strategy holds shares on 60–100% of days. The worst drawdowns came from two things:
  - shares held through long declines (MRNA −94%, PTON −95%), with the ladder buying more on the way down;
  - shares stuck with no Call or Put working, for years in PTON's case (1,230 sessions).
- **None of these warns of falls:** the Signals model's fields, a weak market (SPY below its 200-day average), or a steep Put skew. All three point the wrong way.

## How a change is judged

- **Excess Calmar per ticker** = (CAGR − the T-bill CAGR over the same days) ÷ |Max drawdown|. Example: CAGR 18%, T-bills 3% and Max drawdown −40% give (18 − 3) ÷ 40 = 0.375.
- **Better or worse** means Excess Calmar moved by more than 0.005 either way. Smaller moves count as "same".
- **Cash utilization** (the backtest's "capital in use") is the average share of the account committed to shares at cost plus Put collateral.
  - A filter that waits in cash lowers it.
  - It can pass 100% when shares bought high are counted at cost while the account is valued at market (PTON, MRNA).
- **Capital floor:** a variant's cash utilization must stay at 80% or more of the baseline's.
- **A rule passes** only if most tickers get better while staying above the floor, i.e. at least 12 of 22 on each entry.
- **Sign test** (two-sided binomial): with p = 0.50, pure luck would split better against worse at least this unevenly half the time.
- **Before 2026-10-16** (plain wheel research), rules were judged by alpha over a matched mix: the same stocks and T-bills held with the same exposure, compared with paired tests. That method is in the Wheel Research Log below.

## Settings and tickers the drop-risk research used

**Lab settings** as saved on 2026-10-19 at 21:31. Every run started from these and changed one thing:

| Setting | Value |
|---|---|
| Entry | Cash-Secured Put or Covered Call (both entries run) |
| Contracts | \|delta\| 0.05–0.30, 1–45 days to expiry, spread at most 50% of mid, any expiry in range, ranked by premium yield, coverage filled down the ranking |
| Calls on held shares | at or above the break-even, own \|delta\| range 0.05–0.30 |
| Minimum Call yield | 35%, for new Covered Calls only |
| Ladder | reserve ladder; 50% of the pot in shares; 5 rungs; shock from history 40–80% (10-year lookback, 90% with no history); top = today's price; one ladder Put open at a time; a ladder Put instead of a Call when its yield is higher; no \|delta\| range on ladder Puts |
| Off | take-profit, share stop-loss, earnings skip, volatility edge filter, entry filters |
| Looks | every look: 12 a day, every 30 minutes from 10:00 |
| Options in the day's value | marked daily, so Max drawdown includes open options at their marks |
| Fills | at the mid (spread cost share 0) |
| Pot | $100,000 per ticker |

On 2026-10-20 Marcelo updated the lab after this research: minimum Call yield 20%, plus per-ticker pots, share levels and rungs. The results below are on the settings above.

**Development tickers (22):** AAOI, AAPL, ALAB, ASTS, BMNR, CRWV, DOCN, GSAT, HOOD, INTC, IREN, IWM, MRNA, MU, NOK, PTON, QQQ, SMCI, SMH, SPY, TECH, TLT.
- Each runs from 2020-01-02, or its listing, to mid-October 2026.
- GSAT runs 2021-04-22 to 2025-02-10, and IREN from 2023-02-14, because of price-scale gaps in their option files.
- META was left out because its file had no IBKR bars at the time. It was later found to hold another security's options before 2022-06-09 (see "Data and engine issues found").

**Hold-out tickers (6):** BE, COIN, CSCO, NBIS, PLTR, and WDC from 2025-02-25 (after the SanDisk spin-off).
- They have now been used twice: on 2026-10-15 as the ladder's out-of-sample test, and on 2026-10-20 for the entry filters.
- Each use fits later choices to them a little, so they are no longer untouched.

**Second hold-out (7):** MSFT, MSTR, NFLX, ORCL, SOFI (from 2021-06-01), GLD and XLE, newly downloaded; used once, on 2026-10-21 (Round 7).

### The base runs: the strategy on each ticker, against buy and hold

These are the lab as saved, with no filters. CAGR / Max drawdown / Excess Calmar / cash utilization:

| Ticker | Window | Buy and hold | Cash-Secured Put entry | Covered Call entry |
|---|---|---|---|---|
| AAOI | 2020-01-02 → 2026-10-15 | 31.1% / −90.7% | 18.2% / −41.2% / 0.37 / 53% | 21.9% / −41.9% / 0.45 / 60% |
| AAPL | 2020-01-02 → 2026-10-16 | 25.3% / −31.5% | 10.4% / −12.7% / 0.59 / 47% | 12.9% / −14.3% / 0.70 / 48% |
| ALAB | 2024-03-22 → 2026-10-16 | 73.7% / −65.2% | 16.4% / −22.0% / 0.55 / 49% | 29.3% / −31.2% / 0.80 / 55% |
| ASTS | 2021-04-07 → 2026-10-15 | 24.7% / −85.9% | 22.7% / −27.7% / 0.69 / 48% | 13.5% / −37.9% / 0.26 / 63% |
| BMNR | 2025-07-23 → 2026-10-16 | −35.4% / −80.5% | −7.4% / −35.0% / −0.32 / 69% | 5.2% / −36.5% / 0.04 / 72% |
| CRWV | 2025-04-01 → 2026-10-15 | 29.7% / −67.0% | 5.5% / −18.7% / 0.08 / 47% | 1.1% / −20.6% / −0.14 / 54% |
| DOCN | 2021-04-14 → 2026-10-15 | 15.6% / −84.7% | 6.9% / −35.3% / 0.10 / 66% | 10.6% / −40.9% / 0.17 / 77% |
| GSAT | 2021-04-22 → 2025-02-10 | 16.1% / −66.2% | 9.7% / −39.2% / 0.16 / 55% | 8.6% / −42.0% / 0.12 / 54% |
| HOOD | 2021-08-04 → 2026-10-16 | 9.2% / −89.5% | 7.4% / −41.8% / 0.09 / 65% | 12.4% / −36.3% / 0.24 / 61% |
| INTC | 2020-01-02 → 2026-10-16 | 6.4% / −73.0% | 6.8% / −39.6% / 0.10 / 70% | 5.5% / −39.3% / 0.07 / 73% |
| IREN | 2023-02-14 → 2026-10-16 | 89.6% / −66.7% | 29.8% / −20.8% / 1.22 / 39% | 35.5% / −31.5% / 0.98 / 46% |
| IWM | 2020-01-02 → 2026-10-16 | 7.7% / −41.0% | 6.8% / −17.2% / 0.22 / 51% | 6.7% / −18.6% / 0.20 / 54% |
| MRNA | 2020-01-02 → 2026-10-16 | 42.7% / −95.1% | 11.4% / −69.7% / 0.12 / 128% | 20.9% / −76.4% / 0.24 / 167% |
| MU | 2020-01-02 → 2026-10-16 | 50.7% / −58.0% | 18.0% / −19.6% / 0.77 / 51% | 22.3% / −24.8% / 0.78 / 55% |
| NOK | 2020-01-02 → 2026-10-16 | 14.2% / −52.7% | 7.0% / −20.0% / 0.20 / 46% | 13.6% / −24.3% / 0.44 / 46% |
| PTON | 2020-01-02 → 2026-10-16 | −21.9% / −98.3% | −6.2% / −61.4% / −0.15 / 139% | −3.7% / −70.8% / −0.09 / 194% |
| QQQ | 2020-01-02 → 2026-10-16 | 19.5% / −36.8% | 9.0% / −17.5% / 0.35 / 47% | 9.5% / −16.9% / 0.39 / 51% |
| SMCI | 2020-05-04 → 2026-10-16 | 52.0% / −85.2% | 16.4% / −50.7% / 0.26 / 52% | 21.2% / −56.2% / 0.32 / 56% |
| SMH | 2020-01-02 → 2026-10-16 | 34.8% / −46.2% | 13.9% / −17.4% / 0.63 / 46% | 15.8% / −22.1% / 0.58 / 51% |
| SPY | 2020-01-02 → 2026-10-16 | 13.6% / −32.8% | 7.0% / −18.2% / 0.23 / 45% | 8.2% / −18.5% / 0.28 / 49% |
| TECH | 2020-01-02 → 2026-10-16 | 4.1% / −67.1% | 4.7% / −4.1% / 0.44 / 5% | 1.9% / −27.1% / −0.04 / 53% |
| TLT | 2020-01-02 → 2026-10-16 | −7.6% / −56.4% | −1.7% / −22.6% / −0.20 / 73% | −2.4% / −25.2% / −0.21 / 79% |
| **Median** | | 17.8% / −66.8% | 8.2% / −22.3% / 0.22 / 51% | 11.5% / −31.4% / 0.25 / 55% |

Buy and hold's median Excess Calmar is 0.28. The strategy beat it in 17 of the 44 runs.

## Round 12: cutting the Steady Stake's drawdown, and the Steady Stake as a book (2026-10-22 to 2026-10-23)

Report for the hedge part: [Steady Stake Put Hedge](https://claude.ai/artifact/BazD3iCsEDsXvmp5vEbS2T) (without the ladder and hold-out results below). Scripts and results: `tmp/steady-stake-drawdown-research/` (`NOTES.md` lists them). All option fills at the mid, $0.68 a contract; Max drawdown and Excess Calmar as in Round 8.

**The questions (Marcelo 2026-10-22).** First, what Put insurance costs the Steady Stake (80%) and whether timing it helps. Then: reduce its drawdown while keeping its CAGR, or at least improve Excess Calmar, with anything not tried yet. Settings were chosen on the 22 development tickers and checked once on 7 others (DRAM, WDC, NBIS, BE, PLTR, COIN, CSCO); the hold-out was used only where stated.

**Put hedges on the s80 sessions** (the pot pays for the Puts; no borrowing).
- **Mechanical** (120 days, 10% below the price, rolled every 90 days): Max drawdown shallower on 34 of 37 tickers, CAGR lower on 30 (median −3.8 points), Excess Calmar higher on only 17.
- **Timed by IV** (buy when IV ≤ 1.1 × its 252-session median; sell when IV ≥ 1.6 × it, the Put is in the money and the fall is ≥ 0.9 × the ladder's stock shock; 60-day cooldown): best of 96 settings on 8 tickers 0.61 against 0.40 mechanical, but on 21 fresh tickers 0.58 against 0.57 (better on 13 of 21).
- **Dropped on the same 8 tickers:** an IV-percentile gate, 50- and 200-day trend gates, a "price already beaten" filter, a 15% roll-down. Each helped the losers and hurt the crash names.
- **Parabolic run-ups** (5 signal definitions, entry on the signal or at the first momentum break): corrections were bigger, but the stock first rose another 45–89% and the Puts were priced for the fall; 1 of 90 tests beat buying on any day.
- **Ladders:** staggered rolls cut the luck of the roll dates (CAGR spread across shifted calendars 4.8 → 2.2 → 0.8 points with 1, 2, 3 rungs). A strike ladder (10% + 20%) was worse; a two-step exit changed almost nothing.
- **Hold-out** (pass mark 7 of 8, set before): 3-rung mechanical and 2-rung IV-timed both beat no hedge on 5 of 8; drawdown shallower on all 8.
- **Why:** the Puts were priced at about realised volatility (IV ÷ realised 0.82–1.06 on every ticker), so there was no mispricing for timing to harvest. A hedge here trades about 2–4 points of CAGR for a shallower drawdown.

**What the drawdowns are.** Mostly long collapses of one stock: median Max drawdown −55% while SPY fell 8% over the same windows (15 of 37 coincide with SPY down 15% or more). Earnings reactions are a median 11% of the deepest drawdown (INTC 66%, NFLX 50%). The Steady Stake keeps buying back to 80% on the way down.

**Per-ticker rules** (a replay of each s80 session under another stake rule, keeping the session's own option results; against the real s70 sessions the replayed 70% is off by a median 0.31 points of CAGR and 0.16 of Max drawdown, with the right direction on 24 of 29):

| Rule | Development, 22: Excess Calmar better / worse | Development: CAGR, Max drawdown (median change) | Check, 7 |
|---|---|---|---|
| No buying back up in a downtrend (12-month momentum / 200-day average) | 7 / 12 · 6 / 15 | −0.5 / −0.9 points; drawdown +0.3 / +0.9 | 2 / 3 · 3 / 3 |
| Volatility stake, min(80%, budget ÷ 3-year volatility), budget 30% / 40% | 7 / 10 · 9 / 6 | drawdown +9.3 / +5.7 shallower; CAGR lost on the volatile names (IREN 81% → 30%) | CAGR −14.4 / −3.1 |
| 70% stake (reference) | 19 / 3 | −0.8; drawdown +4.9, shallower on all 22 | 3 / 4, CAGR −5.7 |
| Earnings collar (Put ≈ 95%, Call above the price at zero cost, 10:00 before to 10:00 after each report) | 9 / 6 (16 with reports) | +2.1; drawdown +1.4 | 3 / 2, CAGR mean −9.2 (NBIS −46) |

- The volatility stake and 70% lower drawdown and CAGR together: risk dials, not improvements.
- The collar has no edge: −0.18% of the shares covered per collar (90% range −0.96% to +0.49%); each ticker's result is the direction of its reports. 46 of 380 collars had to be skipped because Steady Stake sells its own Calls on every share on expiry days (Monday reporters such as PLTR and ASTS open on a Friday). Limited to downtrends it failed on the development tickers (6 / 8 and 10 / 5 with a median drawdown change of 0.0) and was not checked.

**The Steady Stake as a book.**
- **Replay** (equal weights rebalanced monthly among the tickers trading): 22 development tickers CAGR 34.3%, Max drawdown −36.0%, Excess Calmar 0.87, against single-ticker medians of 18.4%, −57%, 0.34. Inside the book every dial lowered drawdown and CAGR together (70%: 0.85; volatility stake 40%: 0.86; weights ∝ 1 ÷ volatility: 0.78). The 7-ticker check book drew down −59% (until 2024 it held only BE, CSCO, PLTR, COIN): a book needs breadth. The book's CAGR above the median ticker comes from holding the high-CAGR names and from rebalancing, and the tickers were picked in 2026: read the drawdown cut, not the CAGR, as the result.
- **Engine** (session `0ff733bd`, local): the 13 development tickers with data for all of 2020–2026 (AAOI, AAPL, INTC, IWM, MRNA, MU, NOK, PTON, QQQ, SMH, SPY, TECH, TLT), one shared account of $1.3M ($100k a ticker; each ticker's pot is the account ÷ 13 every morning), 2020-01-02 to 2026-10-15: CAGR 24.1%, Max drawdown −36.0% (Sep 2021 → Oct 2022), Excess Calmar 0.59, against 25.6%, −36.0%, 0.63 for the replay of the same 13 and single-ticker medians of 13.5% (mean 18.4%), −43.4%, 0.39. SPY and AAPL trade much less than in their own sessions ($800k and $290k pots there).

**Cash in use** ((shares + Put collateral) ÷ account, right after the 10:00 orders, the day's peak; overnight it is the shares alone):
- Min 77.8%, median 80.9%, max 91.2%. Sessions in 90–95%: 0.4%; 85–90%: 12.8%; 80–85%: 62.4%; 75–80%: 24.4%; never 95% or more. Within 1, 2 and 5 points of the max: 0.2%, 1.1%, 8.6% of sessions. Friday median 85.2%, other days about 80.5%.
- The Puts held a median 0.9% of the account (mean 1.9%): 4.4% of the cash outside the shares at the median, 9.5% on average, 26.9% on Fridays.
- **Why so little.** On Fridays, of 13 tickers × 340 Fridays: a Put sold 34%; no strike with |delta| 0.15–0.25 at 10:00 27% (with 6 hours left that window is about 0.4% of the price wide, single-stock strikes are 1–1.4% apart); Puts in the window but bid under $0.05 or spread over 50% 17% (MRNA, AAOI, PTON, NOK, TECH); one contract dearer than the ticker's spare cash 14% (SPY on 92% of its Fridays, QQQ 63%); no expiry 7% (TECH: monthly only). Monday to Thursday 81% of ticker-days have no expiry. When a Put sold it used most of the ticker's spare cash (median 62–99%). Widening the tolerance to ±0.10 would have found a Put on 27% of the blocked Fridays, ±0.15 on 37%; beyond that thin quotes limit it.
- **What the Puts earn.** 2,679 sales: premium mean 0.177% of the strike (the 49% "premium yield" shown on a sale is that × 365), expiry losses 0.120% (15.5% end in the money, 0.78% each), net 0.049% after commissions: $48k on $167k of premium over 6.8 years, 29% kept. By ticker the share kept ranges from 42–46% (MRNA, QQQ, TLT) to 19–28% (SMH, AAPL, IWM, SPY) and nothing on INTC.

**Not decided** (Marcelo stopped testing on 2026-10-23): letting the tickers share the cash for Puts (a pass handing the account's free cash out one contract at a time, least-exposed ticker first, within a per-ticker cap) and a wider delta tolerance (a setting already). Both would mainly add 0DTE Puts on SPY, QQQ and IWM.

**Engine facts found along the way.** Steady Stake runs only as one shared account with equal weights (symbol settings are the baseline's); a session's dates must lie inside every ticker's file; the 13-ticker book took 46 minutes against seconds to minutes per single ticker; the local backtest queue runs strictly oldest first.

## Round 11: long-dated Put hedges on the ladder (2026-10-22 to 2026-10-23)

Results dashboard for the first hedge (stages 4 and 5): https://claude.ai/artifact/99M6CvvC1RtTeTcrGzW98r. Scripts, run specs and notes on every stage are in `tmp/hedge-research/` (NOTES.md). The settings are the lab's Hedge group, off by default (FORMULAS.md, "The hedge").

**The question (Marcelo).** Buy long-dated Puts to neutralise the ladder's deep drawdowns without losing much return. Then: which Puts, when to buy them, how long to keep them, when to replace them.

**Settings.** The ladder at NFLX's baseline values (60% of the pot in shares, a fixed 70% shock, 2 rungs), each ticker on its lab pot and window, fills at the mid. Deciding tickers (29): AAOI, AAPL, ALAB, ASTS, BE, BMNR, COIN, CRWV, CSCO, DOCN, DRAM, GSAT, HOOD, INTC, IREN, IWM, MRNA, MU, NBIS, NOK, PLTR, PTON, QQQ, SMCI, SMH, SPY, TECH, TLT, WDC. NFLX was reported apart, since the first hedge's settings were picked on it. The hold-out (GOOGL, MSFT, MSTR, ORCL, SOFI, GLD, XLE) was not run.

**1. Puts on the shares each entry brings in.** About 1-year Puts, one per 100 shares an entry brings in, sold when a ladder rung is assigned or the shares leave.
- NFLX: better on all 100 ladder settings tried. At-the-money Puts added a median 3.0 points of CAGR and cut the Max drawdown by 31 points.
- 29 deciding tickers: Max drawdown shallower on every ticker, CAGR lower on most. The best setting (wait 30 days between purchases, Puts 10% below, 80% shares, 70% shock, 1 rung) had a median Excess Calmar of 0.32 against the baseline's 0.31, better on 11 of 29 (p 0.27).
- Three rules to buy fewer Puts: keep them 30 days for the next entry, keep them unless struck 10% below the new price, or wait 30 days between purchases. Keeping halved the purchases (a median 14–15 against 27–29) without changing the result.

**2. Why it failed (no backtest; 5 tickers and the baselines).**
- The deep falls were slow. On the 11 deciding tickers whose baseline fell 40% or more, the fall took a median 479 sessions from peak to trough, with 62% of it in the worst 60 sessions. 9 of the 11 began in 2021.
- Most of the loss came from shares the ladder added on the way down. PTON −85.6 points: −54.5 on shares added, −41.7 on shares held at the peak, +10.7 from options. MRNA −70.4: no shares at the peak, −68.9 on shares added. SPY −18.5: all on shares assigned during the fall. The entry hedge never covered those shares, and it sold Puts as rungs were assigned.
- On the stock alone, fully funded, with Puts in 3 staggered expiries: 1-year Puts rolled with 3 months left beat holding less stock at the same Max drawdown on 4–5 of PTON, MRNA, SMCI, MU and SPY. 60- and 90-day Puts did so on 1–3. Even the best cut the single stocks' Max drawdown by only 12–32% (SPY 59%): each roll re-strikes lower, so slow falls get through.

**3. Puts on the whole position.** The shares held plus the shares the open short Puts would bring. 1-year Puts over 3 staggered expiries, kept until 90 days are left, whatever the shares do. CAGR / Max drawdown / Excess Calmar:

| Ticker | Baseline | At the money | 20% below |
|---|---|---|---|
| PTON | −15.2% / −85.6% / −0.21 | 3.7% / −15.7% / 0.05 | 3.6% / −25.0% / 0.03 |
| MRNA | 18.9% / −70.4% / 0.23 | 18.0% / −23.4% / 0.64 | 15.3% / −35.1% / 0.35 |
| SMCI | 21.7% / −40.5% / 0.46 | 10.8% / −29.6% / 0.26 | 13.3% / −23.4% / 0.44 |
| MU | 28.0% / −23.4% / 1.07 | 13.8% / −14.5% / 0.75 | 17.9% / −20.5% / 0.73 |
| SPY | 8.6% / −18.5% / 0.31 | 5.5% / −7.0% / 0.37 | 7.4% / −12.8% / 0.35 |

The Max drawdown was shallower on all five, and Excess Calmar better on three. On MU and SMCI the Puts lost 6–16% of the pot a year.

**4. Cutting the cost, same 5 tickers.** Each row against the baseline:

| Whole position, 1-year Puts | Excess Calmar better | Median change | Median CAGR change | Max drawdown shallower |
|---|---|---|---|---|
| At the money | 3 of 5 | +0.06 | −3.1 | 5 |
| \|delta\| 0.25 | 3 of 5 | +0.05 | −2.8 | 5 |
| Half the Puts, 20% below | 3 of 5 | +0.03 | −2.7 | 5 (by much less) |
| \|delta\| 0.25, none while IV > 1.3 × its 252-session median | 2 of 5 | −0.01 | −2.8 | 4 |
| \|delta\| 0.25, none while IV > 1.3 × the 21-session realized volatility | 3 of 5 | +0.04 | −5.2 | 5 |
| \|delta\| 0.25, none while the yearly cost > 0.2 × the typical yearly fall | 2 of 5 | −0.05 | −0.9 | 3 |
| the same, 0.3 × | 3 of 5 | +0.09 | +0.7 | 4 |
| the same, 0.4 × | 3 of 5 | +0.10 | −2.3 | 4 |

- MU was worse than its baseline under every variant.
- Skipping Puts while IV was high against its history left SPY's 2020 fall unhedged: 21 Puts bought, Max drawdown unchanged at −18.5%.
- The cost cap tied to the stock's typical yearly fall (Marcelo's idea) had the best medians, but its results don't move steadily with the cap. SMCI scored 0.36, 0.55 and 0.34 at 0.2, 0.3 and 0.4, which is path noise on 5 tickers.

**Where it stands.** Marcelo stopped the research on 2026-10-23, before a test on the 29 deciding tickers. If it is picked up again, the candidates are: the whole position at the money, and |delta| 0.25 with the cost cap at 0.3 and 0.4. Judge them by median Excess Calmar, with 21 of 29 tickers better for a pass.

## Round 10: Edge Margin's model audited, then a premium-first strategy (2026-10-22)

No report published. Scripts and results are in `tmp/edge-margin-audit/`:
- base and variant sessions: `make_specs.py`, `runner.py`, `compare.py`;
- contract studies: `dump_candidates.ts`, `outcomes.py`, `report_signal.py`, `delta_neutral_study.py`, `universe_study.py`, `universe_beyond_drift.py`, `predictors_beyond_drift.py`, `weekend_check.py`;
- strategy simulations: `sim_weekly_puts.py`, `sim_book.py`, `trades_check.py`, `cash_account_check.py`, `selective_check.py`;
- the ticker scan: `scan_tradable.py`.

**The questions (Marcelo 2026-10-22).**
- Before judging Edge Margin, check how it measures volatility: the forecast, the ranges it is compared with, and the days-to-expiry range.
- Then find a strategy that earns most of its CAGR from option premium.
  - It had to use tickers a pot can trade.
  - It was built on one half of them and checked on the other.
  - Simple tests came first.

**Edge Margin's model.**
- **Base.** Edge Margin on Pluto's rules ran on 43 tickers, $1M each, with the whole pot available: median CAGR 9.7%, Max drawdown −32.3%, Excess Calmar 0.19. Buy and hold made 19.1%, with Excess Calmar 0.31. Edge Margin had the higher Excess Calmar on 16 of 43.
- **Two flaws.**
  - The 21-day Yang-Zhang forecast includes the sessions that react to earnings.
  - The live curve says 0.309 of a session's variance is still ahead at 10:00, from June–October 2026. Measured over 2020–2026 the share is 0.438 (0.635 at 09:30).
- **Both fixed, on 29 tickers** (the batch was stopped there): Excess Calmar better on 19 and worse on 9 (p 0.087). Median CAGR rose 0.3 points.
- **Does the edge sort contracts?** Each session's 10:00 candidates, about 890,000 contracts, were held to expiry and delta-hedged at each close.
  - Edge Margin's edge margin doesn't sort them by outcome, with or without the fixes.
  - An edge built on IBKR's 30-day implied volatility does at 1–5 days. Its top fifth beat the bottom fifth by 29.0 points of premium at 1 day (95% range 10.1 to 49.6) and by 18.3 at 3–5 days (2.8 to 32.6). But the top fifth still lost after costs.
  - Hedged 1-day options lost 17–19% of their premium on single stocks; on ETFs they didn't.
- **Built, then removed.** API commit `ec5e4ff` added two backtest session settings; live was unchanged. Marcelo decided on 2026-10-22 to take them out again. The rules backtests' retirement on 2026-10-27 deleted the code that read them, so on 2026-10-29 the leftovers were removed by hand instead of by a revert. Restoring the settings means re-applying `ec5e4ff` by hand.
  - `model.forecastMethod`: `yang_zhang_21`, `yang_zhang_21_without_earnings` or `implied_volatility_30_day`.
  - `model.restOfDayCurve`: `measured_2026_june_to_october` or `measured_2020_to_2026`.

**Other structures, dropped.**
- Calendars (7 and 30 days), and Straddles and Strangles on single stocks, delta-hedged every 30 minutes, lost money.
- SPY + QQQ Strangles at \|delta\| 0.25 on their expiry day, hedged every 30 minutes at $0.68 a contract, made 9.9% with a −3.7% Max drawdown at 1×. They were set aside for three reasons:
  - SPY and QQQ were outside the tradable set;
  - they need a margin account;
  - the edge shrank in 2025–26.

**Tickers.** With option liquidity and a price under $150 (a $100k pot) there were 11 tickers, split in two halves:
- Development: SOFI, IREN, ASTS, BAC, TLT, INTC.
- Validation: SMCI, RKLB, HOOD, ORCL, NOK.

**Where the premium is.** The study took every out-of-the-money Put and Call at 10:00 with 1–45 days left (bid ≥ $0.05, spread ≤ 50% of the mid), held to the expiry close, with the same dollars in each contract.
- **How each contract was scored.** Its P&L after half the spread and $0.68 a contract, less \|delta\| × the stock's move to expiry. That last part removes the stock's drift: a 0.15-delta Put on a $20 stock that ends $1 higher made about $0.15 a share from the rise alone.
- **Puts with 4–7 days left at \|delta\| 0.05–0.25 carry the clearest premium.**
  - Development: +11% to +17.5% a year per dollar of capital, positive on 6 of 6 tickers.
  - Validation: +7% to +10%, positive on 3 of 4 and 4 of 5.
  - Shorter Puts were positive only far out of the money. Puts with 15+ days were near zero or negative.
- **These are yields per dollar per day, which flatters short contracts.** Per trade on a weekly cycle (\|delta\| 0.10–0.20, beyond drift):
  - Development: +0.30% selling Friday for the next Friday, +0.20% selling Monday for Friday.
  - Validation: +0.08% and +0.11%.
- **Calls.**
  - Validation: negative beyond drift in 23 of 24 expiry and delta groups.
  - Development: +5% to +8% at 4–7 days, near zero or negative elsewhere.
- **Within 7-day Puts, the expensive ones carry the premium.**
  - Entry yield: the top third made +29% (development) and +27% (validation) a year beyond drift. The bottom third made 0% and −8%. The top beat the bottom on 6 of 6 and 4 of 4 tickers.
  - IV rank over the previous 252 sessions: the top third made +34% and +20%, against 0% and +3% (6 of 6, 3 of 4).
  - Trend and the last 21 sessions' return showed no pattern.
- **Two traps in the first readout, corrected above.**
  - Its yields included the stock's drift, the trap noted in Round 2's Wheel Research Log.
  - It weighted contracts by their strike as traded. High-price periods dominated, and SMCI before its 10:1 split counted ten times.
  - The 4–7 day result survived the correction. "Implied volatility doesn't predict" reversed, per contract.

**The strategy: one weekly Put per ticker, never holding stock.**
- **Rule.**
  - At 10:00, sell the Put with 4–7 days left nearest the target \|delta\|, at the mid less half the spread, $0.68 a contract.
  - Settle it in cash at the expiry close, and mark it at the end-of-day mid every day.
  - Cash earns T-bills (DTB3), 3.0% a year over these windows.
- **Book.** The 11 tickers in equal parts of $100k each, about the $1M Marcelo set for 11 tickers. Each month the money goes to the tickers that sold a Put the month before.

| \|delta\| 0.15, 11 tickers | CAGR | Max drawdown | Excess Calmar |
|---|---|---|---|
| Cash account: Puts on half of each ticker's cash, the next one sold on the old one's expiry morning | 6.6% | −5.2% | 0.71 |
| Cash account: full size, the next one sold the day after expiry | 4.4% | −8.1% | 0.18 |
| Margin account: full size, the next one sold on the expiry morning | 10.2% | −10.4% | 0.70 |
| Margin account at 2× | 17.4% | −20.7% | 0.69 |
| Buy and hold, same 11, rebalanced monthly | 36.2% | −39.5% | 0.84 |

- **\|delta\| 0.15 was best or tied on both halves.** Excess Calmar was 0.62 (development) and 0.67 (validation) in the cash account, and 0.62 and 0.63 at full size.
- **The IBKR account is a cash account** (Marcelo 2026-10-22).
  - A Put's cash stays held until it expires, so the next full-size Put can't be sold on the expiry morning. Leverage is out too.
  - Buying the old Put back at 10:00 to free its cash made about 0.6% a year. The ask plus $0.68 on 20–200 contracts of a cheap stock cost more than the edge.
- **Where the return comes from.** Per trade at full size, as a share of the capital at the strike:

  | Per trade | Development | Validation |
  |---|---|---|
  | Premium at mid | 73.6 bp | 82.5 bp |
  | − half the spread | −6.9 | −7.6 |
  | − fee | −2.3 | −1.8 |
  | − payoff | −40.4 | −52.3 |
  | = net | 24.0 bp | 20.8 bp |
  | of which the stock's move × \|delta\| | 7.2 | 21.8 |
  | **Beyond drift** | **16.8 bp (7.3% a year)** | **−1.0 bp (−0.3% a year)** |

  - Beyond drift per ticker, % a year: ASTS +14.2, IREN +12.2, SOFI +9.2, ORCL +4.1, NOK +3.0, TLT +2.6, BAC +0.5, RKLB +0.5, HOOD −0.8, INTC −2.9, SMCI −12.4.
  - Of the cash book's 6.6%, 3.0 points were T-bills and about 3.6 came from options. About 1.4 of those 3.6 was premium beyond drift.
- **Selling only when IV rank is high doesn't help the cash book.**
  - At 0.33 or more, Excess Calmar went to 0.88 on development but 0.45 on validation, from 0.62 and 0.67.
  - At 0.50 it was 0.44 and 0.21.
  - Premium beyond drift per trade rose (8.0 → 13.7 → 27.4 bp), but sales fell (36.5 → 17.6 → 10.3 a year per ticker). The expensive weeks are also when the crashes come (SMCI).
- **Daily marks.** Each ticker's Max drawdown was a median 2 points deeper than marking only at expiry, 6 at most (ASTS).
- **Idle weeks.**
  - Friday-only weeklies allow one sale a week.
  - ASTS, RKLB, IREN and SMCI had no weeklies before 2023–24.
  - SOFI, HOOD and NOK premiums fell below the $0.05 bid in their low-price years. NOK sold about 4 times a year.
- **Still optimistic.** An in-the-money Put settles at the close's intrinsic value for free, and IBKR pays less than T-bills on cash.
- **Not tested.**
  - **ETFs with Monday, Wednesday and Friday expiries:** SPY through 2020–26, and IWM, GLD, XLE and QQQ since September 2020. They would let a cash account sell full size every week and keep the weekend. Single stocks got these expiries only in 2026: AAPL, MSFT and GOOGL from January, MU from July.
  - **LEAPS instead of shares:** the tickers were picked because they are liquid today, so a backtest would flatter them (see N-06 in IDEAS-TO-TRY.md).

**Conclusion.** No alpha in selling premium on these single stocks.
- Edge Margin's ranking doesn't predict outcomes.
- The only premium found, in Puts with 4–7 days left, is small after costs. Most of what the Put book earns above T-bills is the stocks' rise.
- A cash account halves what can be sold.

Marcelo closed the research on 2026-10-22: "I don't think there's alpha here."

Confidence:
- high that Edge Margin's edge doesn't sort outcomes, and that a weekly Put book has small drawdowns;
- moderate that 4–7 day Puts carry premium beyond drift;
- low on how big that premium is.

## Round 9: Pluto's two execution strategies side by side, Edge Margin against the ladder (2026-10-21)

Report: [Edge Margin vs Ladder](https://claude.ai/artifact/SLfkVPPCmLaUoi6KZkrKcR). Scripts and results: `tmp/strategy-compare/` (`make_book_specs.py`, `runner.py`, `compare.py`, `build_report.py`, `findings.json`; books in `out/`). Sessions "Strategy compare book 21 · …" in the local database.

**The question (Marcelo 2026-10-21).** Backtest both of Pluto's execution strategies side by side, with the same capital and comparable settings, on 20+ tickers.

**Setup.**
- **One book each:** $3,266,600, the sum of the lab's pots, from 2021-08-04 (HOOD's first day; a book needs every ticker's files) to 2026-10-15.
- **21 tickers:** AAOI, AAPL, INTC, IWM, MRNA, MU, NOK, PTON, QQQ, SMCI, SMH, SPY, TECH, TLT, BE, CSCO, GLD, XLE, COIN, HOOD, PLTR.
- **The ladder:** the lab as saved.
- **Edge Margin:** Pluto's rules on live Pluto's settings (staging, 2026-10-21), with two changes so it has the same capital: `capitalBudgetPct` 100 (live 50) and `minCashReservePct` 0 (live 5). It is replayed without the LLM agent.
- **Earnings:** Edge Margin needs each stock's earnings history, and without it every contract fails `earnings_unresolved`. AAPL, MRNA and PTON were copied from staging. MSFT, MSTR, NFLX and ORCL have no history before late 2025 in any source, so they were left out.

**Results.**

| Book | CAGR | Max drawdown | Excess Calmar | Sortino | Volatility | Cash use |
|---|---|---|---|---|---|---|
| Edge Margin | 10.3% | −38.6% | 0.17 | 0.59 | 18.7% | 96% |
| CC + Put Ladder | 10.0% | −14.9% | 0.42 | 1.00 | 8.7% | 63% |
| Buy and hold (pots) | 23.8% | −32.0% | 0.63 | 1.00 | 33.0% | |
| SPY | 11.3% | −26.6% | 0.28 | 0.71 | 16.8% | |

- **2022 decides it.** Edge Margin lost 31.2% that year and the ladder lost 9.7%. Edge Margin took until June 2024 to recover its 2021 peak; the ladder recovered by July 2023. From 2023 on Edge Margin did better: 28.7% a year against 17.1%, with Excess Calmar 1.43 against 1.36.
- **Per ticker:** Edge Margin made more on 12 tickers and the ladder on 9.
  - Edge Margin's gains came from the volatile stocks that rallied after 2022, such as MU, INTC, MRNA and PLTR.
  - Its losses came from NOK, TLT and PTON.
  - Its valuation model rarely found SPY, GLD or AAPL rich enough to sell, and it never traded TECH, whose chain is too thin for the volatility surface.
- **Live Pluto runs Edge Margin at a 50% budget.** At half the exposure its returns and drawdowns would both be roughly halved, so the risk-adjusted gap holds.

**Conclusion.** The ladder earned the same with well under half the drawdown. Confidence: moderate, because this is one five-year path decided by one bear market. Marcelo then asked for the ladder to be brought to Pluto's safety standard (PROGRESS.md, "CC + Put Ladder brought to Pluto's safety standard"). Staging keeps running Edge Margin for now.

## Round 8: a new strategy against the ladder, the Steady Stake (2026-10-21)

Report: [Steady Stake](https://claude.ai/artifact/LftjcArCiqMwGGyYkJi6zy). Scripts: `tmp/new-strategy-research/` (`NOTES.md` holds the bar and the pre-registered choice; `make_specs.py`, `runner.py`, `report_data.py`, `make_extras.py`, `build_report.py`; studies `exposure_rules.py`, `exposure_rules_levels.py`, `vrp_study.py`, `vrp_summary.py`). Runs: `out_dev5/`, `out_val17/`, `out_bench/` (the ladder on the hold-out and the rest), `out_final/`, `out_sc50/`.

**The question (Marcelo 2026-10-21).** Design from scratch a Covered Call, Cash-Secured Put or wheel strategy that beats the ladder on Calmar and/or CAGR. His bar, against the ladder on the lab as saved (same windows and pots): median CAGR at least 3 points higher; CAGR higher on a clear majority of tickers (sign test p < 0.05); median Excess Calmar no more than 0.05 lower; Excess Calmar above buy and hold's on a majority.

**What the studies found first.**
- **The ladder's weak spot is its exposure path.** It holds close to 100% stock after falls and about 30% after rallies: the unpaid "buy the fall" exposure Israelov & Nielsen measured inside Covered Calls (LITERATURE-REVIEW.md §3).
- **A steady stake beats buy and hold on stock alone.** 15 tickers (the first 5 development tickers plus AMAT, BSBR, COHR, DELL, GS, IGV, IONQ, LITE, META, SNDK), shares and T-bills only, from 2020: a 70% stake rebalanced in a ±5-point band beat buy and hold's Excess Calmar on 12 of 15 (median CAGR 29% against 25%), 80% on 10 of 15. Volatility-scaled stakes: 1 to 8 of 15. Trend and drawdown rules: 3 to 12 of 15, depending on settings and on same-day or next-day trading.
- **Option premium is paid on the expiry day.** Every 10:00 chain 2020–2026 on SPY, AAPL, MU, MRNA and HOOD, contracts nearest |delta| 0.10–0.30 held to expiry and delta-hedged daily: sellers kept 29% of the premium on expiry-day Calls (t 6.2, monthly clusters) and 24% on Puts (t 5.1); Calls with 1–45 days left kept 2% or less (−9% at 31–45 days), Puts 2–8%. The ladder never sells on the expiry day (lab minimum 1 day); its median sale has 10 days left.

**The strategy** (decision maker `steady_stake`, backtest only). At the 10:00 look: hold s = 80% of the ticker's pot in shares, traded back to s once off by more than 5 points of the pot. On a day the ticker has an expiry, sell that day's Call nearest |delta| 0.20 (± 0.05) on every free round lot and that day's Put nearest |delta| 0.20 on the pot's free cash (P − shares − open Put collateral), within the ladder's quote rules (bid ≥ $0.05, spread ≤ 50% of the mid, 20% of the previous session's volume). Settlement at that day's close; the next 10:00 look rebalances. Fills at the mid, $0.68 a contract, $0.005 a share.

**Stages.** Built on SPY, AAPL, MU, MRNA, HOOD; validated on the other 17 development tickers. The choice between 70% and 80% was written down before the 80% runs were read: the higher median CAGR on the 22 among those passing all four conditions. Both passed; 80% won by 0.3 points (18.6% against 18.2%), with the lower Excess Calmar (0.34 against 0.37). 80% then ran once on the hold-out (GOOGL, MSFT, MSTR, NFLX, ORCL, SOFI, GLD, XLE) and on BE, COIN, CSCO, NBIS, PLTR, WDC (from 2025-02-25), DRAM (from 2026-04-07). AMD, AMZN, AVGO, NVDA, TSLA: downloads unfinished, left out.

**Results (80% stake).**

| Tickers | Median CAGR (Steady / ladder / buy and hold) | Median Max drawdown | Median Excess Calmar | CAGR above the ladder's | Excess Calmar above the ladder's | Excess Calmar above buy and hold's | Bar |
|---|---|---|---|---|---|---|---|
| Development, 22 | 18.6% / 10.1% / 17.8% | −57% / −37% / −67% | 0.34 / 0.30 / 0.28 | 18 of 22 (p 0.004) | 16 of 22 | 20 of 22 | 4 of 4 |
| Hold-out, 8 | 15.7% / 10.1% / 14.9% | −53% / −36% / −63% | 0.35 / 0.22 / 0.30 | 7 of 8 (p 0.07) | 5 of 8 | 8 of 8 | 3 of 4: the sign test needs 8 of 8 |
| All, 37 | 17.8% / 10.7% / 19.5% | −55% / −33% / −66% | 0.46 / 0.31 / 0.33 | 31 of 37 (p < 0.001) | 26 of 37 | 33 of 37 | 4 of 4 |

- **Book** (every ticker in equal parts, rebalanced daily): CAGR 34.5% against the ladder's 14.2% and buy and hold's 40.4%; Max drawdown −37% / −22% / −45%; Excess Calmar 0.86 / 0.51 / 0.83.
- **70% instead of 80%** (all 37): median CAGR 17.8%, Max drawdown −49%, Excess Calmar 0.48; passes all four too. Ticker by ticker 80% has the higher CAGR on 24 of 37 (median +0.9 points) and the deeper Max drawdown on all 37 (median 4.7 points).
- **The options' share** (70% stake with and without options, 22 development tickers): CAGR higher with them on 13, lower on 7 (median +0.3 points, mean +1.2). They pay on SPY, QQQ, IWM, SMH, MU, MRNA, CRWV; they cost on ASTS, IREN, ALAB, AAPL. The stake alone beat the ladder's CAGR on 20 of 22 and passed all four conditions there.
- **Spreads and fills:** capping spreads at 20% of the mid changed the 70% stake's CAGR by a median 0.0 points (17 tickers). With every option fill a quarter of the spread below the mid for both strategies (`s80sc50` against `laddersc50`, all 37): median CAGR 17.6% against 9.8%, higher on 33 of 37, Excess Calmar 0.45 against 0.24; still 4 of 4. The ladder loses more to it (median 0.8 points of CAGR against 0.3): it sells more premium a year (median 14.6% of the account against 8.0%).
- **By period:** 2020–2022 is close (CAGR above the ladder's on 17 of 30, Excess Calmar on 18 of 30); 2023–2026 carries the CAGR gap (32 of 37).
- **Where the return comes from** (added 2026-10-22; report section 4): between 10:00 marks, return = stock + premium − assignment charges − commissions + interest, with the whole run split by Carino linking (approved by Marcelo). Medians in CAGR points: stock +16.5, premium +5.5, charges −4.2, commissions −0.2, interest +0.7. Against the same 80% stake without options (`s80bare`, 37 runs), the options add a median +1.3 points (more on 25 tickers, less on 9); the stake alone beats the ladder's CAGR on 30 of 37. On jumpy stocks the cost is the night after a Call is assigned (out at the close, back at the next 10:00): ALAB −11.5, ASTS −5.9, IREN −4.7, which the accounting split can't show. Day-by-day replays of SPY and MU (`timeline_data.py`) match the engine's cash on all 1,707 days.
- **Where it loses:** CAGR below the ladder's on ASTS, BMNR, COIN, NOK, PTON, SOFI (long falls or ranges); Max drawdown deeper than the ladder's on 34 of 37; Excess Calmar not above buy and hold's on AAPL, ALAB, NBIS, PLTR.

**Built.** API commits `ed71d06` (decision maker, settings, `buy_shares` action, migration `20261021300001`), `f19236d` (default stake 80%), `791f32e` (route test). With these changes a stored 22-ticker ladder session (30d61cc5) replays identical on every row. The Backtesting screen waits for Marcelo's approval of the mockup (https://claude.ai/artifact/4oLTnmM2UGeaRw98fHw371); the formulas wait for his sign-off; Pluto live is not started.

## Round 7: falling-knife guard and Kelly sizing (2026-10-21)

Report: [Knife Guard and Kelly Sizing](https://claude.ai/artifact/AdrV8SHr5ackXZ5QdqQBFQ). Scripts: `tmp/kelly-research/` (`make_specs.py`, `runner.py`, `score.py`, `activity.py`, `llm_knife_pilot.py`, `build_report.py`). Runs: `out/` (development tickers), `out_holdout/` (hold-out).

**The question (Marcelo 2026-10-21).** Can sizing new buying by what the market says at each look, less near tops and more near bottoms, improve CAGR or Excess Calmar? And is Kelly the way to fix the ladder's known weak spot, buying more on the way down? Tested in three parts: the guard alone, Kelly alone, both together.

**What was built.** Two lab switches, both off by default; removed on 2026-10-21 after these results (archived in API commit 1bdc501 and app commit 56399f9; reverting b1a9711 and 53b0847 restores it). With both off, Marcelo's NFLX session 9f871ebb replayed identically on every stored row. Live Pluto passes no sizing, so its orders are unchanged.
- **Falling-knife guard** (`knifeGuard`: off / market_share / market_share_and_iv; `knifeGuardMinScale`). It acts only while the previous close is 25% or more below its 252-session closing high.
  - q = min(1, max(0, β × SPY's fall from its 252-session high ÷ the stock's fall)), the market's share of the fall, where β is the slope of the stock's daily log returns on SPY's over 252 sessions.
  - New buying × K, with K = minimum + (1 − minimum) × min(1, q ÷ 0.5). With IV: K × 0.5 unless the latest IV is 10% or more below its 21-session high.
  - Example: PTON on 2021-11-08 was 67% below its high with SPY at its high, so q = 0.00 and, with minimum 0, K = 0: no new buying. PTON fell another 53% within 63 sessions.
- **Kelly sizing** (`kellySizing`: disabled / dynamic; `kellyMultiplierRule`, `kellyTopFromZ`, `kellyTopToZ`, `kellyMaxMultiplier`, `kellySpyMove`, `kellyAtTops`, `kellyConstantMultiplier`). New buying × m, from extension z (Round 6's z).
  - m = 1 from z 0 to z₀, falls linearly to 0 at z₁, and rises to the most (×1.5 or ×2) as z falls to −1. Optionally m × (1 − 0.5 × clamp((SPY's 21-session move − 2%) ÷ 4%, 0, 1)).
  - Example: MRNA at z 0.73 with the cut from 0.5 to 1.5: m = 1 − (0.73 − 0.5) ÷ 1 = 0.77, so 2 lots instead of 3.
  - m scales the entries' room (m × shares' budget − shares at cost − open Put collateral) and the ladder Put's collateral (m × the rung); the strike cap keeps the unscaled rung. Calls on held shares are never scaled.
  - The pool: with Dynamic, the ladder's reserve becomes base − h₀ × shares' budget, where h₀ is the share of the budget held when the ladder starts. What the entries leave unspent joins the reserve.
  - At tops (z ≥ z₀) the held-back room either waits in cash or secures Puts at a strike ≤ price × (1 − 0.30 × (1 − m)).
- **Both on:** new buying × m × K, kept between 0 and Kelly's most.
- Code: `src/backtest/engine/ladderSizing.ts`, `baselineSaleSteps.ts`, `backtestBaselineLadder.ts`, `backtestBaselineLook.ts`.

**Setup.**
- The lab as saved on 20 October (per-ticker pots, share levels and rungs; entry: whichever ranks higher), one session per ticker, on the 22 development tickers and windows above: 27 versions, 3 constant controls and the base, 682 sessions.
- Hold-out: MSFT, MSTR, NFLX, ORCL, SOFI, GLD and XLE, from 2020-01-02 (SOFI 2021-06-01) to 2026-10-16, fresh and used once: the base and each part's pick, 28 sessions.
- Two Part 3 versions (Part 2's best Kelly with the guard at 0.5, and with the guard + IV) were added after Part 2's results. The second became Part 3's hold-out pick.

**Base runs** (the lab of 20 October, both switches off):

| Ticker | CAGR | Max drawdown | Excess Calmar | Cash utilization |
|---|---|---|---|---|
| AAOI | 18.2% | −52.6% | 0.29 | 76% |
| AAPL | 13.4% | −16.5% | 0.64 | 61% |
| ALAB | 21.2% | −29.4% | 0.57 | 64% |
| ASTS | 27.7% | −46.5% | 0.52 | 70% |
| BMNR | −6.7% | −38.5% | −0.27 | 88% |
| CRWV | 9.2% | −16.7% | 0.32 | 45% |
| DOCN | 7.0% | −42.2% | 0.08 | 84% |
| GSAT | 10.2% | −56.7% | 0.12 | 92% |
| HOOD | 8.5% | −42.8% | 0.11 | 69% |
| INTC | 7.8% | −46.6% | 0.11 | 100% |
| IREN | 47.3% | −38.5% | 1.11 | 56% |
| IWM | 6.6% | −23.0% | 0.16 | 73% |
| MRNA | 18.1% | −78.0% | 0.20 | 188% |
| MU | 27.2% | −26.4% | 0.92 | 66% |
| NOK | 17.6% | −29.9% | 0.49 | 66% |
| PTON | −11.1% | −79.6% | −0.18 | 290% |
| QQQ | 9.9% | −20.9% | 0.33 | 52% |
| SMCI | 21.1% | −57.6% | 0.31 | 62% |
| SMH | 16.5% | −27.1% | 0.50 | 66% |
| SPY | 9.9% | −19.1% | 0.37 | 63% |
| TECH | 4.7% | −33.9% | 0.05 | 71% |
| TLT | −4.6% | −35.6% | −0.21 | 109% |
| GLD | 8.7% | −12.9% | 0.45 | 66% |
| MSFT | 9.6% | −16.6% | 0.40 | 58% |
| MSTR | 13.5% | −47.4% | 0.22 | 80% |
| NFLX | 11.5% | −39.7% | 0.22 | 63% |
| ORCL | 7.4% | −32.9% | 0.14 | 75% |
| SOFI | 4.3% | −47.6% | 0.01 | 90% |
| XLE | 10.7% | −48.1% | 0.16 | 70% |

**Results on the 22 development tickers.** A positive change in Max drawdown means a shallower drawdown. "Up to" is Kelly's most below the 200-day average; "tops only" means a most of 1.

| Version | Better / same / worse | Better and above the floor | Below the floor | Max drawdown shallower / deeper | CAGR up / down | Excess Calmar, median change | CAGR, median change (pts) | Max drawdown, median change (pts) | Cash utilization vs base |
|---|---|---|---|---|---|---|---|---|---|
| Guard, market's share; 0 when the stock falls alone | 6 / 7 / 9 | 3 of 22 | 4 | 10 / 1 (p 0.01) | 7 / 10 | 0.000 | 0.0 | +0.1 | 97% |
| Guard, market's share; 0.5 when the stock falls alone | 6 / 8 / 8 | 4 of 22 | 2 | 10 / 2 (p 0.04) | 8 / 8 | 0.000 | 0.0 | +0.1 | 96% |
| Guard, market's share + IV peak; 0 when alone | 8 / 6 / 8 | 6 of 22 | 3 | 9 / 4 (p 0.27) | 9 / 10 | 0.000 | 0.0 | 0.0 | 96% |
| Kelly tops only, cut z 0.5→1.5, cash waits | 11 / 1 / 10 | 8 of 22 | 4 | 14 / 2 (p <0.01) | 9 / 12 | +0.005 | −0.2 | +1.0 | 88% |
| Kelly tops only, cut z 0.5→1.5, deeper Puts | 9 / 1 / 12 | 7 of 22 | 2 | 14 / 4 (p 0.03) | 6 / 16 | −0.040 | −1.5 | +1.4 | 98% |
| Kelly tops only, cut z 1.0→2.0, cash waits | 9 / 3 / 10 | 9 of 22 | 0 | 8 / 2 (p 0.11) | 7 / 13 | −0.001 | −0.3 | 0.0 | 97% |
| Kelly tops only, cut z 1.0→2.0, deeper Puts | 8 / 2 / 12 | 7 of 22 | 1 | 7 / 3 (p 0.34) | 7 / 13 | −0.007 | −0.5 | 0.0 | 99% |
| Kelly cut z 0.5→1.5, up to ×1.5, cash waits | 11 / 2 / 9 | 8 of 22 | 3 | 12 / 9 (p 0.66) | 9 / 12 | +0.009 | −0.7 | +0.8 | 93% |
| Kelly cut z 0.5→1.5, up to ×1.5, deeper Puts | 9 / 1 / 12 | 9 of 22 | 1 | 10 / 9 (p 1.00) | 6 / 16 | −0.026 | −1.7 | +0.2 | 103% |
| Kelly cut z 0.5→1.5, up to ×2, cash waits | 9 / 2 / 11 | 7 of 22 | 2 | 5 / 14 (p 0.06) | 8 / 14 | −0.011 | −0.6 | −3.8 | 98% |
| Kelly cut z 0.5→1.5, up to ×2, deeper Puts | 7 / 1 / 14 | 7 of 22 | 0 | 5 / 14 (p 0.06) | 8 / 14 | −0.028 | −1.7 | −4.0 | 109% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits | 11 / 2 / 9 | 11 of 22 | 0 | 7 / 10 (p 0.63) | 12 / 9 | +0.007 | +0.4 | −0.1 | 99% |
| Kelly cut z 1.0→2.0, up to ×1.5, deeper Puts | 10 / 1 / 11 | 9 of 22 | 1 | 8 / 10 (p 0.81) | 11 / 10 | −0.006 | 0.0 | −0.3 | 102% |
| Kelly cut z 1.0→2.0, up to ×2, cash waits | 7 / 1 / 14 | 7 of 22 | 0 | 1 / 16 (p <0.01) | 11 / 10 | −0.020 | +0.1 | −5.1 | 106% |
| Kelly cut z 1.0→2.0, up to ×2, deeper Puts | 9 / 1 / 12 | 9 of 22 | 0 | 2 / 15 (p <0.01) | 11 / 10 | −0.014 | +0.1 | −4.8 | 107% |
| Constant ×1, pool only (control) | 6 / 9 / 7 | 6 of 22 | 0 | 5 / 2 (p 0.45) | 6 / 8 | 0.000 | 0.0 | +0.0 | 100% |
| Constant ×0.75 (control) | 12 / 2 / 8 | 2 of 22 | 17 | 21 / 0 (p <0.01) | 4 / 17 | +0.015 | −1.7 | +8.2 | 75% |
| Constant ×0.5 (control) | 13 / 2 / 7 | 0 of 22 | 21 | 21 / 1 (p <0.01) | 3 / 19 | +0.057 | −3.8 | +16.4 | 50% |
| Kelly cut z 0.5→1.5, up to ×1.5, cash waits + guard | 11 / 3 / 8 | 6 of 22 | 9 | 16 / 4 (p 0.01) | 8 / 12 | +0.006 | −0.9 | +3.5 | 85% |
| Kelly cut z 0.5→1.5, up to ×1.5, deeper Puts + guard | 9 / 1 / 12 | 7 of 22 | 5 | 14 / 4 (p 0.03) | 6 / 15 | −0.028 | −2.3 | +1.6 | 92% |
| Kelly cut z 0.5→1.5, up to ×2, cash waits + guard | 8 / 4 / 10 | 3 of 22 | 9 | 12 / 8 (p 0.50) | 7 / 15 | −0.003 | −1.3 | +0.9 | 87% |
| Kelly cut z 0.5→1.5, up to ×2, deeper Puts + guard | 6 / 3 / 13 | 5 of 22 | 3 | 11 / 9 (p 0.82) | 7 / 15 | −0.009 | −1.8 | +0.8 | 94% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits + guard | 9 / 3 / 10 | 6 of 22 | 6 | 12 / 6 (p 0.24) | 10 / 11 | −0.003 | 0.0 | +1.0 | 93% |
| Kelly cut z 1.0→2.0, up to ×1.5, deeper Puts + guard | 9 / 2 / 11 | 6 of 22 | 4 | 11 / 7 (p 0.48) | 9 / 12 | −0.003 | −0.3 | +0.3 | 97% |
| Kelly cut z 1.0→2.0, up to ×2, cash waits + guard | 8 / 2 / 12 | 5 of 22 | 5 | 9 / 10 (p 1.00) | 9 / 13 | −0.011 | −0.3 | −0.1 | 98% |
| Kelly cut z 1.0→2.0, up to ×2, deeper Puts + guard | 6 / 0 / 16 | 4 of 22 | 3 | 8 / 9 (p 1.00) | 7 / 15 | −0.021 | −0.8 | −0.2 | 99% |
| Kelly cut z 0.5→1.5, up to ×1.5, cash waits + guard + SPY's month | 9 / 0 / 13 | 4 of 22 | 11 | 15 / 7 (p 0.13) | 7 / 15 | −0.013 | −2.3 | +2.5 | 80% |
| Kelly cut z 0.5→1.5, up to ×1.5, deeper Puts + guard + SPY's month | 9 / 0 / 13 | 4 of 22 | 8 | 17 / 4 (p <0.01) | 6 / 15 | −0.018 | −2.5 | +5.1 | 83% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits + guard at 0.5 | 9 / 3 / 10 | 7 of 22 | 3 | 8 / 9 (p 1.00) | 11 / 11 | +0.001 | −0.8 | 0.0 | 98% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits + guard with IV | 11 / 1 / 10 | 8 of 22 | 6 | 13 / 4 (p 0.05) | 11 / 11 | +0.010 | −0.1 | +1.2 | 92% |

**Hold-out** (7 tickers):

| Version | Better / same / worse | Better and above the floor | Below the floor | Max drawdown shallower / deeper | CAGR up / down | Excess Calmar, median change | CAGR, median change (pts) | Max drawdown, median change (pts) | Cash utilization vs base |
|---|---|---|---|---|---|---|---|---|---|
| Guard, market's share + IV peak; 0 when alone | 1 / 2 / 4 | 0 of 7 | 1 | 2 / 2 (p 1.00) | 1 / 4 | −0.030 | −1.8 | 0.0 | 99% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits | 1 / 0 / 6 | 1 of 7 | 0 | 1 / 6 (p 0.12) | 2 / 4 | −0.019 | −0.8 | −5.7 | 107% |
| Kelly cut z 1.0→2.0, up to ×1.5, cash waits + guard with IV | 4 / 1 / 2 | 3 of 7 | 1 | 4 / 3 (p 1.00) | 5 / 2 | +0.011 | +1.3 | +0.8 | 98% |

**What the results say**
- **No version passes.** The best is 11 of 22 (Kelly, cut z 1→2, up to ×1.5, cash waits). The guard alone reached 6, both together 8.
- **That version failed the hold-out:** 1 better, 6 worse, with Max drawdown deeper on 6 (NFLX −39.7% → −50.9%, MSTR −47.4% → −56.7%, SOFI −47.6% → −56.0%).
- **Buying more below the 200-day average deepens drawdowns.** Up to ×2 made Max drawdown deeper on 14 to 16 of 22, and Excess Calmar worse on 12 to 13 in 2020–22. Even ×1.5 took PTON from −79.6% to −89.2% and INTC from −46.6% to −58.7%.
- **Cutting at tops makes drawdowns shallower but sits out rallies.** Tops only, cut from z 0.5: Max drawdown shallower on 14 and deeper on 2, while CAGR rose on 9 and fell on 12 (MU 27.2% → 15.0%, ASTS 27.7% → 17.4%, NOK 17.6% → 12.1%).
- **The guard alone makes Max drawdown shallower without raising Excess Calmar.**
  - Strict guard: Max drawdown shallower on 10 and deeper on 1 (p 0.01), but Excess Calmar better on 6 and worse on 9.
  - Its wins are stocks falling alone (PTON −79.6% → −51.7%, SMCI −57.6% → −40.6%); its losses are solo recoveries (IREN 1.11 → 0.76).
  - It changed no order on SPY, QQQ, IWM, SMH or AAPL.
  - On the hold-out it was better on 1 and worse on 4.
- **The guard as a brake on Kelly's bottom buying** (Part 3's best: Kelly cut z 1→2, ×1.5, with the guard and IV).
  - Development tickers: 11 better, 10 worse, with Max drawdown shallower on 13 and deeper on 4 (p 0.05).
  - Hold-out: 4 better, 2 worse, the only version that held up. Against Kelly alone it took NFLX's Max drawdown from −50.9% to −36.5%, but NFLX's CAGR was 8.7% with or without the guard (11.5% at today's sizes).
  - Over all 29 tickers: 15 better, 12 worse (p 0.70).
- **The constant controls.**
  - ×0.5 made Excess Calmar better on 13 and worse on 7, with Max drawdown shallower on 21, but CAGR fell on 19 and it used half the cash.
  - ×0.5 also lowered average cost ÷ average price on 20 of 22, more than any timing rule, so "buys cheaper" mostly reflects buying less at the entry.
  - ×1 (the pool alone) changed 17 tickers' results for no gain.
- **Deeper Puts at tops** kept cash working, but in all 11 pairs with cash waiting they had CAGR up on no more tickers, and on fewer in 7.
- **SPY's month (F4) hurt.** It left up to 11 tickers below the floor. With deeper Puts it made the strongest drawdown cut (17 shallower, 4 deeper, 5.1 points at the median), but CAGR fell on 15.
- **LLM pilot.** Claude judged 264 drawdown days from anonymised facts. Within each ticker, its fall probability scored AUC 0.467, against 0.627 for the guard's signal. No LLM mode was built.

**Recommendation (2026-10-21, in the report):**
- Keep both switches off. Nothing goes to Pluto.
- Kelly isn't the fix: buying more below the average is the weak spot itself.
- If one line stays open, it is Part 3's best: a lean, not a result.
- Next: act on held shares (I-02, I-01).

**Decision (Marcelo 2026-10-21):** remove both switches. The code is archived in API commit 1bdc501 and app commit 56399f9; reverting b1a9711 and 53b0847 restores it. The research sessions were deleted from the local database; the saved results stay in `tmp/kelly-research/out/` and `out_holdout/`.

## Round 6: entry filters, backtested (2026-10-20)

Report: [Ladder Entry Filters](https://claude.ai/artifact/L1Pta1QdjoFN53vTAbUpWs). Scripts: `tmp/drop-filter-research/` (`make_specs_phase2.py`, `make_specs_holdout.py`, `collect_phase2.py`, `score_phase2.py`, `run_diagnostics.py`, `build_report2.py`). Runs: `out_phase2/`, `out_holdout/`.

**What was built.** The lab has an Entry filters group (`src/backtest/engine/entryDropRiskFilters.ts`) with two switches. Both are off by default.
- **F1, extension.** No new entry while z ≥ the limit (default 1).
  - z = (previous close ÷ 200-day average − 1) ÷ 63-session volatility, where volatility is the annualised standard deviation of daily log returns.
  - Example, MRNA on 2021-09-20: $430.05 against a 200-day average of $214.48 is 100.5% above it. With 81.2% volatility, z = 1.005 ÷ 0.812 = 1.24, so no new entry. MRNA fell 47% within 63 sessions.
- **F2, IV Rank.** No new entry while IV Rank ≥ the limit (default 80).
  - IV Rank = (IV − the year's lowest) ÷ (the year's highest − lowest) × 100, over the last 252 days with an IBKR implied volatility, as on Price Performance.
  - Example: an IV of 60% in a year that ranged from 40% to 65% gives (60 − 40) ÷ (65 − 40) × 100 = 80, so no new entry.
  - "F2" in the results means both switches on: either one blocks.
- **What the filters stop.** Only new entries: a Cash-Secured Put entry, or a Covered Call entry's share purchase, including entries inside the ladder's shares budget while shares are held. Calls on held shares and ladder Puts carry on, and the waiting cash earns T-bill interest.

**Results on the 22 development tickers.** 308 runs. A positive change in Max drawdown means a shallower drawdown.

| Filter | Entry | Better / same / worse | Excess Calmar, median change | CAGR, median change (pts) | Max drawdown, median change (pts) | Cash utilization vs base | Below the floor | Better and above the floor | Days held back (median) |
|---|---|---|---|---|---|---|---|---|---|
| z ≥ 0.75 | CSP | 11 / 2 / 9 | 0.00 | −0.2 | +0.2 | 90% | 5 | 8 of 22 | 13% |
| | CC | 4 / 3 / 15 | −0.05 | −1.8 | 0.0 | 90% | 5 | 2 of 22 | 13% |
| z ≥ 1 (F1) | CSP | 8 / 5 / 9 | 0.00 | 0.0 | 0.0 | 98% | 1 | 7 of 22 | 7% |
| | CC | 7 / 4 / 11 | −0.01 | −0.2 | 0.0 | 97% | 1 | 6 of 22 | 7% |
| z ≥ 1.5 | CSP | 6 / 10 / 6 | 0.00 | 0.0 | 0.0 | 100% | 1 | 5 of 22 | 2% |
| | CC | 6 / 10 / 6 | 0.00 | 0.0 | 0.0 | 100% | 0 | 6 of 22 | 2% |
| z ≥ 1 or IV Rank ≥ 70 | CSP | 9 / 2 / 11 | 0.00 | 0.0 | 0.0 | 94% | 1 | 8 of 22 | 11% |
| | CC | 11 / 3 / 8 | +0.01 | +0.1 | 0.0 | 94% | 2 | 9 of 22 | 16% |
| z ≥ 1 or IV Rank ≥ 80 (F2) | CSP | 8 / 4 / 10 | 0.00 | −0.1 | 0.0 | 95% | 1 | 7 of 22 | 9% |
| | CC | 12 / 2 / 8 | +0.01 | +0.1 | 0.0 | 95% | 2 | 10 of 22 | 13% |
| z ≥ 1 or IV Rank ≥ 90 | CSP | 8 / 4 / 10 | 0.00 | 0.0 | 0.0 | 97% | 1 | 7 of 22 | 8% |
| | CC | 11 / 1 / 10 | 0.00 | +0.1 | 0.0 | 97% | 1 | 10 of 22 | 11% |
| IV Rank ≥ 80 alone | CSP | 6 / 8 / 8 | 0.00 | 0.0 | 0.0 | 100% | 0 | 6 of 22 | 1% |
| | CC | 11 / 7 / 4 | 0.00 | 0.0 | 0.0 | 100% | 1 | 10 of 22 | 5% |

"Days held back" counts days on which a filter stopped an entry that had room under the budget. Some of those days would have found nothing to sell anyway, so it is an upper bound.

**What the results say**
- **No filter passes.** The best is 10 of 22 better and above the floor, on Covered Call entries. Across both entries, F2 and the IV Rank 70 and 90 versions tie for best at 17 of 44.
- **Better against worse is a coin toss.**
  - F1 was better on 15 runs and worse on 20 (p = 0.50).
  - F2 was better on 20 and worse on 18 (p = 0.87).
  - The one clear result is negative: z ≥ 0.75 made Covered Call entry runs worse on 15 of 22 tickers (p = 0.02) and left 10 of 44 runs below the floor.
- **The filters make Max drawdown a little shallower.**
  - With F2, Max drawdown was shallower by more than half a point on 15 runs (2.3 points at the median) and deeper on 3 (p = 0.008). The other 26 didn't move.
  - z ≥ 1 or IV Rank ≥ 90 did the same: 14 shallower against 4 deeper (p = 0.03).
- **Why an entry filter can't stop most of the damage.** At the peak before its deepest drawdown, the median base run already had 43% of the account committed, and the ladder keeps buying on the way down. Once the price breaks, it nears its 200-day average while volatility jumps, so z drops below 1 within days. Over a fall (a median of 185 sessions from peak to trough), F2 held entries back on only 4.7% of sessions.
- **The cost is the rallies.** A stock that keeps rising stays stretched for months, and the filter sits out the climb. Across the 44 runs, CAGR rose on 19 and fell on 21.
- **Single results are noisy.** Even z ≥ 1.5, which rarely fires, moved Excess Calmar by more than 0.05 on 8 of 44 runs. One skipped entry shifts every later Put, assignment and Call. Judge a rule by the counts across tickers, not by any one ticker's change.

**Per ticker: Excess Calmar of the base run, and its change with F1 and F2**

| Ticker | CSP base | CSP F1 | CSP F2 | CC base | CC F1 | CC F2 |
|---|---|---|---|---|---|---|
| AAOI | 0.37 | +0.02 | +0.03 | 0.45 | −0.03 | −0.05 |
| AAPL | 0.59 | +0.07 | +0.14 | 0.70 | +0.10 | +0.04 |
| ALAB | 0.55 | +0.35 | +0.49 | 0.80 | −0.04 | +0.07 |
| ASTS | 0.69 | −0.03 | −0.16 | 0.26 | +0.11 | +0.11 |
| BMNR | −0.32 | 0.00 | 0.00 | 0.04 | 0.00 | +0.01 |
| CRWV | 0.08 | 0.00 | +0.01 | −0.14 | 0.00 | +0.04 |
| DOCN | 0.10 | +0.02 | 0.00 | 0.17 | 0.00 | −0.04 |
| GSAT | 0.16 | 0.00 | 0.00 | 0.12 | 0.00 | 0.00 |
| HOOD | 0.09 | −0.03 | −0.03 | 0.24 | −0.08 | −0.07 |
| INTC | 0.10 | −0.04 | −0.01 | 0.07 | −0.01 | +0.03 |
| IREN | 1.22 | +0.19 | +0.31 | 0.98 | −0.11 | −0.12 |
| IWM | 0.22 | −0.04 | −0.03 | 0.20 | −0.02 | 0.00 |
| MRNA | 0.12 | −0.03 | −0.03 | 0.24 | +0.02 | +0.04 |
| MU | 0.77 | −0.38 | −0.51 | 0.78 | −0.27 | −0.34 |
| NOK | 0.20 | −0.04 | −0.06 | 0.44 | −0.03 | −0.05 |
| PTON | −0.15 | +0.02 | +0.05 | −0.09 | +0.07 | +0.02 |
| QQQ | 0.35 | +0.05 | +0.07 | 0.39 | +0.09 | +0.10 |
| SMCI | 0.26 | −0.14 | −0.12 | 0.32 | −0.15 | −0.04 |
| SMH | 0.63 | −0.06 | −0.05 | 0.58 | −0.15 | −0.16 |
| SPY | 0.23 | +0.10 | +0.10 | 0.28 | +0.12 | +0.11 |
| TECH | 0.44 | 0.00 | −0.05 | −0.04 | −0.01 | +0.07 |
| TLT | −0.20 | 0.00 | 0.00 | −0.21 | +0.01 | +0.01 |

**Hold-out** (BE, COIN, CSCO, NBIS, PLTR, WDC). F1 and F2 ran on both entries against baselines run the same way, 12 runs each:
- F1 was better on 3 runs and worse on 7; F2 better on 3 and worse on 8.
- F2 again made Max drawdown shallower (0.6 points at the median) and again cost CAGR where the stock kept climbing.

F2 on the hold-out, CAGR / Max drawdown / Excess Calmar, base → F2:

| Ticker | Cash-Secured Put entry | Covered Call entry |
|---|---|---|
| BE | 12.0% → 10.7% / −17.5% → −17.5% / 0.52 → 0.44 | 21.0% → 17.3% / −24.3% → −22.1% / 0.75 → 0.65 |
| COIN | 3.8% → 4.6% / −50.4% → −50.4% / 0.01 → 0.02 | 4.8% → 5.2% / −50.2% → −50.2% / 0.03 → 0.03 |
| CSCO | 8.8% → 8.7% / −15.8% → −17.8% / 0.37 → 0.33 | 8.0% → 7.5% / −19.3% → −18.2% / 0.26 → 0.25 |
| NBIS | 46.1% → 42.4% / −17.6% → −17.1% / 2.39 → 2.25 | 54.2% → 56.2% / −25.4% → −28.2% / 1.98 → 1.85 |
| PLTR | 10.8% → 8.7% / −44.4% → −31.5% / 0.17 → 0.17 | 16.2% → 16.3% / −38.0% → −34.3% / 0.34 → 0.38 |
| WDC | 19.5% → 3.5% / −19.9% → −15.8% / 0.78 → −0.03 | 73.6% → 3.6% / −18.8% → −18.1% / 3.70 → −0.02 |

**Recommendation (2026-10-20, in the report):** leave both filters off. They stay in the lab as switches for later tests, and nothing goes to Pluto.

### What the final figures hide, ticker by ticker

A run is *stuck* while shares are held with no Call and no Put working. A stuck position earns nothing, and the free cash earns only T-bill interest. Prices below are as traded on the day.

- **PTON: the clearest stuck case.**
  - Cash-Secured Put entry: the base run's shares, first assigned on 29 January 2021, cost $118.33 on average. PTON then fell far below the ladder's floor of $62.67. The account sat on 900 shares with no Call and no Put for the last 1,230 sessions of the run, nearly five years.
  - F2 held entries back through the 2020 run-up (79 sessions from 21 July 2020), so its shares came later and cheaper. CAGR went from −6.2% to −1.6% and Max drawdown from −61.4% to −48.2%, but it was still stuck for 1,211 sessions.
  - Covered Call entry: 1,500 shares at an average $124.10 sat stuck for 1,226 sessions while PTON fell from $43.84 to $5.33.
  - PTON's cash utilization above 100% is the shares-at-cost effect described under "How a change is judged".
- **MRNA: the filter acted at the top, then let go.**
  - It held entries back on 66 sessions from 25 June 2021. When the price broke, z dropped below 1 within days: on 29 September F2 sold a $380 Put with MRNA at $394, two days after the base run's $400 Put with MRNA at $416.
  - Both were assigned on 1 October, and in both runs the ladder then bought on the way down until its reserve was used up.
  - MRNA fell 94% from the peak (Cash-Secured Put entry run).
- **HOOD: stuck before the filter mattered.** On the Covered Call entry run, the base run held shares at an average $26.41 with no option working for 265 sessions (February 2023 to February 2024), while the price sat between $10 and $15. F2 later held entries back on 259 sessions as HOOD climbed through 2024–25, and CAGR fell from 12.4% to 9.8%.
- **TECH: almost never invested.**
  - Cash-Secured Put entry: TECH's Puts rarely pass the volume and quote rules, so cash utilization is 5% and the base run sat all in cash for 1,072 sessions.
  - Covered Call entry: the base run caught one entry on 5 October 2021 and was then stuck for 779 sessions. F2 sat in cash for 886 sessions in a row.
- **MU: the filter's biggest cost on the development tickers.**
  - MU kept climbing (buy and hold: 50.7% a year), and a rising stock stays stretched. F2 held Cash-Secured Put entries back on 351 sessions, including three stretches of 65 to 70 sessions in a row between September 2025 and July 2026.
  - Puts assigned fell from 31 to 14 and premium from $280k to $103k. CAGR fell from 18.0% to 8.1%, while Max drawdown barely moved (−19.6% → −19.3%).
- **WDC (hold-out): the worst case.** Buy and hold returned 220% a year over its window. F2 held Covered Call entries back on 269 sessions in a row, from 14 July 2025 to 6 August 2026. Premium fell from $369k to $32k, and CAGR from 73.6% to 3.6%.
- **SPY: the filter working as designed.**
  - SPY was stretched in February 2020, and F2 held entries back from 5 to 21 February. The base run was assigned at $336.50 on 21 February, as the fall began.
  - F2's first Put after the pause was assigned at $321 on the 26th.
  - Max drawdown went from −18.2% to −13.3%, and CAGR from 7.0% to 7.2%.
- **SMCI: out of the climb.** F2 held Cash-Secured Put entries back on 206 sessions from April 2022. Premium fell from $518k to $273k and CAGR from 16.4% to 10.5%. Max drawdown didn't move, because the July 2024 fall hit a Put assigned on 19 July 2024 in both runs.
- **ALAB and IREN: timing luck, not drop avoidance.**
  - ALAB's Excess Calmar went from 0.55 to 1.04 with the same Max drawdown, because its later entries happened to do better.
  - IREN improved on Cash-Secured Put entries (1.22 → 1.53) and got worse on Covered Call entries (0.98 → 0.85), with about the same days held back.
- **INTC and MRNA: the only tickers where the ladder ran out of rungs.** Ladder Puts are never filtered, so the filters can't change that.
- **PLTR (hold-out): shallower drawdown, same Excess Calmar.** F2 took Max drawdown from −44.4% to −31.5%, but CAGR fell from 10.8% to 8.7%, so Excess Calmar stayed at 0.17. Cash utilization fell to 75% of the base run's, below the floor.

## Round 5: drop-risk filters, the evidence (2026-10-19)

Report: [Ladder Drop-Risk Filters](https://claude.ai/artifact/2zY1HC9GeuzGU6XvUhNb63). Scripts: `tmp/drop-filter-research/` (`make_specs_phase1.py`, `score_phase1.py`, `signals.ts`, `skew_study.ts`, `iv_metrics.ts`, `analyze_signals.ts`, `order_study.ts`, `order_analyze.ts`, `drawdown_anatomy.py`, `collect_results.py`, `build_report.py`). Runs: `out_phase1/`.

**The question:** can a rule stop the strategy taking on shares just before a big fall, without leaving it idle?
- A *big fall* is the stock closing 30% or more below the order day's 10:00 price within the next 63 sessions (about three months), or the ladder committing its whole reserve (95% or more).
- A fall within 21 sessions is the fast version.
- Every comparison is *within ticker*: a ticker's flagged days, or orders, are compared with that ticker's other days. This matters because volatile tickers fall more often whatever the signal says.
- Intervals come from 400 resamples of whole calendar months, because falls cluster: the 29,028 ticker-days hold only about 192 distinct 30% falls.

**Test 1: the lab's existing features, each switched on alone** (44 base runs, 262 feature runs):

| Feature | Entry | Better / same / worse | Excess Calmar, median change | Max drawdown, median change (pts) | Cash utilization vs base | Below the floor | Better and above the floor |
|---|---|---|---|---|---|---|---|
| Skip contracts spanning earnings | CSP | 2 / 14 / 6 | 0.00 | 0.0 | 100% | 1 | 1 |
| | CC | 4 / 12 / 6 | 0.00 | 0.0 | 100% | 1 | 4 |
| Volatility edge filter, IV at or above the forecast | CSP | 12 / 2 / 8 | +0.01 | +2.3 | 90% | 4 | 8 |
| | CC | 9 / 2 / 11 | 0.00 | +0.2 | 95% | 1 | 8 |
| Volatility edge filter, IV 5+ points above the forecast | CSP | 12 / 1 / 9 | +0.01 | +3.4 | 78% | 12 | 5 |
| | CC | 13 / 1 / 8 | +0.03 | +1.3 | 90% | 8 | 7 |
| Sell the shares after a 50% loss | CSP | 5 / 11 / 6 | 0.00 | 0.0 | 98% | 6 | 3 |
| | CC | 7 / 7 / 8 | 0.00 | 0.0 | 93% | 4 | 4 |
| Deeper ladder (shock 60–90%) | CSP | 4 / 11 / 7 | 0.00 | 0.0 | 100% | 1 | 3 |
| | CC | 6 / 8 / 8 | 0.00 | 0.0 | 100% | 2 | 5 |
| No minimum Call yield (35% → 0) | CSP | 7 / 3 / 10 | −0.01 | +0.1 | 100% | 0 | 7 |
| | CC | 6 / 8 / 8 | 0.00 | −0.1 | 101% | 0 | 6 |

- **None passes.** The closest is the volatility edge filter on Cash-Secured Put entry runs: 12 better, but only 8 of them above the floor.
  - It makes drawdowns shallower by selling less. At 5 points it left 12 of 22 Cash-Secured Put entry runs below the floor.
  - It isn't a drop warning either: days with implied volatility 10+ points above the forecast were followed by 30% falls about as often as other days (+0.1 points within ticker).
- **Skipping earnings changes few trades.** The median entry is a 4-day option, and 4% of entries were placed within 7 days of earnings.
- **The 50% share stop-loss swings tickers both ways,** from −0.68 (ALAB) to +0.33 (DOCN) on Cash-Secured Put entry runs.
- **Two "no minimum yield" runs failed at first** (QQQ and SPY, Cash-Secured Put entry). They hit a Call expiring on 9 January 2025, a market closure; the engine fix is described below. Re-run after the fix, QQQ made 9.1% CAGR (Max drawdown −18.1%) and SPY 6.9% (−18.2%).

**Test 2: signals before big falls, on every ticker-day.**
- Overall, 15.0% of days were followed by a 30% fall within 63 sessions, and 4.5% within 21.
- Each signal uses only what was known at the 10:00 look: daily bars up to the day before, plus the 10:00 price.

| Rule | Days blocked | Fall within 63 sessions: blocked vs allowed | Within ticker, 63 sessions (tickers higher / lower) | 2020–22 | 2023–26 | Within ticker, 21 sessions |
|---|---|---|---|---|---|---|
| Extension z ≥ 1 | 9.3% | 23.1% vs 14.2% | +13.2 (15/3) | +7.3 | +14.7 | +2.2 |
| Extension z ≥ 0.75 | 17.1% | 18.1% vs 14.4% | +8.5 (16/3) | +10.4 | +11.0 | +2.6 |
| Extension z ≥ 1.5 | 2.2% | 32.6% vs 14.6% | +16.3 (9/3) | +2.7 | +24.3 | +2.1 |
| Up 50%+ over 63 sessions | 9.6% | 35.6% vs 12.9% | +11.7 (9/4) | +10.4 | +12.7 | +3.3 |
| Momentum 12-1 doubled | 13.6% | 33.9% vs 12.1% | +11.4 (11/5) | 0.0 | +9.7 | +2.6 |
| IV Rank ≥ 80 | 5.9% | 20.5% vs 14.7% | +10.2 (8/6) | +10.1 | +5.7 | **+8.3 (13 of 14 tickers)** |
| IV %ile ≥ 90 | 13.8% | 17.7% vs 14.6% | +4.5 (10/7) | +3.9 | +3.0 | +4.0 |
| Implied volatility 10+ points above the forecast | 20.5% | 24.7% vs 12.5% | +0.1 (9/8) | −0.9 | +0.2 | +1.3 |
| Skew below 0 (Calls richer than Puts) | 10.7% | 31.3% vs 12.0% | +6.5 (8/3) | −1.1 | +7.7 | +0.7 |
| Price below its 200-day average | 41.3% | 14.9% vs 15.1% | −5.1 (3/16) | −8.5 | −6.1 | −1.7 |
| 50%+ below the 52-week high | 15.0% | 30.2% vs 12.3% | −4.4 (5/6) | −8.2 | −11.0 | −2.0 |
| SPY below its 200-day average | 21.0% | 9.5% vs 16.5% | −6.3 (1/17) | −5.2 | −12.2 | −1.3 |
| Earnings within 7 days | 9.4% | 20.1% vs 16.3% | +3.8 (7/2) | +4.4 | +2.4 | +3.2 |
| z ≥ 1 or IV Rank ≥ 80 | 14.4% | 21.2% vs 14.0% | +10.8 (16/2) | +11.4 | +9.4 | +4.6 (13/1) |

- **Run-ups come before falls; falls already under way don't predict more falls.** Extension, distance from the 52-week high and momentum all point the right way. On days when a fall was already under way (price below the 200-day average, down 20% in a month, 50% below the high), the same stock fell 30% less often. The same holds on days when SPY was weak, and with a steep Put skew (Pluto's skew: highest fifth minus lowest −6.8 points).
- **IV Rank against IV %ile.** Both come from IBKR's daily implied volatility over the last 252 days.
  - IV Rank places today in the year's range. With a low of 40% and a high of 140%, an IV of 120% is Rank 80. IV %ile counts the days below today's.
  - A modest rise in a calm year already reads 90+ on the %ile, while Rank needs IV near the top of the year's whole range. That is the stress that comes before fast falls.
  - On MRNA's top on 2021-09-20 IV Rank was only 14, because the 2020 spikes set the year's range. That is why the two signals complement each other.
- **Momentum 12-1 wasn't proposed.** It catches some tops extension misses (BMNR, GSAT, IREN), but showed no effect in 2020–22. It would also keep boom tickers out for a year or more: its longest blocked stretches were MRNA 392 sessions, SMCI 321 and ASTS 276.
- **Skew below 0 wasn't proposed.** It points the right way, but it can't be computed on most days for thin chains (GSAT, NOK, TECH).

**Test 3: order by order (5,155 entry orders and ladder Puts from the base runs).** The Signals model's fields were recomputed for each contract at its look (Grade, Edge $/10K, Edge Yield, Hist Yield, PoP, Worst 5%/10K):
- **The model's fields point the wrong way or nowhere.** The entry Puts the model rated best were followed by 30% falls as often as the ones it rated worst, or slightly more often.
  - Worst 5% worse than −$1,500 per $10K would have blocked 47% of entry Puts. Pooled, those fell more often (35% against 11%), but only because a big tail marks the volatile tickers. Within each ticker they fell 8.6 points *less* often.
  - Grade below good would have blocked 55%, which fell 4.1 points less often within ticker.
  - The model measures how rich an option is for the volatility it forecasts, symmetric around today's price. It has no view on whether a run-up will reverse.
- **Extension points the right way on orders too.** z ≥ 1 would have blocked 24% of entry Puts, which were followed by a 30% fall 10.0 points more often within ticker. IV Rank ≥ 80 blocks only 5% of entry Puts, too few to judge per ticker (6 tickers more, 5 less).
- **Ladder Puts behave the opposite way.** A ladder Put is sold after the stock has already fallen below cost, and there high implied volatility marks capitulation.

| Rule, on ladder Puts | Entry | Ladder Puts blocked | 30% fall after: blocked vs allowed | Within ticker (more / less) | Held to expiry: blocked vs allowed | Ladder used up within 63 sessions: blocked vs allowed |
|---|---|---|---|---|---|---|
| Price below its 200-day average | CSP | 70.2% | 11.7% vs 11.7% | −3.2 (5/7) | 0.9% vs 0.5% | 1.6% vs 0.0% |
| | CC | 68.3% | 12.8% vs 12.0% | 0.0 (5/7) | 0.7% vs 1.2% | 7.4% vs 0.9% |
| IV Rank ≥ 50 | CSP | 34.3% | 3.8% vs 16.0% | −8.6 (2/8) | 1.2% vs 0.3% | 0.5% vs 1.3% |
| | CC | 32.1% | 6.8% vs 15.3% | −4.1 (4/7) | 1.4% vs 0.6% | 2.6% vs 6.2% |
| IV Rank ≥ 80 | CSP | 12.4% | 4.6% vs 12.7% | −1.4 (1/4) | 1.4% vs 0.5% | 0.0% vs 1.2% |
| | CC | 9.3% | 4.5% vs 13.4% | −7.7 (2/6) | 1.6% vs 0.8% | 1.5% vs 5.4% |

- **Reading the ladder table.** "Held to expiry" is the option's own profit per dollar of collateral, not what the assigned shares did later.
  - Ladder Puts sold at IV Rank ≥ 50 were followed by fewer falls, and earned more on 11 of 12 tickers (CSP entry runs).
  - Ladder Puts sold below the 200-day average, about 70% of them, were followed by falls no more often than the rest. But nearly all the cases where the ladder ran out of rungs followed them.
  - No rule reliably predicted further falls once the stock was below cost.

**Test 4: where the worst drawdowns came from.**
- **Most of the time is spent holding shares.** The strategy holds shares on 60–100% of days in most runs, so an entry filter changes when a cycle starts, not how a held position is managed.
- **Flagged entries before the peak.** In 21 of the 43 runs with entries in the 63 sessions before the peak, at least one entry had z ≥ 1 or IV Rank ≥ 80.
  - MRNA is the clearest case. The strategy sold Puts at $400–405 on 20 and 27 September 2021 with z ≥ 1, and the −70% drawdown followed as MRNA fell 94%.
  - On AAOI, ALAB, ASTS, DOCN, GSAT, HOOD, INTC, IWM and TLT, no flagged entry came before the drawdown on either entry. Those stocks weren't stretched when the shares were taken on, so no entry filter would have avoided them.
- **Deepest base-run drawdowns:**

| Run | Max drawdown | Peak → trough | Stock's fall | Put assignments in the fall |
|---|---|---|---|---|
| MRNA CC | −76.4% | 2021-09-23 → 2025-11-21 | −95% | 10, $328,300 |
| PTON CC | −70.8% | 2021-01-14 → 2024-04-25 | −98% | 4, $73,200 |
| MRNA CSP | −69.7% | 2021-09-27 → 2025-11-21 | −94% | 9, $323,650 |
| PTON CSP | −61.4% | 2021-02-16 → 2022-10-03 | −95% | 5, $44,500 |
| SMCI CC | −56.2% | 2024-03-08 → 2024-11-14 | −85% | 2, $79,000 |
| SMCI CSP | −50.7% | 2024-07-15 → 2024-11-14 | −80% | 3, $408,000 |
| GSAT CC | −42.0% | 2021-09-09 → 2022-01-24 | −65% | 0 |
| AAOI CC | −41.9% | 2020-08-07 → 2023-05-05 | −90% | 5, $13,650 |

**Running out of rungs.** A look "used up" the ladder when its Puts left 95% or more of the reserve committed. This happened in 4 of 44 base runs, all on INTC and MRNA: MRNA CC (14 looks), INTC CC (6), INTC CSP (2) and MRNA CSP (2).
- These were long, deep declines: MRNA fell from $468 in August 2021 to $23 in November 2025, and INTC from $68 in April 2021 to $25 in October 2022.
- On every other ticker the shock-from-history floor kept rungs in reserve.
- The usual damage is the drawdown on shares taken on before a fall.

## Rounds 1–4 (2026-10-13 to 2026-10-16)

Short summaries. The links hold the details.

1. **Round 1: tuning Pluto's settings.** 21 runs on AAOI, GSAT, HOOD and INTC over 2022–23 gained nothing reliable ([report](https://claude.ai/artifact/FefJpV6XYNSsgKc5RhtWsR)).
2. **Round 2: a naive wheel as the baseline (2026-10-13)** ([Wheel Research Log](https://claude.ai/artifact/7obX1ikB3NYtRQYDJWPn5d)).
   - Against a static mix of the same stocks and T-bills with the same exposure, the plain wheel showed no edge. It behaves as a small stock exposure plus T-bills, and AAOI carried the portfolios.
   - These did not improve it on AAOI, HOOD, INTC, NOK and SMCI:
     - selling only when IV beats the 21-day forecast;
     - ranking by Edge Yield;
     - writing fewer Calls (this adds exposure, not edge);
     - longer forecast windows.
   - Skipping sales that span earnings was the only rule pointing the right way. On the ladder it later changed few trades (Round 5).
3. **Round 3a: Sortino Strategy Lab (2026-10-13 and 14)** ([Sortino Strategy Lab](https://claude.ai/artifact/5FYvVqGanjagwHpEgmhn8Q)). The search was for strategies close to buy and hold (CAGR within 2 points a year) with a clearly better Sortino (+0.2). Nothing viable was found.
   - 12-month momentum and stepping out around earnings looked close on six symbols, then failed the hold-out (2–3 of 17).
   - Volatility-managed exposure, an SPY trend filter, report persistence and post-report drift failed on 23 symbols. Timing missed the V-shaped rebounds of 2020, 2023 and 2025.
   - Protection was dear: on these symbols Puts paid back less than they cost.
   - T-bills plus 2-year Calls rolled yearly cleared the bar on INTC only.
4. **Round 3b: Covered Calls on Marcelo's rules, INTC (2026-10-13)** ([INTC Calls and Puts](https://claude.ai/artifact/58ujBff8VCQsrDWgsHvjXZ)). 75 combinations from $200k, 2020 to October 2026.
   - Best +62.9% (its neighbours +34–49%), median +39%, the old rules +28%, buy and hold +74%.
   - 56 of 75 runs had 3+ years with no premium. Assigned Puts turn the cash into shares in a fall, and then nothing can be sold until the price recovers. This is the same stuck-shares problem Round 6 found on PTON and HOOD.
5. **Round 4: CC + Put Ladder, version 4 (2026-10-14)** ([Covered Calls with a Put Ladder](https://claude.ai/artifact/EZKJYsqzUU8Edi1rDGQz47)).
   - Setup: 10 stocks, with the ladder at 30%, 50% and 70% of the pot in shares; shock = the deepest fall in the prior 10 years, kept within 60–80%; 5 rungs.

     | Share level | Median CAGR | Median Max drawdown |
     |---|---|---|
     | 30% in shares | 9.4% | −17% |
     | 50% in shares | 12.7% | −28% |
     | 70% in shares | 14.5% | −40% |
     | Buy and hold | 15.9% | −67% |

   - The 80% shock cap deepened HOOD's Max drawdown at 30% shares to −54%, against −30% with a 90% cap.
   - TECH and GSAT had options open on under a quarter of days.
6. **Reference set since 2026-10-16.** Ladder comparisons use the C30/P30 delta-grid runs in `tmp/ladder-research/out_baseline_3020323/`: 19 tickers, $200k, Calls and Puts at \|delta\| ≤ 0.30, engine 3020323.
   - The engine changed on 2026-10-15: the ladder floor now comes from the shares' average cost, the forward is anchored at the first look, and the stock fill has no extra cent.
   - Runs before that change had about 35% more Puts, and a 0.4–0.9 point higher median CAGR, on identical settings.

## Data and engine issues found along the way

- **An expiry on a day the market was closed.** On 9 January 2025 the market closed for a national day of mourning, and OCC settled that day's options on the 8 January close. The engine first stopped the session there. It now settles such a contract at the close of the session before, as OCC did (on staging since 2026-10-20).
- **Another security's options under a ticker.** META's option file held another security's options from July 2021 to January 2022: a Metaverse ETF had the ticker, and Facebook traded as FB until 2022-06-09. The split check read the mismatch as eight splits (9-for-10, 14-for-15, …).
  - The check now treats a change of scale that is no standard split as the options before it belonging to another security, or being wrong.
  - Sessions over those days fail and name the date.
  - META's file was re-downloaded from 2022-06-09.
  - Code: `src/backtest/engine/splitFactors.ts`.
- **Reading cycles in session results.** Cycles and position legs are on the price scale of the day the cycle opened. Convert them with the session's `detectedSplits` before comparing across a split (the TECH open cycle in Round 6 needed this).
- **Earnings history before late 2025, from SEC filings.** Round 9 left MSFT, MSTR, NFLX and ORCL out for lack of earnings history.
  - Their history now comes from SEC EDGAR, together with BAC, CVNA, GOOG, GOOGL, IONQ, NOW, RKLB, SOFI, WMT, AMZN, AVGO and META.
  - Each report date is the acceptance time of the 8-K with item 2.02, converted from UTC to New York time. Where no such 8-K was filed, the 10-Q or 10-K is used (MSTR 2019–2023).
  - Next dates come from TradingView.
  - Loaded into the local database only (2026-10-22), with `tmp/edge-margin-audit/fetch_sec_earnings.py`, `backfill_earnings.ts` and `capture_next_earnings.ts`.
