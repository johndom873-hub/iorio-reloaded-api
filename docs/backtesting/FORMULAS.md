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
- **Excess Calmar** (the session tile, Marcelo 2026-10-28; the Analyse window's Backtest results since 2026-10-15) = (CAGR − the T-bill CAGR over the session's period) ÷ |max drawdown|; none with no drawdown. The T-bill CAGR is an all-cash account credited as the engine credits interest, compounded over the weekdays (`treasuryBillCagr`). A session read takes the rates from the DTB3 cache alone, so the tile is blank when the cache doesn't cover the period. Example (R1 · Vol Farmer v2 2bc376b1): CAGR 13.45%, T-bill CAGR 2.91%, max drawdown −60.41%: (13.45 − 2.91) ÷ 60.41 = 0.17.

Example: mean daily return 0.025%, downside deviation 0.35%: Sortino = 0.00025 × 252 ÷ (0.0035 × 15.87) = 1.13.

## Trades and wheel cycles

Whether the book made money is the **wheel cycle's P&L**, as the platform computes it (Marcelo 2026-10-12: "Just show Wheel Cycle P&L like we do in our platform"). An option sold has no P&L of its own.

- **position P&L** = the platform's position P&L: realized `positionRealizedPnl` (src/lib/positionSelectors.ts: each closed leg's `legRealizedPnl`, premium and stock parts, after commissions) + while open, `computeUnrealizedPnlByPosition` at the last marks. The same figures the Positions screen shows.
- **cycle P&L** = the platform's `deriveCycles` (src/lib/cycles.ts) on the simulated book: a cycle runs from the first position opened on a flat symbol until the symbol is flat again; its total is premiums in − buybacks − commissions + what the shares made, plus what an open cycle still holds at the last marks. The same figure the Wheel cycles view shows.
- **options sold** (trade count) = opening puts and calls and the new leg of each roll; **cycles** = the cycles of the session, and how many closed.
- **win rate** = closed cycles with a total above 0 ÷ closed cycles
- **average win / average loss** = mean total of the closed cycles above 0 / below 0, in dollars
- **edge capture** = Σ closed cycles' totals ÷ Σ Edge $ the model predicted for the options sold in those cycles (1.0 = the model was exactly right on average). A cycle's total counts what its shares made while held after an assignment or a covered call, which the options' Edge $ never predicted, so the figure runs above 1 when the shares gained (Marcelo 2026-10-12: counted on purpose)
- **model accuracy by edge margin** = closed cycles grouped by the edge margin of the cycle's first option sold, in bands of 10 points: predicted = Σ Edge $ (and history-corrected Edge $) of the cycle's options sold, realized = the cycle's total
- **capital in use** = mean over days of (Σ EXP $ of open positions ÷ account value)
- **return on capital in use** = Σ every cycle's total ÷ Σ over the session days of (EXP $ held that day × calendar days to the next session day) × 365 (approved by Marcelo 2026-10-12; it replaces the per-option definition, Σ option P&L ÷ Σ EXP $ × days held).
- **contracts in the money at expiry** = options sold that expired with the strike crossed ÷ options sold that expired
- **Shares, Covered Calls and Hedge** (the session tiles, approved by Marcelo 2026-10-26; `computePnlSources`, the whole account's, worked out when a session is read):
  - P&L: the Calls' = Σ the cycles' `cc` premium; the hedge's = Σ their `hedge` premium; the LEAPS' (Vol Farmer v2, 2026-10-27) = Σ their `leaps` premium (an open option at the last marks in all three); the shares' = the account's P&L (end value − start value) − interest − every option's (Σ the cycles' premium of all five buckets). The shares' figure therefore holds them at the account's last 10:00 marks, while positions and cycles mark at the last look.
  - part of the CAGR = CAGR × the source's P&L ÷ the account's P&L (none when the account made nothing). With the Puts sold and interest, the parts add up to the CAGR.
  - days held = the session's trading days with the source held at any time of the day ÷ all of them; a leg counts from its entry's Eastern date to its exit's, both included.
  - quoted: the median of the yearly yield recorded at each Call sale (`premiumYield`, as the cycle rows show it) and of each hedge purchase's yearly cost (`hedgePutCostYield`).
  - Example (R4 VF4 · HOOD): account +$74,246 at a CAGR of 11.26%, interest +$11,037, Calls +$17,464, hedge −$11,167, so shares = 74,246 − 11,037 − 6,297 = +$56,912; shares 11.26% × 56,912 ÷ 74,246 = +8.6%, Calls +2.6%, hedge −1.7%, interest +1.7%.
