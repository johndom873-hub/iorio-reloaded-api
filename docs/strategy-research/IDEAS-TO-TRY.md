# CC + Put Ladder: ideas to try

The backlog of changes worth testing on the CC + Put Ladder, drawn from our backtests and the literature review. Nothing here is approved or built unless its status says so.

Related files:
- [BACKTEST-FINDINGS.md](BACKTEST-FINDINGS.md): what our backtests found.
- [LITERATURE-REVIEW.md](LITERATURE-REVIEW.md): the evidence behind each idea, by section.

**How to keep this file current.** When an idea is tested, change its status here. Add the result as a new round in BACKTEST-FINDINGS.md, and add a short entry to PROGRESS.md.

## Plain-language summary

- **Our two big problems:**
  - Shares stuck after a collapse earn nothing for years. PTON sat on its shares with no Call and no Put for 1,230 sessions.
  - The ladder keeps buying all the way down a long decline (MRNA, PTON, INTC).
- **Two smaller ones:**
  - Covered Calls cap the rallies (MU, SMCI, HOOD, IREN).
  - The contract ranking chases the highest annualized yield, which points at the shortest, widest-spread and most lottery-like contracts.
- **The most promising ideas go straight at these:**
  - pause or shrink the ladder in downtrends (I-01);
  - sell Calls from today's price once shares are stuck (I-02);
  - lower-delta Calls, or Calls on part of the shares (I-03);
  - commit less per ticker (I-06).
- **Do the cheapest work first.** Three checks on runs we already have need no new backtests. Several ideas can then be tested with settings the lab already has.

## Ground rules for every test

These were settled before this backlog. An idea that conflicts with one is parked, not dropped silently.

- **Yardstick**
  - Excess Calmar per ticker = (CAGR − T-bill CAGR) ÷ \|Max drawdown\|. Better or worse means a change of more than 0.005.
  - Cash utilization must stay at 80% or more of the baseline's.
  - A rule passes only if most tickers get better while staying above that floor: at least 12 of 22 on each entry. Better/worse counts get a sign test.
- **Fills at the mid.** The spread cost share is 0. Marcelo set this on 2026-10-15 after testing live fills. Don't propose charging part of the spread unless live fill data shows orders at the mid failing.
- **Short-dated contracts stay.** Marcelo decided on 2026-10-08 that 2-day contracts are attractive for their yield. Their risk is to be managed by sizing (delta, momentum, yield), not by excluding them.
- **Hold-out: ask Marcelo each time** whether to judge on a hold-out (no standing rule since 2026-10-15). BE, COIN, CSCO, NBIS, PLTR and WDC have been used twice already. MSFT, MSTR, NFLX, ORCL, SOFI, GLD and XLE were used once (Round 7). Newly downloaded tickers would make a cleaner hold-out.
- **Re-runs.** Marcelo asks for re-runs himself. This file lists new tests only.
- **Formulas and parameters** need Marcelo's sign-off before anything is built.
- **How new engine switches are built**
  - They default to off.
  - Stored sessions must replay identically, row for row.
  - Prices come from IBKR's split-adjusted bars, never from option parity.
- **Lab and Pluto stay separate.** A lab result reaches Pluto only by a separate decision, and that change updates Pluto's How it works tab in the same commit.

## Proposed first batch (for discussion; nothing approved)

1. **Checks on runs we already have** (no new backtests): C-1 entry time and weekday, C-2 days-to-expiry buckets, C-3 ladder rungs.
2. **Tests with existing settings**
   - I-03: Call \|delta\| capped at 0.10 or 0.15.
   - I-02, always-on version: Calls on held shares at any strike within the \|delta\| range.
   - I-06 brackets: no ladder at all, and 2–3 rungs.
   - I-22: entry Puts at \|delta\| up to 0.15.
3. **Two rules to build**, if the checks support them:
   - I-01, pausing ladder Puts in downtrends, using the C-3 result and our Round 5 caveat;
   - I-02, the version that waits until shares are stuck.

## Index

**Status:**
- *Not started*.
- *Parked* (conflicts with a decision, or waits on data).
- *Dropped*.
- *Tested: failed*, or *Tested: passed*.
- *Adopted*.

**Code before a test:**
- *None*: an existing lab setting.
- *Small*: one new lab switch.
- *Medium*: new data or several parts.
- *Large*: the engine would need to buy options, or a book-level yardstick.

