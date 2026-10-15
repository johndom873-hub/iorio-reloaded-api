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

**No open the event-close rule would close at once** (rules only, never with the AI model; approved by Marcelo 2026-10-12). An open that passed the gates is applied to a copy of the book, and the position it makes is read as Pluto would show it at the next pass: its held-position figures (F2) at the look's quotes, and the close before a macro event (F3) Pluto would offer it, with the close gate's cycle P&L. When that close would be offered and the session's *Close offered before a macro event* rule would take it, the open is skipped: it is left out for the rest of the look, the rules choose again (the next candidate, or nothing), and the look's summary says why ("skipped HOOD Sell $24 Call · 4 Oct (4DTE) · 24× @ 0.34: the event-close rule would close it at once before the 4 Oct Jobs report (heavy, 4 sessions away): stress loss $X ≥ what is left to earn $Y − the close cost $Z"). With the rule *never*, nothing is skipped. In practice it skips buy-writes whose wheel cycle is already in profit after the close cost (a call on held shares is code's since 2026-10-12, not a choice of the rules, and is never skipped), inside the 5 sessions before a release: a put sold under its mid is never offered an event buyback at once, the ask would not lock a profit.

Example: a buy-write of 24 HOOD $24 calls (bid 0.33, ask 0.36, mid 0.345) on 2,400 shares at 23.31, the jobs report (heavy, k = 2) 4 sessions away, a 60% forecast (d = 0.60 ÷ √252 = 3.78%), the cycle in profit after the close cost. Stressed spot 23.31 × (1 − 2 × 0.0378) = 21.55; stress loss = (23.31 − 21.55) × 2,400 − (0.345 − 0.02) × 100 × 24 = 4,229 − 780 = 3,449 (the call worth about 0.02 after the event); left to earn = (24 − 23.31 + 0.345) × 100 × 24 = 2,484; close cost = ((0.36 − 0.345) × 100 + 0.68) × 24 + (23.31 − 23.30) × 2,400 = 76. 3,449 ≥ 2,484 − 76: the event close would be offered and taken at the next pass, so the open is skipped.

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

## Baselines (comparison only)

Two buy-and-hold series run beside every session, marked at 10:00 each session day and measured with the same formulas as the session (return, CAGR, Sortino, drawdown, worst month). They are for comparison only: nothing in the session depends on them. Neither counts dividends.

**Buy and hold of the session's symbols**: each symbol's pot in a pots session, else the starting value in equal parts, one per symbol; each part buys whole shares at its symbol's first 10:00 price in the session and is never rebalanced; what is left stays in cash at the same interest as the session. Value on a day = cash + Σ shares × the day's 10:00 price × F(purchase day) ÷ F(day) (split scale). With one symbol: as many whole shares as the starting value allows.

Example: $1,000,000 over SMCI at 40.00 and HOOD at 25.00 → 12,500 SMCI and 20,000 HOOD shares, nothing left in cash.

**Buy and hold of SPY** (Marcelo 2026-10-12; the 10:00 price and its fallbacks approved the same day): the starting value buys whole SPY shares at SPY's 10:00 price on the session's first day; the rest stays in cash at the same interest. SPY's 10:00 price = the close of its 09:30–10:00 bar (IBKR 30-minute bars in the local DB, `npm run backtest:backfill-market-stress-bars`), else that day's IBKR daily open; a day with neither is marked at the last price, and the session's notes count those days. Without any SPY price the series is not shown.

Example: $1,000,000, SPY at 410.00 at 10:00 on the first day → 2,439 shares (999,990), 10 in cash; the next day SPY at 420.00 and one day of interest at 4%: 10 × (1 + 0.04 ÷ 365) + 2,439 × 420 = 1,024,390.00.

## Also decided (2026-10-12)

1. Interest on the whole cash balance, including cash that secures puts (it is still cash at IBKR).
2. No dividends in version 1, for the sessions or for either buy and hold. This understates buy and hold for dividend payers (SPY among them); most shortlist names pay little or nothing.