- **No-Call days** (the Wheel cycles' column and its No Call rows, approved by Marcelo 2026-10-27; `cycleNoCallDays.ts`, from the cycle's legs when a session is read):
  - share days = the cycle's session days with shares held while the market was open: a stock leg counts from its entry's Eastern date to its exit's, both included; shares that arrive at or after the 16:00 close (a put's assignment) count from the next session, since no Call could be sold on them that day.
  - Call days = the session days with a Call sold open at any time, from its sale's date to its expiry's, assignment's or buy-back's, both included (the Covered Calls tile's days held).
  - no-Call days = share days that are not Call days, shown "no-Call days of share days". A No Call row is a run of consecutive session days of them: its first and last days, its Session # span, the 10:00 price on its first day, the shares held on it (the most at its start or end), its length, and the stock's move = C(last day) ÷ C(the day before the first) − 1 on split-adjusted closes.
  - why no Call: a Vol Farmer session reads the 10:00 look's note on the symbol in each day's summary ("no Call passes the hedge rule …", its figure the break-even the note states, else the shares' cost); any other takes its stock-only stretches' stored counts for their days and, for days with an option open, the calls' recorded shortfalls (cash, volume, no candidate) and a ladder put sold in their place. A day counts under every reason seen; none: no reason recorded.
  - Example (R5 30% · AAPL #6): 200 shares from session 34 to 91 (58 share days); its Calls covered 34–40, 45–50, 83–84 and 89–91 (18 days), so 40 of 58, in runs 41→44, 51→82 and 85→88.
- **days with no options** (the session tile, approved by Marcelo 2026-10-28; `computeDaysWithNoOptions`, the whole account's, worked out when a session is read) = the session's trading days with no Call or Put sold open at any time of the day ÷ all of them, every symbol together. An option sold counts from its sale's Eastern date to its exit's (expiry, assignment or buy-back), both included; LEAPS and hedge Puts are bought, so they don't count. **Longest** = the most such trading days in a row, with its first and last days. A day with both a Call and a Put open counts once, so the figure is not 100% − the Calls' days held − the Puts'. Example (2bc376b1): Calls open on 57.8% of 1,712 days, Puts on 19.9%, both on 1.5%: 407 days with no options (23.8%), the longest 274 days, 3 Feb 2020 to 4 Mar 2021.

EXP $ is net of premium, as everywhere else: a put's (strike − premium) × 100 × contracts; a covered call's (share price − premium) × 100 × contracts.

Example: closed cycles of +3,806.40 and −1,200.00, one cycle still open at +500.00; Edge $ predicted 1,500 and 900 for the two closed ones: win rate 1 ÷ 2 = 50%, average win 3,806.40, average loss −1,200.00, edge capture (3,806.40 − 1,200.00) ÷ 2,400 = 1.09.

Sessions run before 2026-10-12 were measured per option (each option's own result); they keep their stored figures and say so (`pnlBasis: "option"`).

## Interest on idle cash

Each day the cash balance earns the 3-month Treasury bill rate (FRED series DTB3, the latest value on or before that day):

- interest = cash balance × rate × calendar days since the previous trading day ÷ 365

Example: $600,000 cash, rate 4.2%, Friday → Monday (3 days): 600,000 × 0.042 × 3 ÷ 365 = $207.12.

## Simulation rules

- **Stock price at 10:00**: the close of IBKR's 30-minute bar ending at 10:00 (the 09:30 bar), kept in the data file (DATA-FILES.md, "IBKR stock bars"), × the day's split factor to put it on the traded scale. Never from the option quotes (Marcelo 2026-10-14). Without that bar the day is marked at the previous close and nothing is traded; the day's summary says so.
- **Forecast**: the valuation model's forecast (Yang-Zhang over the last 21 sessions) on IBKR daily bars up to the previous close, as Pluto does live.
- **Filters and sizing**: Pluto's filters, ranking and sizing with the session's settings. Open interest is the previous day's (what Pluto sees at 10:00). Volume is the previous day's full-day volume, because the history has no volume as of 10:00. Expiries spanning a known earnings date are skipped.
- **Trade**: Pluto's deterministic top pick (the first of Pluto's own ranking of the eligible candidates). The AI model's own choice is not replayed.
- **Fill**: sale price = mid − spread cost share × (ask − bid) ÷ 2, less the commission Pluto's model uses (`optionFriction.ts`).
- **Settlement**: held to expiry and settled at that day's close. A put that ends in the money loses (strike − close) × 100 per contract; a covered call's shares are valued at min(close, strike). Version 1 does not model assignment followed by selling calls on the assigned shares, nor Pluto's buybacks and rolls.
- **Model history tables**: walk-forward by default: a session day in year Y uses tables built only from data before 1 January of Y.

## The wheel (sessions run from step 3 of FULL-FIDELITY-DESIGN.md)

Replaces the **Trade** and **Settlement** rules above: the session keeps a simulated book shaped like the platform's own (positions, legs, fills) and replays every Pluto action on it. Rules are those of FULL-FIDELITY-DESIGN.md §5–§7 (approved 2026-10-12); the rules decided while building were signed off by Marcelo the same day.

**The day, in order**

1. Options whose expiry is before today are settled at 16:00 ET of their expiry day, on that day's close (IBKR daily bar; without one, the close of IBKR's last 30-minute bar that day). With neither, the session fails and names the contract: nothing is settled on a guessed price.
2. Interest on cash since the previous session day (formula above).
3. The account is marked at 10:00. **The day's row is this mark, taken before the day's looks**: what the looks do shows in the account from the next session day. The last session day's actions are therefore in the book (positions, fills, cycles) but outside the account series and the metrics.
4. The looks inside Pluto's trading window (below): at each, Pluto's passes on that look's quotes and the book, until a pass takes no action.
5. The account is marked at the close, only as the reference of the next day's daily-loss breaker.

**Settlement at expiry**

- in the money by $0.01 or more at the expiry close → assigned; otherwise worthless.
- put assigned: 100 shares per contract enter the book at the strike (no commission); the put's premium is kept.
- call assigned: the shares leave at the strike. Call worthless: the shares stay, at their cost.

Example: 5 puts $97 sold at 3.545, close 95.40 → assigned, 500 shares in at 97. A $100 call on them sold at 1.12, close 101.00 → the shares leave at 100.

**Fills and commissions**

- option sold: mid − spread cost share × (ask − bid) ÷ 2. Option bought back: mid + spread cost share × (ask − bid) ÷ 2. $0.68 per contract each way.
- shares bought and sold at the look's stock price itself (IBKR's price at the look; the $0.01 either way removed by Marcelo 2026-10-15), plus $0.005 per share. Wherever a rule reads the stock's bid and ask, both are that price.
- every fill is at the quotes of the look it happens at; an option the look has no two-sided quote for is not bought back at that look.

Example: bid 2.80, ask 2.90, spread cost share 50%: sale at 2.85 − 0.025 = 2.825, buyback at 2.875.

**Account value** = cash + Σ (shares × the 10:00 stock price) − Σ (open short option's 10:00 mid × shares per contract × contracts). An option with no quote that day keeps its last mark.

**The decision rules that stand in for the AI model** (session settings; defaults first)

| Choice | Rule |
|---|---|
| Order in a pass | automatic closes (code, as live), then closes, then rolls, then opens; one action a pass |
| Open | Pluto's own top pick (Edge Yield, then Edge $), except one the session's own event-close rule would close at once (below; approved 2026-10-12) |
| Roll or hold | the best eligible roll by net roll $ on a leg flagged near expiry (≤ 21 DTE), at assignment risk (\|delta\| ≥ 0.5) or decayed (mid ≤ 50% of the credit) · any eligible roll · never. Never while the ticker cools down after a fill |
| Buyback offered because holding no longer pays | buy back · never |
| Round lots in profit above the floor | a call on them when one clears the break-even rule, otherwise sell them · always sell · keep (calls only) |
| Close offered before a macro event | close when the event's stress loss ≥ what is left to earn − the close cost (Pluto's own figures for the position) · never · always |
| After a choice Pluto's checks refuse | choose again at the same look, with no further open where the account has no room (below) · stop the look (Marcelo 2026-10-12) |

Every choice then goes through Pluto's own post-model gates, sizing and the order gate's limits; a refused one is stored with the gate that refused it.

**No open the event-close rule would close at once** (rules only, never with the AI model; approved by Marcelo 2026-10-12). An open that passed the gates is applied to a copy of the book, and the position it makes is read as Pluto would show it at the next pass: its held-position figures (F2) at the look's quotes, and the close before a macro event (F3) Pluto would offer it, with the close gate's cycle P&L. When that close would be offered and the session's *Close offered before a macro event* rule would take it, the open is skipped: it is left out for the rest of the look, the rules choose again (the next candidate, or nothing), and the look's summary says why ("skipped HOOD Sell $24 Call · 4 Oct (4DTE) · 24× @ 0.34: the event-close rule would close it at once before the 4 Oct Jobs report (heavy, 4 sessions away): stress loss $X ≥ what is left to earn $Y − the close cost $Z"). With the rule *never*, nothing is skipped. In practice it skips Covered Call entries whose wheel cycle is already in profit after the close cost (a call on held shares is code's since 2026-10-12, not a choice of the rules, and is never skipped), inside the 5 sessions before a release: a put sold under its mid is never offered an event buyback at once, the ask would not lock a profit.

Example: a Covered Call entry of 24 HOOD $24 calls (bid 0.33, ask 0.36, mid 0.345) on 2,400 shares at 23.31, the jobs report (heavy, k = 2) 4 sessions away, a 60% forecast (d = 0.60 ÷ √252 = 3.78%), the cycle in profit after the close cost. Stressed spot 23.31 × (1 − 2 × 0.0378) = 21.55; stress loss = (23.31 − 21.55) × 2,400 − (0.345 − 0.02) × 100 × 24 = 4,229 − 780 = 3,449 (the call worth about 0.02 after the event); left to earn = (24 − 23.31 + 0.345) × 100 × 24 = 2,484; close cost = ((0.36 − 0.345) × 100 + 0.68) × 24 + (23.31 − 23.30) × 2,400 = 76. 3,449 ≥ 2,484 − 76: the event close would be offered and taken at the next pass, so the open is skipped.

**After a refused choice (default: choose again)**. The refused candidate is left out for the rest of the look and the rules choose again. A refused **open** also ends the opens of that look where its refusal shows the account has no room:

| The refusal | Ends further opens |
|---|---|
| open-positions cap; sizing with no capital budget left or no cash above the reserve for one contract; the order gate's cash reserve | on every ticker |
| ticker cooldown; sizing with no ticker room or no sector room for one contract; the order gate's ticker concentration limit | on that ticker |
| one contract larger than the order size (a lower strike may fit; Marcelo 2026-10-12); the contract's own stress, Kelly or volume cap sizing it to zero; the order gate's maximum position size; edge drift; same contract; break-even; limit price | nowhere: the next candidate is tried |

Rolls and closes are still tried, and opens on other tickers after a ticker-level refusal. Shares in profit are not sold for want of a call while opens are ended this way: that choice waits for a later look. The day's summary says once where opens ended ("no further opens on SMCI: no ticker room").

Example: ticker limit 5% of $1,000,000 = $50,000 and $47,000 already on SMCI; one more $40 put commits about $3,950, so ticker room $3,000 holds no contract → the open is refused, no other SMCI open is tried at that look, HOOD's best contract is tried next. With an order size of $9,300 instead, a $98 put committing about $9,640 is refused alone and the next candidate is tried: a $96 put committing about $9,270 is sold.

**EXP $ of an option sold** = the new position's capital at risk, as Positions shows it: a put's strike × shares − its premium after the commission; a covered call's shares at their cost in the book − its premium after the commission. *To confirm for puts: this is $0.68 a contract above version 1's (strike − premium) × 100.*

**An option sold** (the Trades table): its facts as traded (fill, days to expiry, how it ended, its Kelly and stress caps), its position with the position's P&L, and its wheel cycle with the cycle's total (above). No P&L of its own.

Example: the $97 put above: its position (the put, assigned) P&L = 3.545 × 500 − 3.40 = 1,769.10; it was sold in cycle WHLA #1, total 3,806.40 (example below).

**Wheel cycles and per-ticker statistics** (the platform's own cycle engine on the simulated book)

- a cycle runs from the first position opened on a flat symbol until the symbol is flat again (no shares, no open option); a close and a reopening within two minutes stay one cycle, as live.
- cycle P&L: `deriveCycles`, as defined under Trades and wheel cycles.
- **put positions assigned** = put positions that ended assigned ÷ put positions that ended (assigned, expired, bought back or rolled).
- **average traded DTE** = mean calendar days to expiry of every option sold (an opening put or call, the new leg of a roll).
- **recovery sessions** = trading sessions after the day a put of the cycle was first assigned, up to the day the cycle closed. Reported for closed cycles (count, mean, median, longest); open cycles are listed apart with their age in sessions.

Example: put sold 7 April, rolled the 8th (−19.30), assigned 24 April (premium 1,769.10), call sold 28 April (556.60), called away 1 May at 100 (shares +1,500.00): cycle P&L 3,806.40, recovery 5 sessions (27, 28, 29, 30 April, 1 May).

**Splits inside a cycle**: the cycle stays on the price scale of its first day; a price traded on a later day is put on it with × F(cycle) ÷ F(day), a share count with the inverse, and an open option becomes that many more contracts on fewer of the cycle's shares each. Dollars are unaffected.

**Several symbols on one book** (step 4)

- A session takes one or more symbols; they share one cash balance and one account. Its dates must be inside the period all the symbols' data files cover.
- A session day is a date on which at least one symbol's file has a complete day. A symbol with no file day or no 10:00 price that day is not scored; its shares are marked at its previous close and its options keep their last marks.
- Each look scores every symbol, then: automatic closes for any symbol first; then one action per pass chosen across all symbols by the decision rules (closes, then rolls by net roll $, then Pluto's top pick over every symbol's eligible opens). The cooldown after a fill is per ticker. The capital budget, order size, open-positions cap, cash reserve, the order gate's limits and the actions cap are the book's; the ticker cap is per symbol and the sector cap sums the symbols of a sector (the sector on the ticker).
- Per-ticker statistics have one row per symbol and one over all symbols: counts and dollars add up; the average traded DTE and the recovery sessions are over all the options sold and all the cycles, so a symbol weighs by how much it traded.

Buy and hold with several symbols: see Baselines below.

**The put ladder** (baseline putsWhenNoCall "reserve_ladder", Marcelo 2026-10-14; floor from the average cost 2026-10-15). The shares' budget is the share level × the base and the reserve R0 the rest, with the base = the larger of the account value when the ticker's cycle started and today's (× the ticker's weight in a pots session). When held shares get no Call, Puts are sold on the reserve with the strike at most

  K_max = A − (A − F) × (U + Q) ÷ R0

- A = the cycle's break-even per share, or with ladderTop "price" the lower of it and today's price;
- F = the floor: the average cost of the shares held (weighted by the shares of each purchase or assignment, on today's price scale) × (1 − S). It follows the holdings, falling as lower rungs are assigned, and never rises with the market; with no shares held there is no floor and no rung;
- S = the stock shock, fixed for the cycle at its start: the deepest fall from a running high in the adjusted closes of the 10 years before, kept within 60–80% (90% with under a year of closes), or a fixed value;
- U = the reserve committed: shares held at cost + open Puts' collateral − the shares' budget, at least 0;
- Q = this rung's collateral: min(R0 ÷ rungs, R0 − U).

Example: break-even $100, shares' average cost $104, S 70% (F = $31.20), R0 $100,000 in 5 rungs, nothing committed: K_max = 100 − 68.80 × 0.2 = $86.24. A rally to $150 leaves F at $31.20. After an assignment, with $15,000 committed, the average cost down to $98.20 (F = $29.46) and the break-even to $95.50: 95.50 − 66.04 × 0.35 = $72.39.

**The hedge** (baseline hedgePutTenorDays > 0, Marcelo 2026-10-22; off by default; backtestBaselineHedge.ts). Long Puts (strategy HDG) bought on the shares an entry brings in: a Covered Call entry's at the same look, a Cash-Secured Put entry's at the look after its assignment. When a ladder rung is assigned, as many hedge Puts are sold as the rung's contracts, oldest first, to lock in their gain. The cash comes from the free cash; the share level, shock and rungs are unchanged.

- Puts for an entry = floor(ratio × the cycle's entry lots so far) − the Puts already bought for its entries; ratio = hedgePutCoveragePct ÷ 100 at share level, × min(1, (1 − s) ÷ (s × (rungs − S))) at rung level (one rung's contracts at its cap ÷ the lots of the shares' budget). Example: s 60%, 2 rungs, S 70% → 0.4 ÷ (0.6 × 1.3) = 0.51; 600 shares → 3 Puts.
- Expiry: the listed one nearest hedgePutTenorDays (a tie: the later) or the first at or after them, more than hedgePutRollDaysLeft days out. Example: on 2021-11-01 NFLX listed 81, 109, 137, 228, 319 and 445 days out: 360 days → 319 (nearest) or 445 (first at or after).
- Strike: the listed strike nearest price × (1 − hedgePutBelowPricePct ÷ 100) with a usable quote (bid ≥ $0.05, ask above it, spread ≤ maxSpreadPctOfMid) and no short option on it; the price is the stock price at the purchase, or with hedgePutStrikeFrom "price_paid" the assigned strike.
- Fills: mid + λ × half-spread bought, mid − λ × half-spread sold (λ the session's spread cost share); $0.68 a contract each way; no volume limit. A leg's entry = fill + commission ÷ shares; P&L = (sale fill − entry) × shares − the sale's commission. Open Puts are marked at the 10:00 mid of their expiry and counted in the account value.
- Shares leaving (a Call assigned, shares sold): the Puts above floor(ratio × the lots still held) are sold, oldest first; all of them once no share is held. A sale that leaves the ticker flat ends its cycle: the next entry waits for the next look.
- Near expiry: a Put with hedgePutRollDaysLeft days or fewer left is sold and, while shares are held, as many bought again on the rules above, the strike from the stock price. One still held at its expiry (no quote at any look) is settled on the expiry close: sold at strike − close without commission in the money, worthless otherwise.
- hedgeInBreakEven "included": the cycle's break-even and cash break-even count the realized P&L H of the hedge Puts sold in the cycle: (acquisition cost − net premium − H) ÷ shares acquired, and (… − disposals − H) ÷ shares held. A look's hedge sales come before its Calls and ladder Puts, so their gain is in the floor those see. "excluded" (the default, as live): the hedge stays out.
- Fewer purchases (hedgePutTurnover, Marcelo 2026-10-22; D = hedgePutTurnoverDays, 30 by default). "sell_when_shares_leave" (the default) is the rule above.
  - "keep_for_next_entry": the Puts the shares leaving would sell are kept instead. They leave the cycle at their 10:00 mark (no trade, no cash; the cycle realizes its P&L up to the mark and shows "Put kept for the next entry") into a position of no cycle, so the cycle ends as it would without them. An entry takes kept Puts first, the longest kept first, at the price they were kept at ("Put from the kept ones"), and buys only what is missing. Kept Puts are sold once D days have passed with no entry taking them, at hedgePutRollDaysLeft days or fewer to expiry, and at the look before a split; their P&L from the kept price is in no cycle (the run note totals it). A cycle that spans a split sells its Puts instead of keeping them, so kept Puts never change price scale. Example: 6 Puts kept at a $70 mark; an entry of 4 lots a week later takes 4 at $70; an entry of 4 more the next day takes the other 2 and buys 2.
  - "keep_unless_far_below": the same, but an entry sells a kept Put struck below its strike reference × (1 − hedgePutFarBelowPct ÷ 100) instead of taking it, and buys at-the-money Puts for the gap. Example: kept $690 Puts, a new entry at $800 with 10%: the floor is $720, so they are sold and $800 Puts bought.
  - "wait_between_purchases": an entry's Puts are bought only once D days have passed since the symbol's last Put purchase (an entry's or a roll's), and then no more than floor(ratio × the lots then held) − the Puts held; an entry whose shares are gone by then gets none. Rolls are never held back. Example: Puts bought on 1 Nov; an entry on 11 Nov gets its Puts on 1 Dec if its shares are still held.
- The whole position (hedgePutCovers "position", Marcelo 2026-10-23; "entries", the default, is everything above). The Puts cover the shares held plus the shares the open short Puts would bring (the entry's and the ladder's rungs), so they are in place before an assignment, not after. Hedge: size, strike from and fewer purchases don't apply; the strike is set from the stock price.
  - Puts wanted = floor(hedgePutCoveragePct ÷ 100 × (lots held + lots of the open short Puts)), as traded today. Example: 600 shares and 2 short Puts → 8 Puts.
  - Bought at every look, before the sale steps and again after them, when fewer are held: first the kept Puts (only while the cycle is on today's scale), then new ones. Nothing is sold when a rung is assigned or shares leave: a Put beyond the position's size waits for its roll.
  - Staggered expiries: n = hedgePutStaggeredExpiries slots of width w = (T − hedgePutRollDaysLeft) ÷ n, T = hedgePutTenorDays. Slot k holds the Puts with (T − (k + 1)·w, T − k·w] days left (more than T: slot 0) and is owed floor(wanted ÷ n), plus one for k < wanted mod n. Each Put missing goes to the slot furthest below what it is owed (a tie: the longer expiry) and is bought on the listed expiry nearest T − k·w days. Example: 360 days rolled at 90 left over 3 expiries (w = 90), 8 Puts wanted and none held: 3 at about 360 days, 3 at 270 and 2 at 180, so a third of them rolls each quarter.
  - Near expiry: a Put with hedgePutRollDaysLeft days or fewer left is sold; what the position is then missing is bought on the rule above. At the look before a split every hedge Put is sold, and the position's Puts are bought at the next session on its scale.
  - Strike by delta (hedgePutStrikeBy "delta", Marcelo 2026-10-23; either coverage): of the expiry's Puts with a usable quote and no short option on them, the one whose own |delta| is nearest hedgePutAbsDelta: the IV of its mid, then Black-76 on the forward S·e^{rT}, T = days to expiry ÷ 365 (a tie: the higher strike). Example: $100 stock, 1 year, r 0, Puts at 40% IV: |delta| 0.224 at $80 and 0.272 at $85, so 0.25 buys the $85.
  - No purchase while too dear (hedgePutPriceGate, Marcelo 2026-10-23; either coverage): the Put chosen is not bought, and is tried again at the next look, when
    - "cost_vs_typical_fall": its yearly cost mid ÷ S × 365 ÷ days to expiry > hedgePutCostFallShare × F; F, the typical yearly fall = the median, over the windows of 252 daily closes ending every 21 sessions back within the last 1,260 before today, of the deepest fall from a running high in each (no gate with fewer than 252 closes). Example: $12 for a 1-year Put on a $100 stock = 12% a year; F 40% and 0.3 → limit 12%: bought.
    - "iv_vs_history": the Put's IV > hedgePutIvMultiple × the median of the stock's daily IV (IBKR's) over the last 252 sessions with one before today (no gate with fewer than 126).
    - "iv_vs_realized": the Put's IV > hedgePutIvMultiple × σ21, the sample standard deviation of the last 21 daily log returns before today × √252.
    - Puts held are kept; a measure that can't be worked out blocks nothing; the day's notes say once a day that a purchase was held back.
  - No share and no short Put left: the Puts leave the cycle at their mark as kept ones (as with "keep_for_next_entry"), so the cycle ends and the next entry waits for the next look; sold instead when the cycle is on another scale than today's. Kept Puts are sold at hedgePutRollDaysLeft days or fewer to expiry and at the look before a split, not after D days.

**Per-ticker pots** (the baseline deciding; approved by Marcelo 2026-10-15). A session's `book_mode` is "pots" for every new session the baseline decides, "shared_account" for the rules, the AI model and every earlier session (which re-run unchanged).

- **Pots and weights**: each ticker has a pot in dollars. A starting value given splits equally (pot = starting value ÷ tickers); without one, a ticker's pot is the request's, else its saved lab pot (settings source "per ticker"), else the lab's default pot. Session capital = Σ pots; weight w_i = pot_i ÷ Σ pots, fixed for the session.
- **One account**: the tickers share one cash balance, one account value and its interest; the pots exist only through the weights.
- **The ladder's base**: base_i = w_i × max(the whole account at the start of ticker i's cycle, the whole account today); its shares' budget = p_i × base_i and its reserve = (1 − p_i) × base_i, with p_i the ticker's share level. U and Q are the ticker's own. With one ticker w = 1: the same as a shared account.
- **The ticker's values**: the share level, rungs, shock (history or fixed, its %, min and max) and |delta| range can differ by ticker; every other value is the session's. A value is, last one given winning: the lab's global value < the ticker's lab value ("per ticker") < the request's session-wide override < the request's value for the ticker. The session stores each ticker's pot, weight, values and where each came from.
- **Turn order**: at every look the tickers take their turn alphabetically (the order given in a shared account), so when the cash runs short the later tickers are the ones cut, the same way every time. The session reports, per ticker, the looks and days at which the cash cut one of its orders.
- Example: pots HOOD $150,000 and SMCI $50,000 → capital $200,000, w = 0.75 and 0.25. With the account at $240,000 today (above its $200,000 at the cycles' start) and both at 50% shares: HOOD's base $180,000 → shares' budget $90,000 and reserve $90,000; SMCI's base $60,000 → $30,000 and $30,000.

**The baseline's IVs and deltas** (Pluto's forward, approved by Marcelo 2026-10-15, so live and the backtest compute the same): each expiry's forward is anchored once a day, at the first look that quotes it (10:00 in practice), as F₀ = the put-call parity forward of that look's quotes for the expiry, else S₀ × e^(rT); at every later look that day F = F₀ × S ÷ S₀ (sticky moneyness, `forwardAtSpot`), with S the look's stock price. Each contract's IV is Black-76 on its mid with that F; its delta is Black-76's with that F and IV. Example: at 10:00 S₀ = $100.00 and parity gives F₀ = $100.40; at 13:00 with the stock at $103.00, F = 100.40 × 1.03 = $103.41.

**Order records** (Marcelo 2026-10-15; recorded only, no decision reads them). Each baseline order (the calls on the free lots, the entry with the free cash, a ladder put, a put on the DTE budget) records:

- on each of its sales: **wantedContracts**: calls on free lots = the free lots; the entry = the lots the room holds (the shares' budget, the per-stock cap), or what the cash pays for when neither caps it; a ladder put = the rung's collateral ÷ (the best put's strike × 100), rounded down; a DTE-budget put = its budget's contracts at the best put. **rank** = the sale's place in the order's ranking, from 1; **bestCandidate…** = the first contract in the ranking not already held when the order starts (strike, DTE, premium yield, volume limit = floor(20% × the previous session's volume)); on a Call order, **sharesAverageCostBefore** = the average cost of the shares held when the order starts, on today's price scale (null when none are held), and **stockPriceAtLook** = the look's stock price, the price new shares are bought at;
- when it leaves contracts unsold, a shortfall row: wanted, filled, unsold (a ladder put: the collateral left ÷ (the best put's strike × 100)) and the reason: **cash** (the cash allowed fewer contracts than the room and the volume limit, at any contract it tried), else **volume** (the contracts within the rules ran out, each to its volume limit or already held), else **no_candidate** (none within the rules). Looks that found no candidate are kept one row per day, ticker and order, with their count.
- Example: a rung of $20,000 with the best put at $40 wants 5 contracts; its volume limit is 3, the next put ($39) fills 2 → 5 filled, no row. With a volume limit of 3 and no other put: 3 filled, a row with 2 unsold (volume).

**Looks inside Pluto's window** (step 5)

- **When**: the half hours the data files hold quotes for (10:00, 10:30 … 15:30 ET) from the session's window start through its window end, the end never later than 30 minutes before the day's close (12:30 on a 13:00 day). With the window 10:00–15:30: 12 looks on a full day, 6 on a 13:00 day. The quotes stored after an early close repeat the close and are never read.
- **Which symbols**: a symbol is looked at after 10:00 only on the days its file has intraday quotes; otherwise it gets the 10:00 look only (the session's notes count those days). A symbol without quotes or an IBKR price at a look is left out of that look.
- **Stock price at a look**: the close of IBKR's last 30-minute bar ending by the look (10:30 reads the 10:00 bar), × the day's split factor, as at 10:00.
- **Scoring at a look after 10:00**, as live scores between two captures:
  - the surface stays the 10:00 fit and follows the stock by sticky moneyness: each expiry's forward × (look price ÷ 10:00 price);
  - the look's quotes replace the 10:00 quotes of every captured contract, and add the contracts the capture's strike window takes at the look's price; a contract the look does not quote on both sides keeps its 10:00 quote, which Pluto's quote-age rule (10 minutes) then refuses;
  - **IV shift of an expiry** = median over its out-of-the-money quotes at the look (two-sided, spread ≤ 50% of the mid, at least 5 of them) of (the mid's IV − the surface's IV); it is added to the surface for that expiry, and an expiry whose shift exceeds the Max IV shift setting is refused. Example: surface 60%, the look's mids at 75% → shift +15 points > 8 → the expiry is refused at that look;
  - the valuation's clock is the look's instant (less variance left; a macro release earlier that day is over);
  - **day change** = look price ÷ previous close − 1: the Max day move rule and the stress add-on to sizing read it.
- **Marks**: each look re-marks the legs of the symbols it prices (shares at the look's price, options at the look's mids) for the checks and the sizing; the day's row stays the 10:00 mark.

**System checks at each look** (in Pluto's order)

1. **Daily-loss breaker** (approved by Marcelo 2026-10-12): day loss % = (account at the look − account at the previous session's close) ÷ account at the previous session's close × 100. At −(Daily-loss breaker %) or worse, nothing more is done that day. Live, a human resets the breaker: assumed done before the next open. The session counts the days it tripped.
   - account at the close = cash + shares × the IBKR close − short options × the mid of their closing quotes; an option expiring that day counts at its intrinsic value at the close; on the first day the reference is the starting value.
   - Example: $1,004,000 at the previous close, $972,900 at the 10:30 look → −3.10%; breaker at 3% → tripped at 10:30, the looks from 10:30 on are not run.
2. **Actions cap**: orders filled so far that day, over all its looks and symbols, against Max orders per day.
3. **Market stress** (approved by Marcelo 2026-10-12): SPY day change % = (SPY at the look − SPY's previous close) ÷ SPY's previous close × 100, from IBKR's 30-minute bars of SPY's regular session (the close of the bar ending at the look; the previous close is the previous session's last bar). At −(Market stress %) or worse, no new open is sent at that look; rolls and closes are. It lifts by itself at the next look where SPY is above the line. Example: previous close 500, 480 at 10:00 → −4% ≤ −3% → opens barred at 10:00. A day without SPY bars is not checked, and the session's notes say how many.
4. **Ticker cooldown**: minutes since the ticker's last fill, on the looks' own instants: with 60 minutes, a fill at 10:00 keeps the ticker out at 10:30 and lets it back at 11:00.

**Macro events**: the Fed rate decisions (14:00 ET), CPI, GDP and the jobs report (08:30 ET) and US federal elections from 2019 on, from the sources the live calendar reads (FRED's release dates, the Federal Reserve's FOMC pages, the election rule), cached in the data folder (`macro-events.json`). On a day, Pluto sees the events dated from that day to 90 days ahead, as the live calendar holds them. They flag the candidates whose expiry spans one and drive Pluto's closes before an event (offered from 5 sessions before the release, only at a profit), which the *Close offered before a macro event* rule takes or leaves. The dates are the final ones: a release that was moved is known at its final date from the start, and a meeting that was scheduled and then cancelled (17–18 March 2020) is absent, as unscheduled meetings are.

**Creating a session**: refused when a symbol's file has weekdays with nothing stored inside the session's dates (a download not finished): "INTC's file has 828 weekdays missing between 2021-09-13 and 2024-11-13: finish its download or shorten the period". Holidays and the days the downloader recorded as unavailable are not gaps. Days without intraday quotes do not stop a session: the answer carries a warning with their count.

**Not replayed, and what follows from it**

- **Earnings dates known 30 days ahead** (Marcelo 2026-10-12): the stored calendar holds every report of the period, but a day sees a report's date only from 30 calendar days before it. Signals' exclusion of expiries spanning a report, the next-earnings date and Pluto's closes before earnings all read only the dates known that day. Example: on 2 March a report on 1 April (30 days) is known, one on 2 April (31 days) is not. Whether a ticker's earnings calendar counts as resolved is the ticker's, as live (`tickerCalendarProfile`).
- What happens between two looks: Pluto looks every 30 minutes, not at every Day Signals update, and an order fills at once at the look's quotes.
- A human's hand: the breaker's reset is assumed, the market-stress override is never used.
- Early assignment and dividends.

## Vol Farmer (decision maker `vol_farmer`, approved by Marcelo 2026-10-23)

Shares, one Covered Call on every lot and one long Put per lot. Prices as traded at the 10:00 look; S = the look's stock price (the close of IBKR's 30-minute bar ending at 10:00).

- **Hedge rule** (a Call strike K and a Put qualify together): (K − share cost) + (Pₓ(K) − Put cost − sale commission) + the cycle's realized Put P&L ≥ 0, per share. Call premiums are left out.
  - share cost = S plus the stock commission (a new cycle), or what the cycle's shares cost, commission included.
  - Pₓ(x) = the Put's Black-Scholes value with the stock at x on the Call's expiry day: its own IV (from its mid, forward S·e^{rT}), time left = its expiry − the Call's, never below intrinsic.
  - Example: S 100, $103 Call 7 days out, $100 Put 45 days out bought at 8.12, IV 60%, r 4%: Pₓ(103) = 6.22 (38 days left), so (103 − 100.005) + (6.22 − 8.1268 − 0.0068) = +1.08 ≥ 0: passes.
- **Protection** = (Pₓ(S × (1 − f)) − Put cost − sale commission) ÷ (S × f), f = the fall setting (20%). Of the Puts that pass, the highest protection (a tie: the cheaper). Puts tried: expiries on or after the Call's, within the Puts' days-to-expiry range (0–360), strikes up to S × (1 + cap%) (cap 0: at or below S; −5: at least 5% below S), bid ≥ $0.05, spread within the limit.
- **Call**: OTM, in the |delta| (0.05–0.30) and days-to-expiry (1–45) ranges, by premium yield; the first that passes the hedge rule (with the Put held, or with some Put) and whose volume limit (20% of the previous session's volume) covers every lot, else the one covering the most.
- **Lots** at a cycle's start = floor(free cash × (1 − reserve%) ÷ (100 × S + stock commission + 100 × the Put's fill + one contract's commission)), reserve 10%: the later Puts are paid from it and the Calls' premiums.
- **Crossing**: the first 30-minute bar after the Call's sale whose high reaches K. Shares sold at K (at the bar's open if it opened at or above K), the Call bought back and the Put sold at their Black-Scholes values at that price, on each one's IV from its last look, T from the bar's middle (its start on a gap); commissions, no spread. The next cycle starts at the next day's 10:00 look.
- **Call expires below its strike**: the next Call at the next 10:00 look, with the Put held (the Call expiring on or before it), or with a new Put when it has expired. Puts are held to expiry (settled at intrinsic value), never rolled.
- **Lots left without a Call and a Put** (the volume or the cash): their shares are sold at S only where S is above what they cost (commission included), with the Puts no Call covers; otherwise kept and tried again at the next 10:00 look.
- Every 10:00 trade fills at the session's fill rule; $0.68 a contract, $0.005 a share.
- **The hedge in Wheel cycles** (approved by Marcelo 2026-10-23; display only, the cycle's figures unchanged): at every hand-over of the shares (to N/S when a Call expires, back to CC when the next Call is sold) each Put held from before is marked at that day's close: its end-of-day mid, else its last trade, else its intrinsic value. Its row's net premium = (the mark − its last mark) × shares-equivalent, the first last mark being its cost with commission; its purchase row shows no net premium; its sale, settlement or open mark row shows what it brought less the last mark × shares-equivalent; a Put that expires worthless gets a row at its expiry of − the last mark × shares-equivalent. COIN #1 ($310 Put bought @ 51.40): +$9,088.64 at the 21 May close ($96.85), −$480 (24 May, $94.45), −$3,800 (2 Jul, $75.45), −$1,730 (7 Jul, $66.80), −$2,290 (20 Aug, $55.35), +$1,892 at the 17 Sep settlement (64.81): +$2,680.64, the Put's result as before.
- **The hedge's yearly cost in Wheel cycles** (approved by Marcelo 2026-10-26; display only, any session with hedge Puts): a hedge Put's purchase row shows −(time value × 100 + one contract's commission) ÷ (stock price × 100) ÷ (days to expiry ÷ 365) "a year", from the stock price, fill and days its purchase recorded; time value = fill − max(strike − stock price, 0); at least one day; contract-weighted over a day's purchases of the contract. A Call's "a year" on its sale row is its premium yield: (time value × 100 − one contract's commission) ÷ ((stock price − fill) × 100) ÷ (days ÷ 365). Example (HOOD, 6 Aug 2021, stock 57.81): the $55 Put · 19 Nov (105DTE) bought @ 16.30 shows −(1,630 + 0.68) ÷ 5,781 ÷ (105 ÷ 365) = −98.1% a year; the $72 Call · 13 Aug (7DTE) sold @ 2.875 shows (287.50 − 0.68) ÷ 5,493.50 ÷ (7 ÷ 365) = 272.2% a year.
- **Research settings** (2026-10-24, not yet signed off; the defaults keep every rule above):
  - `crossing` "hold_to_expiry": no crossing scan. A Call in the money at its expiry is assigned (its shares go at K), and the Put left without shares is sold at the next 10:00 look at the session's fill rule (or settles with the Call when it expires that day).
  - `putExpiry` "with_the_call": Puts tried = only those expiring on the Call's own expiry; the days-to-expiry range is not read. Each Put settles at intrinsic value with its Call, and that P&L enters the hedge rule's realized Put P&L for the cycle's next Call.
  - `hedgeRuleCallPremiums` "included": hedge rule = (K − share cost) + (Pₓ(K) − Put cost − sale commission) + the cycle's realized Put P&L + the cycle's realized Call P&L ≥ 0, per share; Call P&L = the option legs of the cycle's Covered Call positions (premiums kept, buybacks paid, commissions).
  - `minPutProtectionPct` m > 0: a Put passes only when its protection ≥ m ÷ 100.
  - `hedgeWithoutCall` "put": shares held with no Put and no Call sold at the look buy the Put at the highest strike up to S × (1 + cap%) of the nearest listed expiry 7 or more days out (bid ≥ $0.05, spread within the limit), on min(lots held, floor(free cash ÷ (100 × fill + one contract's commission))) contracts.
  - `maxPutCostPctOfCallPremium` b > 0: a Put passes only when its fill ≤ the Call's fill × b ÷ 100 (b = 100: a zero-cost collar; the most protection within the budget, as before).
  - `putRoll` "when_no_call": at a 10:00 look with Puts held and no Call that passes with them, banked = Σ (sale fill − entry) × 100 × contracts − commission over the Puts held; the usual choice of a Call with a new Put runs with realized P&L + banked in the hedge rule and free cash + the sale's proceeds; if it finds a Call, the Puts are sold, the Call sold and the new Put bought, otherwise nothing is traded.
- **Cheaper hedges** (approved by Marcelo 2026-10-26; research settings, the defaults unchanged):
  - `putChoice` "cheapest_per_year": of the Puts that pass the hedge rule and offer at least `minPutProtectionPct`, the lowest cost per year = (time value × 100 + one contract's commission) ÷ (stock price × 100) ÷ (days to expiry ÷ 365), time value = fill − max(strike − stock price, 0); a tie goes to the more protection. `minPutProtectionPct` applies to every Put choice, rule 3's rolls included, so a roll can't step the hedge below it. Example (HOOD, 6 Aug 2021, stock 57.81, floor 30%): 4 Puts offer 30%, the $55 strikes of 19 Nov (98% a year), 17 Dec (82%), 21 Jan (68%) and 18 Feb (61%): the 18 Feb $55 is taken; with a 25% floor the 20 Jan 2023 $50 (24% a year, 25.1% protection).
  - `hedgeWithoutCall` "cheapest_per_year": shares held with no Put and no Call sold at the 10:00 look (above all, once the Put has expired) buy the Put `putChoice` takes among the Puts tried, with no hedge rule and protection measured to the next listed Call expiry, on min(lots held, floor(free cash ÷ (100 × fill + one contract's commission))) contracts.
- **VF4 rules** (signed off by Marcelo 2026-10-26; research settings, the defaults unchanged). Terms for the open cycle (from its first share purchase): N shares held, cost = what they cost with commission; Rs, Rh, Rc = its realized P&L so far on shares (sold or called away), on Puts and on Calls, commissions included; the open Puts: n contracts at c each (entry with commission).
  - `hedgeRuleStockPnl` "included" (rule 1): the hedge rule adds Rs: (K × N − cost) + Rs + (Pₓ(K) × 100 × n − c × n − sale commission) + Rh ≥ 0. Calls left out. Example: 100 shares at 100.005, a $105 Call, a $95 Put bought at 4.00 and modelled at 2.10 at $105 on the Call's expiry: (105 − 100.005) × 100 + (2.10 − 4.00) × 100 − 0.68 = +308.82: passes.
  - `callExpiry` "next" (rule 5): Calls tried = the OTM Calls of the next listed expiry after today (|delta|, spread and volume as before; the days-to-expiry range is not read), by premium yield, the first that passes rule 1. None passes: no Call that day, the shares and Puts kept, tried again at the next 10:00 look.
  - `crossing` "unwind_if_net_positive" (rule 2): at the crossing, net = (S × N − cost) + Rs + (v × 100 × n − c × n) + Rh + (q − b) × 100 × N ÷ 100 + Rc − the unwind's commissions, at the unwind's prices (S the crossing price, v and b the Put's and the Call's Black-Scholes values, q the open Call's sale net of commission). Net > 0: unwound, the cycle ends. Otherwise everything is held and the same net, at each later look's fills (the shares at the look's price, the Call bought back and the Puts sold at the session's fill rule), is checked at every look to the Call's expiry; the first look where it is above 0 unwinds at those fills. A look without a quote for every leg is skipped. Example: the Call sold at 1.20 costs 2.50 to buy back and the Put sells at 2.60: 499.50 − 130 − 140 − ~2 = +$227: unwound.
  - `hedgeAfterExpiry` "sell_if_in_profit" (rule 3): at a 10:00 look after the cycle's last Call expired below its strike, Puts held whose sale at the fill rule banks (fill − entry) × 100 × contracts − commission > 0 are sold only together with a new Call and a new Put that pass rule 1 with the gain in Rh (the roll of `putRoll`, tried first). No such pair: the Puts are kept and the Call chosen with them as usual.
  - `afterAssignment` "continue_if_under_water" (rule 4): at the next 10:00 look after the shares were called away, Rs + Rh + Σ (fill − entry) × 100 × contracts − commission over the Puts held, at the fill rule (Calls left out). Above 0: the Puts are sold and the cycle ends. Otherwise the same shares are bought back at S (as many lots as the free cash pays for; none: the Puts are sold), the Puts kept, and a Call that passes rule 1 is sold on them at the same look (none passes: tried again at the next 10:00 look). Example: called away at $105 (Rs = +499.50), a Put bought at 9.00 now bids 1.50: 499.50 + 150 − 900 − 0.68 = −$251: 100 shares bought back at Monday's 107, the Put kept.
- **Hedge cash-in** (approved for testing by Marcelo 2026-10-26; research settings, the defaults unchanged):
  - `putCashIn` "when_no_call": at a 10:00 look with shares and Puts held that sells no Call (rule 3's roll and `putRoll` tried first), each Put whose sale at the fill rule banks (fill − entry) × 100 × contracts − commission > 0 is sold. Its gain is then in Rh, so from the next look rule 1 asks a Call's strike to reach a breakeven lower by gain ÷ N: share cost − (Rh + Rs) ÷ N, which the decision notes show ("so the shares break even at …"). The lots left without a Put get the `hedgeWithoutCall` Put at the same look; a Put that would not sell at a gain is kept. Example (AAPL, 600 shares at 256.63, floor 50%): seven cash-ins from 11 Mar to 9 Apr 2025 banked +$13,804, so with the cycle's earlier Puts (+$21,397 in all) the shares break even at 256.63 − 21,397 ÷ 600 = 220.96, and the $240 Call sold on 11 Aug 2025 with AAPL at 226.04 passed rule 1, $16.63 below what the shares cost.
  - `cashInPutMinProtectionPct` m: with `hedgeWithoutCall` "cheapest_per_year", the Put bought after a cash-in offers protection ≥ m ÷ 100 (0 = any); every other Put keeps `minPutProtectionPct`.
  - The Wheel cycles table's B-E in a Vol Farmer session (Marcelo 2026-10-27) is the breakeven rule 1 reads: (cost of every share bought in the cycle − what the shares that left brought in − Rh) ÷ shares held, Rc taken off too only where `hedgeRuleCallPremiums` is "included"; at a Call's sale, the value just before it. AAPL (50% floor): the $240 Call of 11 Aug 2025 shows 220.96, as its decision note.
- **No hedge** (research, Marcelo 2026-10-27): `hedge` "none" buys no Put and reads none of the Put settings. Steps 1 and 2 take the Calls by premium yield, the first whose strike passes rule 1 on the shares alone, (K × N − cost) + Rs (+ Rc where included) ≥ 0, and whose volume covers every lot; a new cycle's lots = floor(free cash × (1 − reserve%) ÷ (100 × S + stock commission)). Crossings, expiries and assignments as above, with no Put to sell or keep. Example: $100,000 at S 100, reserve 10%: floor(90,000 ÷ 10,000.50) = 8 lots; after the Call expires with the stock at 95, only strikes at or above the shares' 100.005 pass.

## Vol Farmer v2 (decision maker `vol_farmer_v2`, research; rules from Marcelo 2026-10-27)

Two Covered Calls at different price levels and a LEAPS Call; no protective Put. At the 10:00 look only, or at every look with Decides at every look (below), one ticker a session; prices as traded, S = the look's stock price. The rules are in `src/backtest/engine/volFarmerV2Steps.ts`, shared with Pluto.

- **Pot** P = the free cash when a cycle starts (nothing held); no reserve. Half for the first position, half for the Puts.
- **First position**: lots = floor(P ÷ 2 ÷ (100 × S + 100 shares' commission)), fewer where the Call chosen for them (by the Call rules below, at or above what the shares cost) has a smaller volume limit; bought at S with that Call sold on them (no such Call: no cycle, tried again at the next 10:00 look). B-E1 = (what its shares cost with commission − its Calls' premiums net of commissions) ÷ its shares.
- **Calls** (each position holding shares with no Call open, on every lot): of the next listed expiry after today, OTM, inside the Vol Farmer's |delta| range (0.05–0.30) and spread limit, bid ≥ $0.05, strike ≥ the position's break-even, by premium yield; the first whose volume limit (20% of the previous session's volume) covers every lot, else the one covering the most. Held to expiry: in the money there, the shares are called away. Both positions choosing the same contract sell it as one order, the premium split by contracts.
- **Puts** at a look where the first position holds shares and needs a new Call (none open when the look begins; an open Call defers the check to its expiry, Marcelo 2026-10-27), the second holds none and has no Put open, and the best Call the first position could sell yields under Puts start under, % a year (`putsStartCallYieldPct`, 5; no Call: 0%): the Puts of the same next expiry with |delta| ≤ the Put |delta| (`putMaxAbsDelta`, 0.20) and strike ≤ B-E1 × (1 − Step ÷ 100) (the Step: see the Step rule below), spread and volume as the Calls', by premium yield; contracts = min(floor(P ÷ 2 ÷ (100 × strike)), floor(free cash ÷ (100 × strike)), the volume limit). Held to expiry; one that expires worthless is followed at the next look where the trigger holds.
- **Step rule** (`stepRule`, Marcelo 2026-10-27): `fixed` (the default) is the Step setting (`stepBelowFirstBreakEvenPct`, 15). `implied_move_at_put_sale` sets it at each look that sells Puts to the one-month implied move, Step = IV × √(21 ÷ 252) × 100, IV being IBKR's 30-day implied volatility (`daily_price_bars.implied_volatility`) of the latest daily bar dated before the look's day, of the last 10 sessions; none in those 10: the fixed Step. Example: IV 60% → Step = 0.60 × 0.2887 × 100 = 17.3%, so with B-E1 at $100 the Put's strike is at most $82.68. It writes the Step and its IV into the Put's reason and its `candidateScores` (`stepPct`, `stepImpliedVolatility`); the fixed rule writes neither.
- **Second position** = the assigned Put's shares: B-E2 = strike − (the premiums net of commissions of every Put sold for it, those that expired included, + its Calls') ÷ its shares. Its Calls as above; once it is called away, Puts may start again.
- **LEAPS** (`leapsMinDte` 365, `leapsAbsDelta` 0.70, stage 1 of the research, Marcelo 2026-10-27): when the second position holds shares, no Call at or above B-E2 passes the Call rules and it has bought no LEAPS since it got them: of the 10:00 Calls of the first listed expiry at least 365 days out (bid ≥ $0.05, spread within the limit), the one whose |delta| (Black-Scholes on its own IV from its mid, forward S·e^{rT}) is nearest 0.70; contracts = min(floor(B ÷ (100 × fill + one contract's commission)), the contracts its 10:00 ask offered), B = min(free cash, the LEAPS cap `leapsMaxAccountPct` % × the account's value at the look, positions marked) (Marcelo 2026-10-27; 0: no cap, B = the free cash). Example (MSTR, 27 Oct 2025, cap 10%): account $363,289, free cash $96,142: B = min(96,142, 36,329) = $36,329, floor(36,329 ÷ 10,250.68) = 3 contracts of the $260 Call · 18 Dec 2026 at 102.50 (Marcelo 2026-10-27: long-dated Calls trade rarely but are quoted deep; no size shown: none bought that look); tried at each look until bought. Top-up (Marcelo 2026-10-27): the purchase fixes the intended count N = floor(B ÷ (100 × fill + one contract's commission)); bought short of N (the ask's size here, a partial fill in Pluto), each later look while the second position holds its shares buys min(N − held, floor(free cash ÷ (100 × fill + one contract's commission)), the contracts its ask offers) of the same contract, until N are held (SLV, 11 Dec 2023: N = 35, 20 offered; 15 more on 12 Dec). Sold whole, every purchase in one order, at the next look after the second position is called away, the first moment the call-away is known (the session's fill rule); held to its expiry, settled at max(close − strike, 0). Example (AAPL, 27 Dec 2022): the $115 Call · 19 Jan 2024 at 29.80 with $29,763 free: floor(29,763 ÷ 2,980.68) = 9 contracts, under the 684 offered.
- **Decides** (`looks`, Marcelo 2026-10-27, as Pluto runs it): `first_look` (the default) applies every rule at the 10:00 look only; `every_look` at each 30-minute look, on that look's quotes and stock price (the LEAPS on that look's long-dated Calls and their ask sizes), so a cycle can open, a Call or Put be sold and a LEAPS be bought or sold at any look. A day's note then names only the looks that acted.
- **LEAPS records** (Marcelo 2026-10-27: Hedge = protective Puts, every long Call a LEAPS): a strategy of its own, `leaps` (orders `buy_leaps` and `sell_leaps`). In Wheel cycles its rows and P&L are the `leaps` bucket, left out of the break-even as the hedge's are; a LEAPS position's capital at risk and capital deployed = its premium paid with commission, as a hedge's; the session tiles' LEAPS part = Σ the cycles' `leaps` premium. AAPL 2022 to mid-2023: bought 9 @ 29.80 ($26,826.12 with commission), sold @ 39.125 after the call-away: +$8,380.26.
- **Example**: P = $100,000, S = $240: the first position buys floor(50,000 ÷ 24,000.50) = 2 lots, 200 shares for $48,001. With B-E1 at $236 after a fall to $200, no Call at or above $236 yields 5% a year, so Puts are struck at most 236 × 0.85 = $200.60: floor(50,000 ÷ 19,500) = 2 contracts of the $195 Put. Sold at 1.50 and 1.20 (both expired worthless), then at 1.10 and assigned: B-E2 = 195 − (760 − 3 × 1.36) ÷ 200 = 191.22.

## Baselines (comparison only)

Two buy-and-hold series run beside every session, marked at 10:00 each session day and measured with the same formulas as the session (return, CAGR, Sortino, drawdown, worst month). They are for comparison only: nothing in the session depends on them. Neither counts dividends.

**Buy and hold of the session's symbols**: each symbol's pot in a pots session, else the starting value in equal parts, one per symbol; each part buys whole shares at its symbol's first 10:00 price in the session and is never rebalanced; what is left stays in cash at the same interest as the session. Value on a day = cash + Σ shares × the day's 10:00 price × F(purchase day) ÷ F(day) (split scale). With one symbol: as many whole shares as the starting value allows.

Example: $1,000,000 over SMCI at 40.00 and HOOD at 25.00 → 12,500 SMCI and 20,000 HOOD shares, nothing left in cash.

**Buy and hold of SPY** (Marcelo 2026-10-12; the 10:00 price and its fallbacks approved the same day): the starting value buys whole SPY shares at SPY's 10:00 price on the session's first day; the rest stays in cash at the same interest. SPY's 10:00 price = the close of its 09:30–10:00 bar (IBKR 30-minute bars in the local DB, `npm run backtest:backfill-market-stress-bars`), else that day's IBKR daily open; a day with neither is marked at the last price, and the session's notes count those days. Without any SPY price the series is not shown.

Example: $1,000,000, SPY at 410.00 at 10:00 on the first day → 2,439 shares (999,990), 10 in cash; the next day SPY at 420.00 and one day of interest at 4%: 10 × (1 + 0.04 ÷ 365) + 2,439 × 420 = 1,024,390.00.

## Batches (approved by Marcelo 2026-10-17)

A batch is 1 to 9 runs on one period and the same settings, each run its own session and account. Every run is measured as a session and beside its own two buy-and-hold series.

**CAGR vs buy and hold (F2)** = the run's CAGR − the CAGR of buy and hold of the run's own symbols and pots, in percentage points. Example: a run with a CAGR of +42.0% whose buy and hold of CRWV had +105.0% shows -63.0 pts.

**Combined portfolio (F1)**: two or more finished runs added up as separate accounts in one portfolio, on the trading days they all have. Each day: value = Σ the runs' account values, exposure = Σ their exposure, interest = Σ their interest; start = Σ their starting values. Total return, CAGR, Sortino, Max drawdown, Worst month, End value and capital in use come from the session's formulas on that sum; options sold, wheel cycles, win rate, edge capture and return on capital in use from the runs' option sales and cycles pooled. Its buy and hold = Σ each run's buy-and-hold value, its SPY = Σ each run's SPY value, measured on their value lines alone. Each run counts at its own starting value; the runs share no cash, and the per-ticker and per-sector caps do not reach across runs.

Example: runs A and B start with $100,000 each; A ends at $130,000 and B at $90,000 → $200,000 to $220,000, Total return +10.0%. The combined value peaks at $205,000 and its lowest later day has A at $95,000 and B at $70,000 = $165,000 → Max drawdown 165,000 ÷ 205,000 − 1 = −19.5%, from the summed line, not an average of A's and B's own drawdowns.

## Also decided (2026-10-12)

1. Interest on the whole cash balance, including cash that secures puts (it is still cash at IBKR).
2. No dividends in version 1, for the sessions or for either buy and hold. This understates buy and hold for dividend payers (SPY among them); most shortlist names pay little or nothing.