| ID | Idea | Targets | Code before a test | Confidence | Status |
|---|---|---|---|---|---|
| I-01 | Pause ladder Puts while the stock is in a downtrend | Max drawdown | Small | Moderate on Max drawdown, low on Excess Calmar | Not started |
| I-02 | Sell Calls from today's price once shares are stuck | CAGR on collapsed tickers | None, then small | Moderate on collapsed tickers, low overall | Not started |
| I-03 | Lower-delta Calls, or Calls on part of the shares | CAGR on rally names | None (partial coverage: small) | Moderate | Not started |
| I-04 | Rank contracts on richness after costs, not raw annualized yield | Both | None to small | Low to moderate | Not started (minimum-DTE variant parked) |
| I-05 | How much of CAGR comes from very wide spreads | Validity | None | — | Parked |
| I-06 | Commit less per ticker; a size-aware ladder | Max drawdown | None to medium | Moderate on Max drawdown, low on Excess Calmar | Partly tested (Round 7): sizing new buying didn't pass |
| I-07 | Idle cash, and more of the book, into index ETF Puts | CAGR, cash utilization (book) | Medium | Moderate that the premium is real, low on our yardstick | Not started |
| I-08 | Option-implied warnings: Call–Put IV spread, rising Put IV, implied skewness | Max drawdown | Medium | Low to moderate | Not started |
| I-09 | Sell late in the day and before weekends | CAGR | None (check), then small | Low | Not started |
| I-10 | Sell the ladder Put and the Call together (covered strangle) | CAGR, cash utilization | Small | Moderate on utilization, low on Excess Calmar | Not started |
| I-11 | Option momentum: pots to tickers where selling has paid | CAGR (book) | Medium | Low | Not started |
| I-12 | Keep entries out of lottery and distress phases | Max drawdown | Small | Low to moderate | Not started |
| I-13 | Pots to tickers whose options are rich for reasons unrelated to drift | CAGR (book) | Medium | Low | Not started |
| I-14 | Option-to-stock volume ratio as a warning | Max drawdown | Medium | Low to moderate | Not started |
| I-15 | Screen tickers on catastrophic-loss risk | Both | Large (needs 100+ tickers) | Unknown | Not started |
| I-16 | Smaller pots on retail-herding and high-disagreement names | Max drawdown | Medium (needs data we lack) | Low | Parked (data) |
| I-17 | No rung after a news-driven or extreme drop | Max drawdown | Small | Low to moderate | Not started |
| I-18 | A run-up crash score sets the ladder's depth | Max drawdown | Medium | Low to moderate | Not started |
| I-19 | Cap the position's net delta | Max drawdown | Medium | Low to moderate | Not started |
| I-20 | Defined-risk rungs: buy a Put at the ladder's floor | Max drawdown | Large | Mixed | Not started |
| I-21 | Trend filter on the entry Put | Max drawdown | Small | Low to moderate | Not started |
| I-22 | Lower-delta entry Puts | Max drawdown | None | Low to moderate | Not started |
| I-23 | Split the entry across strikes, expiries or days | Smoother results | Medium | Low | Not started |
| I-24 | No new Puts above an implied-volatility cap | Max drawdown | Small | Low | Not started |
| I-25 | Inverted IV term structure (check first) | Unknown | Small | Unknown | Not started |
| I-26 | Enter after a volatility spike starts to fade | CAGR | Small | Low | Not started |
| I-27 | Longer-dated Calls when no short-dated one qualifies | CAGR on moderate drawdowns | Small | Low | Not started |
| I-28 | A cooldown on Calls after assignment | CAGR on rebounds | Small | Low | Not started |
| I-29 | Buy a far Call above each Call sold | CAGR on parabolic rallies | Large | Low | Not started |
| I-30 | Size up when market volatility is high | CAGR | Medium (VIX data) | Low | Not started |
| I-31 | No new Puts while the VIX term structure is inverted | Max drawdown in market sell-offs | Medium (VIX data) | Low | Not started |
| I-32 | Skip earnings only on tickers whose real moves beat the implied ones | Max drawdown | Small | Low | Not started |
| I-33 | Model early assignment and dividends | Realism | Medium | — | Not started |
| I-34 | Correlation and sector caps on committed capital | Max drawdown (book) | Medium | Moderate | Not started |
| I-35 | One pooled ladder reserve across tickers | CAGR, cash utilization (book) | Large | Unknown | Not started |
| I-36 | Pluto live: an account-wide stress gate before each sale | Ruin risk (live) | Medium | High that it matters live | Not started |

## Checks on runs we already have (no new backtests)

- **C-1. P&L by entry hour and weekday** (for I-09).
  - Do sales at the last looks of the day, or on Thursday and Friday, earn more per trade than the 10:00 ones?
  - Also check whether annualizing yield by calendar days penalizes contracts that span a weekend: our ranking does that, while the research says weekends favour sellers.
- **C-2. P&L by days to expiry** (for I-04).
  - For buckets of 1–2, 3–7, 8–14 and 15–45 days: premium kept, assignment rate, and what the assigned shares did afterwards.
  - This tests whether short-dated contracts earn their risk without excluding any.
- **C-3. P&L by ladder rung** (for I-01 and I-06).
  - For rungs 1 to 5: each rung's own result, and what the shares it bought did over the next 63 and 252 sessions.
  - If the deep rungs are the losers, pausing or shrinking them is the fix. If they are the winners (bought near the lows), the ladder is earning its keep.
- **C-4. Option-implied warnings on past orders** (for I-08). As in Round 5's Test 3, check whether these separate good outcomes from bad ones, computed from the ThetaData chains at every past entry and rung:
  - the Call–Put IV spread;
  - the one-month change in Put IV;
  - implied skewness.
- **C-5. Term structure and earnings on past orders** (for I-25 and I-32).
  - Tag each past entry with the 30/60-day IV slope.
  - For each ticker, compute its realized-to-implied earnings move over the last 8 quarters.

## The shortlist

The order matches the published [Ladder Strategy Ideas](https://claude.ai/artifact/CAQhQ1myv575QkadVGtUqD) page. "Threads" counts how many of the six research threads raised the idea independently.

### I-01. Pause ladder Puts while the stock is in a downtrend

- **The change.** Sell a ladder Put only while the stock is not in a long downtrend. The entry Put and the Calls on held shares stay as they are. Candidate rules:
  - the price is above its 200-day average;
  - the 12-month return, skipping the last month, is above a limit such as −20% or −40%;
  - only rungs 2–5 are paused;
  - spacing: no new rung until the stock has gone M sessions without a new low, or at most one rung a month.
- **Why (5 of 6 threads).**
  - A Covered Call's built-in "buy more as it falls" exposure carried about 25% of its risk for little return (Israelov & Nielsen), and the ladder is a larger version of that bet.
  - 3–12-month losers keep losing (Jegadeesh & Titman).
  - 40% of US stocks fell 70% or more and stayed at least 60% below their peak (J.P. Morgan).
  - Cash-Secured Puts lost at every delta on C and USO (Spintwig).
  - Evidence: LITERATURE-REVIEW.md sections 3 and 10.
- **Against: our own data.**
  - Round 5's order study (BACKTEST-FINDINGS.md):
    - About 70% of ladder Puts were sold while the price was below its 200-day average. Within each ticker, they were followed by 30% falls no more often than the rest (−3.2 points on Cash-Secured Put entry runs, 0.0 on Covered Call entry runs).
    - Ladder Puts sold at a high IV Rank fell least and earned most.
    - Nearly all the cases where the ladder ran out of rungs did follow below-average ladder Puts.
    - So a plain 200-day gate would remove most of the ladder. The 12-month limit at −40%, or spacing, blocks far fewer Puts.
  - Our Sortino lab (Round 3a): timing rules on the stock itself missed the V-shaped rebounds of 2020, 2023 and 2025.
  - Trend rules elsewhere: Max drawdown was shallower on 82% of 193 tickers, but risk-adjusted return was better on only 25% (The Long Trend).
- **Fit.** It goes straight at the worst runs (PTON, MRNA, DOCN, AAOI, INTC). It is not the entry filter that failed: that one blocked entries while a stock was stretched upward, whereas this acts only while shares are held and the stock is falling.
- **Risks.** It misses V-shaped recoveries, and it lowers cash utilization, which may break the 80% floor.
- **Round 7's guard is a cousin, not this.** It scaled entries and ladder Puts while a stock was 25% or more below its high and falling without the market. Max drawdown was shallower on 10 of 22 tickers and deeper on 1, but Excess Calmar was no better (6 better, 9 worse), and the hold-out was worse (1 better, 4 worse). Its misses were solo recoveries (IREN, ALAB, ASTS). The trend rules above remain untested.
- **How to test.**
  - Run C-3 first.
  - Then build a new switch like the entry filters: a 100-, 150- or 200-day average, or a 12-1 limit of −20% or −40%, with variants for rungs 2–5 only and for spacing.
  - The formula needs sign-off.
- **Code:** small. **Confidence:** moderate on Max drawdown, low on Excess Calmar. **Status:** not started.

### I-02. Sell Calls from today's price once shares are stuck

- **The change.** Normally, Calls on held shares must be at or above the break-even. After N sessions in which no such Call has qualified, or once the price is below a set share of the break-even (for example 0.7×), choose Calls by \|delta\| at any strike, for example 0.10–0.15. The shares may then be called away below their cost.
  - Variant: allow these Calls only while the trend is down and the ladder is used up or paused, and start a new cycle only once the trend turns up.
- **Why (5 of 6 threads).**
  - Once shares are held, "the initial stock price is irrelevant" (Israelov & Nielsen 2014). An option's profit comes from how rich it is, not from where its strike sits against the cost.
  - Investors hold losers too long (Odean: about 3.4 points a year).
  - The community rule "never below cost basis" has no data behind it.
  - Illustration, not evidence: at 80% implied volatility a 30-day 0.20-delta Call is worth about 2.3% of the share price, while the stuck shares earn nothing.
  - Evidence: LITERATURE-REVIEW.md section 4.
- **Fit.** Shares sat stuck for 1,230 sessions on PTON, 779 on TECH and 265 on HOOD. The share stop-loss we tested sold at once at the bottom. This keeps collecting premium and lets a rally decide the exit.
- **Risks.** Shares called away near the bottom give up the rebound, losses get realized, and the Calls may whipsaw.
- **How to test.**
  - Today: `callStrike: "delta_range"` puts Calls on held shares at any strike within the Calls' \|delta\| range, always on. This bounds the effect.
  - The version that waits until shares are stuck is a small change. Try N of 10, 20 or 60 sessions (or X of 30% or 50% below the break-even), with \|delta\| caps of 0.15 or 0.30.
  - Count the losses realized when shares are called away.
- **Code:** none to start, then small. **Confidence:** moderate on collapsed tickers, low on the total. **Status:** not started.

### I-03. Lower-delta Calls, or Calls on only part of the shares

- **The change.** Any of these:
  - cap the Calls' \|delta\| at 0.10–0.15, optionally only while the price is above its 200-day average;
  - sell Calls on 50–75% of the shares instead of all of them;
  - on strongly trending names, use longer-dated Calls.
- **Why (4 of 6 threads).**
  - Spintwig, SPY short Calls held to expiry: Sharpe 0.26 at 5 delta, falling to −0.27 at 50 delta.
  - Russell 2000 Covered Calls did better further out of the money (Kapadia & Szado).
  - QYLG, covering 50%, made 14.06% a year against 10.29% for QYLD, covering 100%.
  - On SPY, 30-delta Calls finished in the money 45% of the time against 30% implied.
  - Covered Calls give "very limited" downside protection (AQR Myth 2), so capping rallies buys little reduction in Max drawdown.
  - Evidence: LITERATURE-REVIEW.md section 5.
- **Fit.** Calls on held shares now go up to 0.30 delta, and our rally names get capped.
- **Risks.** Less premium. Most of the evidence is on indexes, though single stocks' fatter right tails strengthen the case.
- **How to test.**
  - Today: the Calls' own \|delta\| range (`callMinAbsDelta`/`callMaxAbsDelta`) at 0.05–0.10 and 0.05–0.15.
  - Partial coverage ("Call coverage %": 100, 75, 50), a trend-conditional cap, and a separate expiry band for Calls are small changes.
- **Code:** none (variants: small). **Confidence:** moderate. **Status:** not started.

### I-04. Rank contracts on richness after costs, not on raw annualized yield

- **The change.** Keep every expiry, and change the order contracts are picked in. Candidate orderings:
  - premium after half the quoted spread and the commission;
  - yield × (1 − \|delta\|);
  - premium minus the contract's fair value at a forecast volatility.
  - Alternatively, size short-dated contracts by their risk instead of reranking.
- **Why (4 of 6 threads).**
  - Annualized premium is not profit (AQR Myth 4). Cboe's weekly put-writing collected 39.3% a year in premium against 24.1% for the monthly one, yet compounded 5.6% against 6.6%.
  - Spintwig: AAPL Puts had a Sharpe of 0.05–0.35 at 0 days against 0.46–0.52 at 45 days, and commissions took 20.8% of profits at 0 days.
  - Evidence the other way: lottery-like overpricing is largest close to expiry (Boyer & Vorkink), and shorter SPY expiries earned more total P&L in one Spintwig test. LITERATURE-REVIEW.md section 6.
- **A caution.** A ranking by yield prefers Puts on hard-to-borrow stocks, where the extra premium is borrow cost, not edge (Ofek et al.; Ramachandran & Tayal).
- **Conflict.** The published page also proposed a minimum days to expiry of 7, 14 or 21. That excludes short-dated contracts, which Marcelo decided against on 2026-10-08, so it is parked. Check C-2 studies the same question without excluding anything.
- **How to test.**
  - The rankings `time_value` and `premium_per_day` already exist.
  - A cost-aware ranking is a small change, and its formula needs sign-off.
  - The forecast-based version depends on a forecast that failed as a filter (the volatility edge filter).
- **Code:** none to small. **Confidence:** low to moderate. **Status:** not started; minimum-DTE variant parked.

### I-05. How much of CAGR comes from very wide spreads

- **The change.** Rerun the lab with the spread limit at 15–20% of mid, instead of 50%.
- **Why.** Academic option-selling edges vanish once 50–100% of the quoted spread is paid (Cao & Han; Saretto; Heston et al.). Traders who time their orders pay under 40% of it (Muravyev et al.).
- **Conflict.** The published page also proposed charging fills at more of the spread. Fills at the mid are settled (2026-10-15, after Marcelo tested live fills), so that variant is dropped. The spread-limit run would only show where the return comes from. It matters only if live fills on very wide spreads turn out worse than the mid.
- **How to test.** The existing `maxSpreadPctOfMid`.
- **Status:** parked; revisit only if live fill data shows wide-spread orders failing at the mid.

### I-06. Commit less per ticker; a size-aware ladder

- **What the settings do today.** With `ladderSharesPct` 50 and 5 rungs, the shares' budget plus the full reserve can commit the whole pot. Each rung's collateral is the reserve ÷ the rungs, so fewer rungs means bigger, wider-spaced rungs, not a smaller ladder. `maxAccountPctPerStock` caps entries only; ladder Puts are bounded by their rung, the cash and volume.
- **The changes, from cheapest:**
  - **Bracket with no ladder.** `ladderPace: "no_puts"` uses the shares' budget alone, with the reserve idle in T-bills. If even this doesn't improve Excess Calmar, a partial pause (I-01) is unlikely to. Cash utilization will fall. (Existing.)
  - **Fewer rungs.** 2–3 rungs change the spacing and the timing of the averaging down. (Existing: `ladderRungs`.)
  - **A different split.** Shares/reserve at 65/35 or 80/20 tests the opposite worry: an idle reserve is real capital (Hayley). (Existing: `ladderSharesPct`.) Round 4 already found that more in shares means higher CAGR and a deeper Max drawdown.
  - **A cap on total commitment.** Cap shares plus ladder collateral at 60% or 75% of the pot, or so that committed × shock is at most 5–10% of the account (a fractional-Kelly cap). (Small change: extend the cap to ladder Puts.)
  - **Volatility sizing.** Contracts × min(1, a target volatility ÷ the 20-day realized volatility), for entries and rungs. (Medium.)
  - **A drawdown governor.** New Put collateral allowed = R0 × max(0, (equity − floor) ÷ (peak − floor)), with floor = (1 − D) × running peak and D of 25%, 35% or 50% (Grossman & Zhou). (Medium.)
  - **A split that follows the regime.** 65/35 while the trend is up and volatility is below its median; 35/65, with rungs paused, while the trend is down. (Medium.)
- **Why (4 of 6 threads).**
  - Volatility targeting thinned the left tail in every asset (Harvey et al.), though versions run in real time did worse (Cederburg et al.).
  - Half Kelly keeps 75% of the growth (MacLean, Thorp & Ziemba).
  - At the peak before its deepest drawdown, the median base run already had 43% of its pot committed.
  - Evidence: LITERATURE-REVIEW.md section 8.
- **Against.** Index Put sellers did best when the VIX was high (Spintwig), the opposite of volatility targeting. Our Sortino lab's volatility-managed exposure failed on 23 symbols.
- **Risks.** Lower CAGR and cash utilization, which may break the floor.
- **Round 7 (2026-10-21).** New buying (entries and ladder Puts) scaled by a constant, and by dynamic Kelly sizing from extension z:
  - ×0.75 and ×0.5 made Excess Calmar better on 12 and 13 of 22 tickers and Max drawdown shallower on 21, but left 17 and 21 tickers below the cash floor.
  - Dynamic sizing passed on at most 11 of 22, and that version failed the hold-out (1 better, 6 worse).
  - Untested: the cap on total commitment, volatility sizing, the drawdown governor and the regime split.
- **Code:** none to medium. **Confidence:** moderate on Max drawdown, low on Excess Calmar. **Status:** partly tested (Round 7). The formulas for the medium variants need sign-off.

### I-07. Idle cash, and more of the book, into index ETF Puts

- **The change.** At book level, either:
  - cash idle for more than N sessions sells SPY or QQQ Puts under the same rules (1–7 days, \|delta\| 0.10–0.20); or
  - the ETF pots get a larger share of the capital.
- **Why (5 of 6 threads).**
  - The variance premium is strongly significant on indexes, but in dollar terms significant for only 3 of 35 stocks (Carr & Wu). The index premium is a premium for correlation risk (Driessen et al.).
  - Cboe PUT, 1986–2018: CAGR 9.54% against 9.80%, with Max drawdown −32.7% against −50.9%.
  - Spintwig: Puts on SPY, IWM, TLT, EEM and GLD made money at every delta.
  - Evidence: LITERATURE-REVIEW.md sections 1 and 2.
- **Fit.** Lifts cash utilization (median 51–55% on our base runs) with the most reliable premium there is.
- **Risks.**
  - Index Puts lose together with our names in market-wide crashes (March 2020), exactly when the ladder needs the cash.
  - Index premiums may fall short of the 20% yield floor.
  - A per-ticker yardstick can't see a book-level gain.
- **How to test.** A multi-ticker session with an idle-cash rule, judged on the whole book. That needs a book-level yardstick first.
- **Code:** medium. **Confidence:** moderate that the premium is real, low on our yardstick. **Status:** not started.

### I-08. Let the options warn us: Call–Put IV spread, rising Put IV, implied skewness

- **The change.** Skip an entry or a rung while any of these holds:
  - Puts are expensive against Calls of the same strike and expiry;
  - Put IV has risen much more than Call IV over a month;
  - implied skewness leans to the Calls (a speculative phase).
- **Why (2 of 6 threads).**
  - Stocks with expensive Calls against Puts beat those with expensive Puts by about 0.5% a week (Cremers & Weinbaum).
  - Big rises in Put IV predicted returns about 1% a month lower (An et al.).
  - In a 2015–2026 preprint, the Call–Put spread and implied skewness stayed significant in every period while the smirk faded (Li & Wang). The faded smirk matches our own steep-skew result.
  - Evidence: LITERATURE-REVIEW.md section 10.
- **Risks.**
  - The studies sort hundreds of stocks each month. With about 20 tickers, each must be judged against its own history.
  - Early exercise distorts single-stock Put/Call IV gaps.
  - Option signals predicted 5-day crashes poorly in 2020–22.
- **How to test.** C-4 first, then a gate.
- **Code:** medium. **Confidence:** low to moderate. **Status:** not started.

### I-09. Sell late in the day and before weekends

- **The change.** Allow new sales only at the last looks of the day, or favour Thursday and Friday.
- **Why (3 of 6 threads).**
  - Delta-hedged single-stock options returned −0.4% overnight against +0.1% intraday; in the authors' words, "option prices are too high at the close" (Muravyev & Ni).
  - Option returns are lower over weekends: −0.62% from Friday to Monday for stock options (Jones & Shemesh).
  - Spintwig's backtests all enter at 15:46 ET.
- **Fit.** We look every 30 minutes from 10:00 and sell at the first look that qualifies.
- **Risks.** The effects are fractions of a percent a day, smaller than typical spreads.
- **How to test.** C-1 first. If it shows up, a "last look only" switch is small (`looks` today offers every look or 10:00 only). A ranking that annualizes by trading sessions is a related small change.
- **Code:** none, then small. **Confidence:** low. **Status:** not started.

### I-10. Sell the ladder Put and the Call together (covered strangle)

- **The change.** While shares are held, sell a Call and a ladder Put whenever both qualify, instead of one or the other.
- **Why (3 of 6 threads).**
  - Stock plus a short Call plus a short Put beat the stock's mean return in all 29 stock-periods, and had a higher Sharpe in all 10 large caps. It was more volatile in 21 of 29 (Hemler & Miller, OIC-funded).
  - ORATS "covered combo": 13.01% against 11.13% for the stock, with a Sharpe of 0.66 against 0.74.
- **Fit.** It raises cash utilization, which is low.
- **Risks.** It doubles the exposure taken into a fall on crash-prone names, so pair it with I-01 or I-06.
- **How to test.** A "both" choice next to `ladderPutVersusCall` ("call_first", "higher_yield").
- **Code:** small. **Confidence:** moderate on utilization, low on Excess Calmar. **Status:** not started.

## Other ideas

Weaker evidence, a poorer fit, or a bigger build. Sections refer to LITERATURE-REVIEW.md.

**Ticker choice and pots (book level)**

- **I-11. Option momentum.** Give the pots to tickers whose options have paid sellers: trailing 12-month straddle returns, or our own short-Put P&L by ticker, rebalanced quarterly.
  - Heston et al.: Sharpe 1.53 before costs, near zero after the full spread. The strategies' Max drawdowns were −40% to −69%. (§1, §10)
  - Medium. Low confidence.
- **I-12. Keep entries out of lottery and distress phases.** Skip new Cash-Secured Puts while MAX (the month's largest one-day gain) or stock-specific volatility is in the ticker's top fifth for its past year. Variants: give such tickers smaller pots, or sell Calls rather than ladder Puts on lottery-like names.
  - Bali et al.: the lowest-MAX decile beat the highest by over 1% a month. Byun & Kim; Cao & Han; Campbell et al. on distress. (§1)
  - Small, from IBKR bars. Low to moderate confidence.
- **I-13. Pots to tickers whose options are rich for reasons unrelated to drift.** Rank tickers monthly by IV against their own 12-month average and by implied over realized volatility, or by each ticker's average variance premium and its variance beta to SPY. First check whether these rank the tickers' Excess Calmar.
  - Saretto: the stocks themselves showed no return pattern while their options were rich. Goyal & Saretto; Ahn; Carr & Wu. (§1, §10)
  - Medium. Low confidence.
- **I-14. Option-to-stock volume ratio**, against the ticker's own history (ThetaData option volume ÷ IBKR share volume).
  - Johnson & So: the lowest decile beat the highest by 0.34% a week. The retail options boom since 2020 inflates the ratio, hence the own-history comparison. (§10)
  - Medium. Low to moderate confidence.
- **I-15. Screen tickers on catastrophic-loss risk.** Regress per-ticker Excess Calmar on features known at the start (sector, stock-specific volatility, distress, IPO age). This needs a survivorship-free universe of 100+ names, since 20 tickers lack the power.
  - J.P. Morgan: 57% of tech stocks had a catastrophic loss. Dropping such names also drops winners (HOOD, ASTS). (§3)
  - Large. Unknown confidence.
- **I-16. Smaller pots on retail-herding and high-disagreement names.**
  - Robinhood favourites fell 4.7% against the market over 20 days (Barber et al.). High analyst disagreement goes with underperformance (Diether et al.). (§10)
  - Needs short-interest (FINRA) and analyst data we don't have. Parked.

**The ladder**

- **I-17. No rung after a news-driven or extreme drop.** Pause or shrink rungs after a fall around an earnings date or a large gap on heavy volume; allow rungs after a drift lower without news.
  - News-driven moves don't reverse (Da, Liu & Schaumburg), and extreme losers keep underperforming (Atilgan et al.). (§10)
  - First tag past rungs by "earnings within ±2 sessions of the drop" and by gap and volume, then compare rung P&L.
  - Small. Low to moderate confidence.
- **I-18. A run-up crash score sets the ladder's depth, not the entry.** When the score is high, use a deeper floor and fewer, smaller rungs. The score combines acceleration (the two-year return minus the first year's), the one-year change in realized volatility, and the volume trend, all from IBKR bars. Fit it on 2020–2023 and test on 2024–2026.
  - Greenwood, Shleifer & You: after a 100% two-year run-up, 53% of industries fell 40% or more within two years, against 14% unconditionally. Exiting on volatility, age or acceleration beat holding on. This fits our extension result. (§10)
  - Medium. Low to moderate confidence.
- **I-19. Cap the position's net delta** (shares + short Puts − Calls). Rungs and Call strikes, chosen by delta, must keep net delta at or below a target, for example 0.5, 0.75 or 1.0 × pot ÷ price.
  - Israelov & Nielsen's reversal exposure; ERN: net delta goes from about 0.2 to 1.0 as the wheel turns. (§3)
  - Medium. Low to moderate confidence.
- **I-20. Defined-risk rungs.** Each rung, and optionally the entry Put, also buys a Put near the floor at the same notional. Variant: buy a 3–6-month Put at the floor once the reserve is 50% committed.
  - theoptionsbench SPY: CAGR 2.65% against 3.75%, Max drawdown −7.8% against −28.5%. Spintwig SPY spreads beat naked on Sharpe. But Cboe PPUT did worse than PUT, and a short-dated wing doesn't touch the slow bleed after assignment. (§9)
  - Large: the engine doesn't buy options. Mixed confidence.

**Entries**

- **I-21. Trend filter on the entry Put.** Start a cycle only while the price is above its 200-day average, or the 12-month return is above 0. This blocks the opposite side from the failed extension filter, so it will miss bottoms instead of rallies.
  - Option Alpha: on put spreads it helped SPY and TLT and hurt GLD (words only). The Long Trend: risk-adjusted return was better on only 25% of tickers. (§10)
  - Small. Low to moderate confidence.
- **I-22. Lower-delta entry Puts:** a maximum \|delta\| of 0.15 against 0.30. With the lab's `ladderPutDeltaRange: "none"`, ladder Puts are unaffected.
  - Spintwig: the best Sharpe came at 16 delta or lower on 15 of 16 underlyings (TSLA: 2.24 at 5 delta against 0.72 at 50 delta). Total return runs the other way, and a low-delta CAGR can fall below T-bills. (§1, §2)
  - None. Low to moderate confidence.
- **I-23. Split the entry** across 2–4 strikes, expiries or days.
  - Cboe WPUT's Max drawdown was −24.2% against −32.7% for monthly. Man Group found about 2.5 points a year of start-date luck on one collar. (§6, §9)
  - Medium. Low confidence.
- **I-24. No new Puts above an implied-volatility cap** (sweep 60–120%).
  - An anecdote ("wheel only what you'd own"; RIDE, PTON, SPCE, NKLA, BBBY). It is close to the IV Rank filter that failed, and would cut IREN, ASTS and HOOD. (§11)
  - Small. Low confidence.
- **I-25. Inverted IV term structure.** Run C-5 first. The direction is unknown for an unhedged seller: rich options, but a weaker stock.
  - Vasquez; Li & Wang. (§10)
  - Small. Unknown confidence.
- **I-26. Enter after a volatility spike starts to fade.** Open a Put or rung only while the stock's IV (or the VIX) is below its 5-day high and down on the day.
  - FlashAlpha's strongest predictor was a "falling VIX" flag, which it didn't define. ERN sells after spikes. (§8)
  - Small. Low confidence.

**Calls**

- **I-27. Longer-dated Calls** (46–365 days) when no short-dated Call at or above the break-even qualifies. Report the fill rate, since long-dated spreads are wide and the volume cap may bind.
  - No direct test. AQR's Myth 4 argues against expecting more. (§6)
  - Small. Low confidence.
- **I-28. A cooldown after assignment.** No Call, or only a very low-delta one, for N sessions after a Put is assigned.
  - A Spintwig observation without a table: Calls written right after an assignment often lost on the rebound. (§7)
  - Small. Low confidence.
- **I-29. Buy a far Call above each Call sold** (0.03–0.05 delta), to keep the upside in parabolic rallies.
  - SPYI does something similar; its edge over XYLD can't be attributed to it. (§5)
  - Large: the engine doesn't buy options. Low confidence.

**Market-wide**

- **I-30. Size up when market volatility is high,** for example 0.5× at a VIX of 15–20 and 1.5× at 25 or more. This is the opposite of the IV Rank block that failed.
  - Spintwig SPX Puts: VIX 25+ entries kept 76% of the premium, while VIX 15–20 entries kept 6.1%. The evidence is index-only and runs against volatility targeting (I-06). (§8)
  - Medium, needs VIX data. Low confidence.
- **I-31. No new Puts while the VIX is above the 3-month VIX** (an inverted term structure).
  - Johnson (JFQA 2017); Cheng (RFS 2019). Index-level only; it can't help with stock-specific collapses. (§10)
  - Medium, needs VIX data. Low confidence.

**Earnings, engine and book**

- **I-32. Skip earnings only on tickers whose real moves have beaten the implied ones** (trailing 8 quarters, from ThetaData straddles before each report).
  - ORATS: the actual move averaged about 85% of the implied one. Gao, Xing & Zhang: straddles gained most before announcements on small, volatile names. Our blanket earnings skip changed little. (§10)
  - Small. Low confidence.
- **I-33. Model early assignment and dividends.** Assign a Put once its time value falls below the interest on the strike to expiry, and a Call once its time value falls below the next dividend.
  - Barraclough & Whaley; Pool, Stoll & Whaley. This matters for TLT and the other ETFs, AAPL, and deep in-the-money Puts at 4–5% rates.
  - Medium. Engine realism, not a strategy change.
- **I-34. Correlation and sector caps.** Cap committed capital per cluster, for example SMCI/MU/ALAB/AAOI/SMH and IREN/CRWV.
  - Volatility-premium drawdowns coincide with equity crashes (AQR). No data was found on how many names it takes to diversify. It doesn't help with single-name collapses. (§9)
  - Medium; needs the book-level yardstick. Moderate confidence.
- **I-35. One pooled ladder reserve,** sized for k ladders running at once (k = 2, 3 or 4), instead of 50% idle in every pot. Use the freed cash for more entries.
  - No evidence; reasoning only. It fails exactly when names fall together, so pair it with I-34.
  - Large. Unknown confidence.

**Pluto live**

- **I-36. An account-wide stress gate before each sale.** Simulate −30% on every name plus +50% implied volatility, and block the sale if the account's loss would exceed a limit. Pluto already caps each order's own stress loss (`computeStressCap` in `src/pluto/postModelGates.ts`, settings `stressRiskBudgetPct` and `stressSigmas`). This would extend the cap to everything held at once.
  - Every blow-up reviewed combined leverage, an unenforced loss limit and a volatility spike (LJM, OptionSellers, XIV, Malachite). (§11)
  - The backtest can't show it: it is cash-secured and held to expiry.
  - Medium. High confidence that it matters live. Formula sign-off needed.

## Dropped

- **D-01. Early take-profit once 80%+ of the premium is captured and the stock's risk has risen significantly.**
  - Marcelo asked for this on 2026-10-20, then dropped it the same day: "I don't think it'll yield any meaningful results."
  - The evidence agrees: on Spintwig's scorecard, holding to expiry beat closing early in 66 of 79 pairs (LITERATURE-REVIEW.md section 7).
  - The lab's `takeProfitPct` exists if it is ever revisited.

## Not recommended

| ID | Idea | Why not |
|---|---|---|
| N-01 | Stop-loss on the option (close at 1–5× the credit) | Lowered the Sharpe ratio in 27 of 30 SPY variants (Spintwig, 170,500 trades). Stops pay only where leverage creates a risk of ruin; we are cash-secured. A Put stop before assignment cut the worst week from −25% to −9% of collateral but halved the return per year of capital (Thetadesk). |
| N-02 | Close at 50% profit, or at 21 days to expiry | Holding to expiry won in 66 of 79 ticker × delta pairs (MU managed −1.29 to +0.07 against 0.17–0.26 held). On the SPY Wheel it deepened Max drawdown at 3 of 5 deltas. Early management won mostly on SPY and IWM (9 of its 11 wins). |
| N-03 | Collars, protective Puts, tail hedges | Monthly 5% out-of-the-money Puts cut the S&P's return from 5.1% to 1.8% for a Max drawdown of −57% instead of −62% (AQR). A collar made 3.2% against 7.3% (Israelov & Klein). Tail-hedge funds lost about 2% a year since 2008. Holding less beats buying protection (Israelov). |
| N-04 | Stock repair (a 1×2 Call ratio) | Explainers only, no backtests; one vendor test made −0.18% a trade. No use after a 60–95% fall, and it caps rebounds on moderate dips. |
| N-05 | Rolling Puts down and out | By put-call parity it equals taking assignment and selling a Call at the new strike: I-02 with extra costs. (A roll test should match I-02 within costs, which would make it an engine check.) The SEC found "Karen the Supertrader" hid more than $50 million of losses by rolling. |
| N-06 | Leverage, margin, LEAPS, the poor man's Covered Call, Calls instead of shares | Leverage scales excess return and Max drawdown together, so it can't raise Excess Calmar. One vendor test made −0.61% a trade after costs, with a −48.6% Max drawdown. Every blow-up reviewed used leverage. |
| N-07 | 0–1-day index Puts far out of the money | ERN's approach needs about 3× leverage, and the premiums sit far below our 20% yield floor. |
| N-08 | "IV Rank above 50" entries | No credible backtest; one practitioner study found no edge. Close to the IV Rank filter that failed. Round 10: on a book of weekly Puts, IV Rank 50+ lowered Excess Calmar on both halves (0.62 → 0.44 and 0.67 → 0.21), though each sale earned more. |
| N-09 | "Puts on red days, Calls on green days" | One social-media post, no data. Our 30-minute yield ranking already favours down moments. |
| N-10 | The volatility smirk (steep Put skew) as a warning | Faded to insignificant in 2023–2026 (Li & Wang). It pointed the wrong way in our own Round 5. |
| N-11 | A trend overlay with futures as the account's tail hedge | Worked for AQR (trend made money in 9 of the S&P's 10 worst months), but it needs futures and margin, which a cash-secured design doesn't have. |
| N-12 | Filters on ladder Puts using the Signals model's fields or momentum | Round 5: the model's fields point the wrong way or nowhere, and on ladder Puts high implied volatility marks the safest orders. |

## Already tested

Details are in [BACKTEST-FINDINGS.md](BACKTEST-FINDINGS.md).

| ID | Test | Result |
|---|---|---|
| T-01 | Skip contracts spanning earnings | Changed few trades; no gain (Rounds 2 and 5). Remaining variant: I-32. |
| T-02 | Volatility edge filter (IV at or above the forecast, or 5+ points above) | Helps only by selling less; up to 12 of 22 runs fell below the floor (Round 5). |
| T-03 | Edge Yield ranking | No improvement (Round 2). |
| T-04 | Share stop-loss at 50% | Swings tickers both ways (Round 5). Trend-aware alternatives: I-01, I-02. |
| T-05 | A deeper ladder (shock 60–90%) | No improvement (Round 5). The opposite direction: I-06. |
| T-06 | No minimum Call yield (35% → 0) | No improvement (Round 5). |
| T-07 | Entry filters: extension z (0.75, 1, 1.5), IV Rank (70–90), both | No filter passes; Max drawdown slightly shallower, rallies missed; hold-out worse (Round 6). Left in the lab, off. |
| T-08 | Fewer Calls; longer forecast windows | Adds exposure, not edge (Round 2). |
| T-09 | Stock-only timing: 12-month momentum, earnings exits, volatility management, SPY trend | Failed the hold-out; missed V-shaped rebounds (Round 3a, Sortino lab). |
| T-10 | Share level 30% / 50% / 70% | More shares means higher CAGR and a deeper Max drawdown; no level clearly best (Round 4). |
| T-11 | Drop warnings studied without a backtest: Signals model fields, weak SPY, steep skew, momentum 12-1, skew below 0 | Wrong way, too few days with a value, or idle for a year or more (Round 5). |
| T-12 | Falling-knife guard: new buying scaled by the market's share of a fall, while 25%+ below the high (with or without an IV check) | Max drawdown shallower on 10 of 22, Excess Calmar no better; hold-out worse (Round 7). Code removed 2026-10-21, archived in API commit 1bdc501 and app commit 56399f9; reverting b1a9711 and 53b0847 restores it. |
| T-13 | Dynamic Kelly sizing of new buying by extension z (less at tops, more below the 200-day average), alone and with the guard; constant controls | No version passes (best 11 of 22, failed the hold-out); buying more below the average deepens drawdowns (Round 7). An LLM judged falling knives no better than the guard. Code removed 2026-10-21, archived in API commit 1bdc501 and app commit 56399f9; reverting b1a9711 and 53b0847 restores it. |
| T-14 | A different strategy: the Steady Stake (80% of the pot in shares, rebalanced in a ±5-point band; Calls and Puts sold only on their expiry day at \|delta\| 0.20) | Passes Marcelo's bar on all 37 tickers: median CAGR 17.8% against 10.7%, Excess Calmar 0.46 against 0.31; hold-out 3 of 4 (7 of 8 on CAGR). Deeper Max drawdown (−55% against −33%). Backtest only, awaiting sign-off (Round 8). |
| T-15 | Edge Margin's volatility model: a 21-day forecast without earnings sessions, the 2020–2026 rest-of-day curve, and whether its edge sorts contracts by outcome | The fixes made Excess Calmar better on 19 of 29 tickers and worse on 9 (p 0.087). The edge didn't sort about 890,000 contracts by outcome, with or without them (Round 10). The settings are in API commit `ec5e4ff`, to be reverted and kept in history (Marcelo 2026-10-22). |
| T-16 | A premium-only strategy: one weekly Put per ticker (4–7 days, \|delta\| 0.10–0.20), never holding stock, as an 11-ticker book; also with IV Rank thresholds | In the cash account: 6.6% CAGR, −5.2% Max drawdown, Excess Calmar 0.71 at \|delta\| 0.15. That is mostly T-bills and the stocks' rise; about 1.4 points is premium beyond drift. IV Rank thresholds made the validation half worse (Round 10). |
| T-17 | Delta-neutral: calendars, and single-stock Straddles and Strangles hedged every 30 minutes; SPY + QQQ Strangles on their expiry day | Single stocks lost. SPY + QQQ made 9.9% with a −3.7% Max drawdown, but they need margin and were outside the tradable set (Round 10). |
| T-18 | Long-dated Put hedges: Puts on each entry's shares (with 3 rules for fewer purchases); Puts on the whole position (shares plus short Puts), by % below or by \|delta\|, half coverage, and no purchase while too dear (cost against the typical yearly fall, IV against its median or realized volatility) | Entry hedge: no setting beat the ladder on 29 tickers (best 11 of 29). Whole position: Max drawdown shallower on all 5 test tickers (PTON −85.6% → −15.7%, MRNA −70.4% → −23.4%), Excess Calmar better on 3; costly on risers (MU) and high-IV names (SMCI); the IV gates didn't help. Stopped before the 29-ticker test; settings kept in the lab, off (Round 11). |

## How to test, whatever we pick

- **Run each variant on several start dates.**
  - Identical rules started a week apart give noticeably different results: Spintwig calls it timing luck, and Man Group measured about 2.5 points a year on one collar.
  - Run 4–8 weekly start offsets and take each ticker's median. That makes a pass or a fail more trustworthy.
- **Do the checks before building.** C-1 to C-3 cost no backtests and steer I-01, I-04, I-06 and I-09.
- **Book-level ideas need a book-level yardstick.** I-07, I-11, I-13, I-34 and I-35 can't be judged per ticker. Agree on the yardstick (and its formula) first.
- **Report like Round 6:**
  - better/same/worse counts with a sign test;
  - median changes in Excess Calmar, CAGR, Max drawdown and Sortino;
  - cash utilization against the floor;
  - per-ticker cards that flag stuck stretches, a ladder that ran out of rungs, and peaks never recovered.
- **Ask about the hold-out** before running (see the ground rules).
