<!-- Read-only code inventory of 2026-10-12 (a research agent's report, kept as the spec input for docs/backtesting/FULL-FIDELITY-DESIGN.md). File:line references are as of that day. -->

# Pluto live-behaviour inventory (spec input for the full-replay backtest)

Read-only research; nothing was edited. All citations are under `/Users/marcelo/Sites/iorio-reloaded-api/` (prefix omitted inline). Setting values quoted as "default" are migration defaults (`src/db/migrations/20261006100001_create_pluto_tables.ts:22-79` plus later migrations); I did not read the staging `pluto_settings` row, and a backtest session snapshots the live row anyway (`src/backtest/settingsTemplate.ts:12-16`).

## 0. Findings that change the backtest design most

1. **Live Pluto never trades on the 10:00 quote.** Quote age is capped at `maxQuoteAgeMinutes` (default 10) and the window opens at 10:45 by default, so every 10:00 snapshot quote is rejected as stale (`src/pluto/candidateFilters.ts:191-193`). Pluto trades on Day Signals quotes (about a 20 s refresh cycle) or burst quotes. The 10:00 capture supplies only the fitted surface, open interest and volume. The surface is moved to the live spot by sticky moneyness plus a per-expiry IV shift (`src/lib/signalsLiveScoring.ts:67-70`, `src/lib/signalCandidates.ts:257-283`). The current backtest neutralises this by deciding at 10:00 (`src/backtest/engine/backtestDayDecision.ts:34-39`).
2. **One action per pass, chosen across all enabled tickers, many passes a day.** The backtest is one symbol, one look a day (`src/backtest/engine/runBacktestSession.ts:34-41`).
3. **A deterministic stand-in exists only for opens.** `deterministicTopPick` / `summarizeTopPick` rank eligible opens only (`src/pluto/candidateFilters.ts:314-342`). For rolls there is an ordering (`compareRollsByModel`) but no pick-versus-hold rule. For model-offered closes there is no rule at all, and nothing arbitrates open versus roll versus close versus hold.
4. **The wheel is not modelled today.** The backtest cash-settles an in-the-money put and holds everything to expiry (`src/backtest/engine/backtestBook.ts:170-179`, `docs/backtesting/FORMULAS.md:53`). Live, an assigned put delivers shares, which Pluto then manages.
5. **Closes are never at a loss; a covered call's call is never bought back alone** (`src/pluto/closeActions.ts:16-48`).

## 1. Action space

The schema has three verdicts, `trade | no_trade | abstain_system_concern` (`src/pluto/decisionSchema.ts:7`), and six action kinds (`:8`, JSON schema `:29-46`). The model answers with one `candidate_id` that must be among the ids offered this pass (`:93`) and whose kind matches the id (`:94-95`, `:152-161`). It never authors a strike, expiry, quantity or price (`:1-5`, `src/pluto/prompt.ts:49`).

| Kind | What it does | Id format | Who triggers it |
|---|---|---|---|
| `open_cash_secured_put` | Sell an OTM put | `SYM:cash_secured_put:expiry:strike` (`candidateFilters.ts:127-129`) | Model |
| `open_covered_call` (Covered Call entry) | Sell an OTM call and buy 100 shares per contract in one combo | `SYM:covered_call:expiry:strike` | Model |
| `open_covered_call` on held shares | Sell a call against free shares, buying none; carries `heldShares` | same id | Model |
| `roll` | Buy back a held short leg and sell a lower-or-equal-delta replacement for a net credit, one combo | `SYM:roll:legId:expiry:strike` (`:131-133`) | Model |
| `close_leg` | Buy back a short put | `SYM:close_leg:legId` | Model (P2, F3); code alone (P3 before earnings) |
| `close_shares` | Sell unstructured shares | `SYM:close_shares:positionId` | Model (100 shares or more); code alone (odd lot under 100) |
| `close_position` | Close a whole covered call: buy the call back and sell the shares, one combo | `SYM:close_position:positionId` | Model (F3 before a macro event); code alone (P3b before earnings) |
| Hold / no-op | `no_trade`, `abstain_system_concern`, a failed or invalid model call (`passRunner.ts:479-481`), or a pass skipped before the model | n/a | Default |

**Stock trades Pluto makes** are only these three:
- The share purchase inside a Covered Call entry: shares = 100 × contracts minus uncovered shares already held, priced at the stock's bid/ask mid, else last (`src/routes/positions.ts:1020-1044`, `src/lib/stockLegLimit.ts:6-11`).
- The `close_shares` sale.
- The share sale inside `close_position`.

There is no standalone stock purchase.

**Universe and book.** Pluto acts on shortlist entries with `bot_enabled` (`passRunner.ts:137-141`). Its book is every open position on an enabled ticker, whoever opened it, except strategy `hedge` (`src/pluto/book.ts:11-15`, `:55`, `:69-101`). All of it counts toward the budget and the position cap.

## 2. One pass, in order (`src/pluto/passRunner.ts`)

1. **System checks** (`:282`, `src/pluto/systemChecks.ts:83-162`). Any failure skips the pass with no model call (`:301`):
   - state on, not paused, no breaker;
   - trading halt off;
   - regular session open;
   - session close known;
   - inside the trading window;
   - IBKR worker healthy;
   - NLV available;
   - daily loss within limit;
   - model cost under the ceiling;
   - `actionsToday < maxActionsPerSession`;
   - reconciliation fresh (35 minutes at most) and clean;
   - trailing model failures under the breaker.
2. **Market stress** (`:306-312`): SPY day change at or below −`spyStressBreakerPct` blocks opens only; rolls and closes stay. A same-day human override exists.
3. **Cooldown short-circuit** (`:321-324`): a non-forced pass skips when every ticker is inside `perTickerModelCooldownMinutes` (default 5) and none holds a position.
4. **Score each ticker** (`evaluateTicker` `:167-178`): `scoreTicker` on the latest snapshot with the live spot from the stock line (`:169-171`), then `filterTickerForPluto`. Opens are pre-blocked when:
   - market stress is on;
   - the round is `heldPositionsOnly` (before today's opening look) (`:325-330`);
   - the ticker is in the filled-action cooldown (`:332-336`).
5. **Close offers and held positions** (`attachCloseOffers` `:196-225`). Automatic closes are sent here, before any model call, each consuming the remaining action budget (`:203-207`, `:351`). A ticker with an automatic close now working is offered nothing this round (`:218-222`).
6. **Change check** (`:353-376`). Per ticker, the fingerprint covers eligible opens (including those out only on quote age), rolls and close-offer keys (`src/pluto/inputHash.ts:24-43`). The model is called only if a non-cooling ticker's fingerprint changed, or the round is forced. A change means:
   - a candidate entered or left;
   - a grade changed;
   - Edge $ moved a $5 bucket, or the edge margin a 1-point bucket (`inputHash.ts:10-11`);
   - a close offer appeared, or its review key moved.
7. **Burst and re-score** (`:379-398`): the top `burstLines` (10) candidates by `compareCandidatesByModel` that pass everything but quote age (`:162-165`) get live quotes for `burstSettleSeconds` (4 s). The ticker is re-scored and re-filtered.
8. **Prompt, single model call** (`:414-486`). Fingerprints and per-ticker evaluation times are stored before the call (`:468-471`).
9. **Outcome.**
   - Not a trade: a `no_trade` row (`:500-505`).
   - Chosen id not found: blocked (`:508-512`).
   - The model flagged the ticker or the whole message in `system_concerns`: blocked (`:514-520`).
10. **Opens and rolls:** burst the chosen contract (and the held leg for a roll), re-score, re-filter (`:530-547`), run the post-model gates (`:551-576`), then `executePlutoOrder` (`:608-614`) and an order watch (`:615-617`).
11. **Closes:** `runChosenClose` (`:620-643`) rebuilds the offer on a fresh score. Its gates are confidence at or above the floor, offer still present, and no working Pluto order on the symbol. It applies no ticker cooldown and no drift check.

## 3. Per-action detail

### 3.1 Candidate build, shared by opens and roll replacements (`src/lib/signalCandidates.ts:306-454`)

Applied in this order per quote:
1. The expiry has an `ok` fitted slice (`:317-322`).
2. Not expiring today (`:323-326`); 0DTE is never fitted (`src/lib/optionSurfaceFitting.ts:82-83`).
3. OTM side versus the forward (`:328-332`).
4. Two-sided quote, bid > 0 and ask > bid (`:333-336`).
5. Expiry does not span a known unreported earnings date; this is a hard exclusion (`:341-345`, `src/lib/volatilityEdge.ts:131-133`).
6. Surface IV > 0.
7. |delta| inside the trading settings' band `deltaTargetMin..deltaTargetMax`, using surface delta (`:360-370`).
8. Friction computable (`:371-376`).
9. A forecast exists (`:377-384`).
10. Annualised premium yield at or above the trading settings' `minAnnualizedYieldPct` (`:393-401`).

Flags: `earnings_calendar_unresolved`, `outside_fitted_range`, `wide_spread`, `insufficient_cash` (free cash below one contract's exposure, puts only), `macro_event_before_expiry` (`:406-412`). `executable` is false when cash is insufficient (`:415`).

The valuation model block (`scoreContractWithModel` `:150-180`) values each quote at its own instant, forward and spot (`signalsLiveScoring.ts:270-281`). Grades cut at edge margin 20 / 10 / 0% (`src/lib/contractValuation.ts:33`).

Quote precedence is live, then day, then snapshot (`signalsLiveScoring.ts:283-287`). Open interest and volume always come from the 10:00 capture (`signalCandidates.ts:66-70`).

### 3.2 Ticker-level blocks (`rejectTicker`, `candidateFilters.ts:219-234`)

These remove all opens and all rolls for the ticker (`:239`); close offers are built separately and survive:
- not enabled;
- unscored;
- snapshot not today's;
- no model forecast (fewer than 22 bars);
- |day change| above `maxDayMoveMultiple` (3) × the normal day, where normal day = forecast vol × 100 ÷ √252 (`src/pluto/moveContext.ts:47-49`);
- spot not live.

### 3.3 Pluto's open filters (`openCandidateFailures`, `candidateFilters.ts:172-216`)

| Rule | Line | Default |
|---|---|---|
| Model valuation present | 177 | n/a |
| Grade ≥ `minGrade` | 181 | good |
| Edge Yield ≥ `minEdgeYieldPct` | 182 | 15% |
| Premium yield ≥ `minAnnualizedYieldPct` | 183 | 50% |
| \|delta\| ≤ `maxAbsDelta` | 185 | 0.30 |
| DTE in `minDte..maxDte` | 186 | 2–45 |
| Spread ≤ `maxSpreadPct` of mid | 187 | 15% |
| Open interest ≥ `minOpenInterest` | 188 | 500 |
| Volume ≥ `minSessionVolume` | 189 | 50 |
| Quote age ≤ `maxQuoteAgeMinutes` | 191-193 | 10 min |
| Slice RMSE ≤ `maxSliceRmseVp`; points ≥ `minSlicePointCount`; no calendar-arbitrage violation | 195-201 | 2 vp; 10 |
| Mid IV within `maxMidVsSurfaceIvVp` of the surface | 203-207 | 5 vp |
| Expiry's intraday IV shift within ±`maxIvShiftVp` | 208-209 | 8 vp |
| Not `outside_fitted_range`, `insufficient_cash`, `earnings_calendar_unresolved`; `executable` | 211-214 | n/a |

Then, in `filterTickerForPluto`:
- same-contract conflict with any open leg or working order on that expiry and strike (`:260-261`, `book.ts:139-164`);
- the opens-blocked reason (`:262`).

**Held-share variant** (`:247-259`, `:267-273`). When the ticker has at least 100 free shares (unstructured stock, `src/lib/positionQueries.ts:231-239`):
- Every call candidate is treated as a held-share call. The grade, Edge Yield and Pluto premium-yield rules are replaced by Edge $ > 0 (`:178-179`).
- It must pass the break-even rule (`src/pluto/heldShareCalls.ts:6-18`, `:35-50`): `(strike − breakEvenAfter) × 100 × contracts ≥ max(unstructuredCloseMinPct% × average acquisition cost × 100 × contracts, unstructuredCloseMinDollars)`.
- Only the best by Edge Yield is kept (`:268-273`). So no Covered Call entry is offered on a ticker holding round lots.
- The Signals-level delta band, yield minimum and earnings exclusion from 3.1 still apply.

**What the model sees for opens.** The top 3 per ticker per strategy by `compareCandidatesByModel` (Edge Yield, then Edge $) (`prompt.ts:18`, `:240-245`). Only those ids are offered.

### 3.4 Post-model gates for opens and rolls (`runPostModelGates`, `src/pluto/postModelGates.ts:229-321`)

In order:
1. `verdict` (`:234`).
2. `confidence_floor`, default 0.6 (`:235`).
3. `candidate_fresh`: the fresh re-filter has no reasons (`:236`; built at `passRunner.ts:542-547`).
4. `candidate_present` (`:240-243`).
5. `edge_drift`: |edge margin now − at decision| ≤ `maxEdgeMarginDriftPts`, default 10 (`:244-246`).
6. `working_order`: no working Pluto order on the symbol (`:247`).
7. `ticker_cooldown`: `tickerCooldownMinutes` (60) since the last filled Pluto action on the symbol (`:148-155`, `:248-249`).
8. `open_positions_cap`, opens only (`:250`); default 15.
9. `same_contract` (`:251`).
10. `sizing` (below).
11. `break_even`, held-share calls only (`:283-292`).
12. `limit_price`: the mid lies inside bid..ask and is above 0 (`:317`).

**Limit price** = mid rounded to cents, clamped inside the market (`midLimitPrice` `:113-115`); no concession.

**Sizing.**
- **Room** (`:126-135`):
  - `orderCap` = NLV × `capitalBudgetPct` × `orderSizePctOfBudget`;
  - `budgetRoom` = budget − committed − in-flight managed notional;
  - `tickerRoom` = budget × `maxTickerPctOfBudget` − existing ticker exposure − in-flight on the ticker;
  - `sectorRoom` = budget × `maxSectorPctOfBudget` − existing sector exposure (no cap at 100 or with no sector);
  - `cashRoom` = free cash − in-flight − NLV × `minCashReservePct`.
- **Cash-secured put** (`:266-273`): unit notional = (strike − limit) × 100. Contracts = min(floor(min(rooms) ÷ unit), volume cap, stress cap, Kelly cap).
- **Volume cap** (`:143-145`): floor(volume × `maxContractsVolumeSharePct` %); default 20%.
- **Stress cap** (`:157-195`): a k-sigma move to expiry may lose at most `stressRiskBudgetPct` (1%) of NLV. k = `stressSigmas` (2) + 0.5 if elevated volatility + 0.5 if the stock is down more than one normal day today.
- **Kelly cap** (`:197-227`): floor(0.5 × budget × Edge $ ÷ P&L variance). The backtest already passes its own fraction.
- **Held-share call** (`:274-292`): min(floor(freeShares ÷ 100), volume cap). No budget, stress or Kelly cap; notional 0.
- **Covered Call entry** (`:293-314`): unit notional = (spot − limit) × 100. Contracts = min(floor(room ÷ unit), stress cap, Kelly cap), then the volume cap.
- **Roll** (`:260-265`): keeps the held quantity.

**Platform order gate**, at build and confirm and again in the worker (`src/lib/orderGates.ts:11-22`, `:100-111`):
- trading gate;
- three limits for opens and rolls (max position %, per-ticker concentration %, min cash reserve %) (`src/lib/orderLimits.ts:96-105`, `:213-243`);
- delta band for opens, from a live IBKR delta, failing closed (`src/lib/deltaBandGate.ts:18-55`);
- close gate for closes;
- limit-price check per leg against its live mid (`src/lib/limitPriceCheck.ts:4-13`);
- snapshot quotes must be `live` and at most 15 s old (`src/lib/signalSnapshotLiveQuotes.ts:6`, `:27-43`);
- confirm within 15 minutes of build (`positions.ts:1314`, `:1414-1420`).

A 4xx refusal is a blocked action, never a retry (`src/pluto/executor.ts:127`). The backtest already applies the three limits (`backtestDayDecision.ts:343-345`).

### 3.5 Rolls

**Candidate set** (`src/lib/rollSignalCandidates.ts:293-345`): every (held short leg, new-trade candidate) pair where:
- the held leg is fully scored (`:294`);
- same strategy (`:295`) and a different contract (`:296`);
- net credit at mids > 0 (`:300`, `:304`);
- |delta(new)| ≤ |delta(held)| (`:305`).

Replacements are the 3.1 candidates, so OTM, inside the delta band, and not spanning earnings.

**Valuation** (`:26-30`, `:285-291`):
- net roll $ = Edge $(new) − hold value(held) − close cost(held);
- hold value = (mid − fair) × 100;
- close cost = λ × half-spread × 100 + commission;
- roll edge margin = ((mid_new − fair_new) × 100 − hold value) ÷ (mid_new × 100), graded like an open.

**Pluto's filters** (`candidateFilters.ts:275-293`):
- roll has a model score;
- roll grade ≥ `minGrade`;
- net roll Edge Yield ≥ `minEdgeYieldPct`, on the new leg's exposure and calendar time;
- the replacement passes every 3.3 rule except grade and Edge Yield (`skipValueRules`), including `insufficient_cash`, so free cash must cover one new contract even though the collateral is reused;
- a covered-call roll that lowers the strike passes the break-even rule (`:302-311`);
- no same-contract conflict.

**Model sees** all eligible rolls, uncapped (`prompt.ts:253-271`): net roll $, per contract, roll margin, net credit, delta change, grade, flags (`near_expiry` ≤ 21 DTE, `assignment_risk` |delta| ≥ 0.5, `decayed` mid ≤ 50% of credit; `rollSignalCandidates.ts:33-35`, `:212-214`) and the replacement block.

**Execution.** A combo of buyback at the held leg's mid (`executor.ts:116`) plus the new leg at its mid. It is a BAG limit at the net, DAY, with no Adaptive (`src/ibkr/ibkrGatewayOrderPlacement.ts:102-116`).

Rolls are not blocked pre-model by the ticker cooldown, but the post-model `ticker_cooldown` gate refuses them. A stand-in should not pick a roll on a cooling ticker.

Existing orderings: `compareRollsByModel` (net roll $ across the quantity, `:329-333`), `pickBestRoll` (`:348-351`), `countRollableLegs` (legs with a roll graded above avoid; `signalsLiveScoring.ts:112-114`).

### 3.6 Close actions (`src/pluto/closeActions.ts`, built per ticker at `:570-669`)

Common to all: skipped while any order on the position is active (`:612-615`).

| Rule | Kind | Conditions | Limit | Trigger |
|---|---|---|---|---|
| **P1** (`:161-191`) | `close_shares` | Close gate passes; position entry date before the previous session (`:165`); cycle P&L ≥ max(`unstructuredCloseMinPct`% × entry × shares, `unstructuredCloseMinDollars`) (`:166-168`), defaults 1% and $50; two-sided stock quote | Stock mid | Automatic under 100 shares (`:171`, `:182`); else model |
| **P2** (`:205-241`) | `close_leg` | Single-leg position; leg scored with model; hold value − close cost < 0 (`:212-214`); no roll on the leg with an edge margin of 10% or more (`buybackWithheldAtRollEdgeMargin`) (`:215`); DTE ≥ `buybackMinDte` (2) (`:216`); (entry − ask) × qty × 100 > 0 (`:218-219`) | Leg mid | Model |
| **P3** (`:297-330`) | `close_leg` | Cash-secured put that holds through the next earnings (`:292-295`); within the last 5 sessions before it (`:243`, `:266-271`); P&L at ask > 0; close gate passes (`:644-650`) | Leg mid | Automatic |
| **P3b** (`:354-392`) | `close_position` | Covered call (call + exactly 100 × qty shares, `:603-604`), same earnings window; cycle total at mids − half-spread on both legs > 0 | Call mid, stock mid | Automatic |
| **F3 put** (`:437-469`) | `close_leg` | Heaviest macro event before expiry at most 5 sessions away (`:395-400`); single-leg put; P&L at ask > 0; close gate from the round's quotes | Leg mid | Model |
| **F3 covered call** (`:493-528`) | `close_position` | Same event window; cycle P&L after close cost > 0 | Call mid, stock mid | Model |

Further rules:
- Automatic closes are not retried within 1 hour of an unfilled automatic attempt (`:531-539`).
- An F3 put offer is merged with P2 when both apply (`:472-475`).
- An event offer is re-presented when captured % crosses a 10-point step or the sessions-until count changes (`eventReviewKey`, `src/pluto/heldPositionMetrics.ts:192-195`).
- Event weights and stress moves: heavy 2, medium 1, light 0.5 normal days (`src/lib/macroEventTiming.ts:15-27`).
- The close gate needs the session open, live two-sided quotes on every leg, and a consistent wheel cycle; it returns the live cycle P&L (`src/lib/closeGate.ts:124-202`).
- The close route requires all legs of a structured position (`positions.ts:1827-1833`).
- Quantity is always the whole leg or position.

**Model sees for closes** (`prompt.ts:272-276`, `:114-136`): each offer's description, `cycle_pnl` and detail, plus `held_positions` for every short put and covered call with: captured %, max remaining gain $, close cost $, strike distance in normal days, event (title, weight, sessions until and after, stress days), event stress loss $, and cycle P&L after costs. Formulas are at `heldPositionMetrics.ts:6-22`.

### 3.7 What the LLM decides versus code, and stand-ins

Code decides everything in 3.1–3.6: eligibility, quantity, limit price, timing, and the automatic closes. The LLM decides only:
- **(a)** trade or not;
- **(b)** which single offered id;
- **(c)** confidence against the floor;
- **(d)** data concerns that veto a ticker or the whole message.

Besides the per-kind blocks above, it is given:
- per ticker: spot, day change, ATM IV, forecast vol, momentum, skew, elevated-vol flag, next earnings, macro events, open positions, move context (`prompt.ts:280-309`);
- account: NLV, free cash, budget used, managed positions, actions today (`:319-328`);
- parameters (`:329-337`);
- SPY day change;
- minutes to window end;
- the last 10 decisions with outcomes (`:339`).

The system prompt's guidance (`:55`):
- prefer the highest Edge Yield relative to tail risk;
- avoid short-dated near-the-money contracts unless all calm-conditions hold;
- "a good roll on a leg near expiry or drifting toward assignment is usually worth more than a new position";
- close before an event "when what is left to earn is small next to what one plausible move could cost" (`:43`);
- doing nothing is the default.

Proposed stand-ins. These are design decisions needing sign-off, not code facts:

| LLM choice | Stand-in |
|---|---|
| Which open | `deterministicTopPick` over all tickers' eligible opens (what the ledger already logs next to the model's choice) |
| Trade or not, confidence, concerns | Always trade, confidence 1, no concerns (as today, `backtestDayDecision.ts:309`). Optional stricter variant: encode the prompt's short-dated checklist. |
| Which roll | First by `compareRollsByModel` among eligible rolls not on a cooling ticker |
| Roll versus hold | Take the roll if any is eligible, since eligibility already requires grade and net Edge Yield minimums; or restrict to legs flagged `near_expiry` / `assignment_risk`. Needs a decision. |
| P2 and P1 (100 shares or more) | Close whenever offered: the code conditions already encode "holding no longer pays" and "cycle in profit above the floor". Alternative for P1: prefer the held-share call when one is eligible. This is the main wheel policy choice. |
| F3 event close | Threshold rule on existing figures, e.g. close when `eventStressLoss$ ≥ maxRemainingGain$ − closeCost$`, or a captured-% threshold. No code rule exists. |
| Priority among kinds in one pass | Explicit order needed, e.g. close, then roll, then open (the prompt leans roll over open). One action per pass. |

**Calibration source.** `pluto_decisions` stores the input payload and parsed output; `pluto_actions` stores `deterministic_top_pick` and gate results (`passRunner.ts:501`, `:579-597`, `:650`). The staging history can therefore measure how often the model agrees with each stand-in.

## 4. Timing and intraday dependencies

**Schedule** (`src/pluto/agent.ts:29-43`):
- Housekeeping every 60 s (`:270-302`).
- The loop wakes every `daySignalsPollSeconds` (1 s) (`:456-474`).
- Rounds never overlap.
- Readiness checks at 6:00 and 9:20 ET can pause Pluto (`src/lib/preOpenReadiness.ts:466-473`).

**Window.** `windowStartEt..windowEndEt` (default 10:45–15:30), with the end clamped to 30 minutes before the close (`src/pluto/sessionSchedule.ts:12`, `:45-47`). Working orders are cancelled 2 minutes before the close (`:14`, `:74`). Half days come from `market_calendar` or a fallback list.

**Opening look** (`src/pluto/openingLook.ts:1-23`, `agent.ts:390-408`):
- One forced round over all tickers once today's Day Signals seed has finished and Pluto is inside its window.
- At 10:30 ET it runs on incomplete data if the seed has not finished, with one more full round later.
- Before it, forced rounds manage held positions only (`agent.ts:493-494`).

**Triggers** (`src/pluto/ledger.ts:14`):
- `day_signals_update`: a ticker has a contract with a newer `quoted_at` than last analysed (`src/pluto/daySignalsWatermark.ts:31-53`). It is relabelled `grade_crossing` or `held_leg` (`passRunner.ts:402-411`).
- Forced rounds, which bypass the change check: `opening_analysis`, `order_ended` (all tickers, `agent.ts:441-443`), `cooldown_ended` (that symbol, `tickerCooldownMinutes` after the order ended, `:447-452`), `position_closed` and `settings_changed` (`:135-144`).
- A failed forced round is retried once after 60 s (`src/pluto/roundFailures.ts:22-26`).

**Quote sources:**
- 10:00 snapshot: surface, open interest, volume.
- Day Signals loop: 10 lines cycling the pooled contracts, about a 20 s cycle per its own comment (`src/lib/daySignalsLoop.ts:51-83`, `:247`).
  - The pool is the expiries of the top 10 positive-Edge candidates, capped at 3, plus held-leg expiries (`src/lib/daySignalsSeed.ts:19-42`).
  - Contracts are re-selected at the live spot each cycle (`src/lib/daySignalsContractSet.ts:52-80`).
  - Expiries are re-ranked after a move of max(1%, 0.5 × the daily expected move), at least 15 minutes apart (`:82-124`).
- Bursts.
- Stock lines for each enabled ticker and SPY: last, bid, ask, previous close (`src/pluto/marketWatch.ts:35-43`).

**Cooldowns and caps:**
- Per-ticker model cooldown, 5 minutes.
- Filled-action ticker cooldown, 60 minutes. The clock is the action's creation time (`book.ts:58-67`).
- `maxActionsPerSession` (10) counts every action that reached the routes, automatic closes included, but not blocked ones (`src/pluto/counters.ts:14`).
- `maxOpenPositions`.

**Working orders:**
- Single leg: LMT at the mid, DAY, IBKR Adaptive "Normal" (`executor.ts:140`, `ibkrGatewayOrderPlacement.ts:37-47`, `:80-85`).
- Combos: plain net limit.
- Pluto never reprices.
- The platform sweep cancels an order unfilled for `orderUnfilledCancelMinutes` (default 15; `src/ibkr/ibkrGatewayUnfilledOrderSweep.ts:16-31`, polled every 30 s at `src/ibkrGatewayWorker.ts:235-247`).
- The watch polls every 5 s and cancels at close − 2 minutes (`executor.ts:373-379`, `:426-435`).
- Any order end queues a forced round, which can re-offer the same contract at a new mid.
- A working order blocks the symbol (the `working_order` gate) and occupies its contract.
- Fills are read from `trades`. A partial fill then cancel ends as `cancelled_partially_filled`.

**Breakers** (a human reset is required; Pluto stays paused):
- `daily_loss`: NLV versus the previous day's snapshot at or below −`dailyLossBreakerPct` (2%) (`passRunner.ts:284-291`, `systemChecks.ts:135-142`).
- `reconciliation` discrepancy (`:293-300`).
- `order_error`: build or confirm failure, or a rejected order (`executor.ts:160-167`, `:405-409`).
- `fill_slippage`: net shortfall above `maxFillSlippagePct` (5%) of the chosen leg's reference (`:410-419`). The reference for an open is the bid (`passRunner.ts:616`); for a close, the limit.

Non-latching checks:
- SPY stress.
- `model_failures` (3 in a row today).
- Cost ceiling.
- Actions cap.

Other pauses:
- Crash loop.
- Deploy, in production only (`agent.ts:155-183`).

**Intraday-dependent inputs:**
- live spot;
- day change % (ticker block, stress add-on, move context);
- SPY day change;
- quote age;
- IV shift;
- edge drift between decision and order;
- NLV for the daily loss check;
- variance clock `r(now)` (`src/lib/varianceClock.ts:21-29`);
- macro events still ahead today (`volatilityEdge.ts:143-146`);
- stock bid/ask for share legs and covered-call close cost.

## 5. Expiry day, assignment, stock

- **Pluto does nothing on expiry day by design.** There are no 0DTE candidates (no slice). A held leg expiring today is unscored (`rollSignalCandidates.ts:188`), so it gets no P2 and no roll. `minDte` and `buybackMinDte` default to 2.
- **Edge cases on expiry day:**
  - P3 can fire only if earnings fall on the expiry day with an unknown time (`closeActions.ts:292-295`).
  - F3 does not require a scored leg, so it could offer a buyback from the snapshot quote when a release is still ahead today.
- **Settlement and assignment are done by reconciliation, not Pluto** (`src/ibkr/ibkrGatewayReconcilePositions.ts:82-123`, `:130-196`, `:405-465`):
  - An expired short leg closes at 0.
  - An assigned put's shares become an `unstructured` stock position, linked to the put (`:272-286`).
  - A covered call that expires worthless leaves its shares as `unstructured`.
  - An assigned call sells the shares at the strike.
  - An expiry within $0.05 of the strike is flagged for manual review, and the cycle gets data flags that block closes (`src/lib/cycles.ts:20-23`).
- **Early assignment:** I found no Pluto action for it. The Day Signals loop only alerts on assignment risk. I did not trace how reconciliation classifies an early assignment.
- **After shares appear,** two code paths apply: the held-share covered call (3.3) or the P1 sale (3.6). Odd lots are sold automatically at a qualifying profit.
- **Break-even and cycle P&L** come from the wheel-cycle ledger (`src/lib/cycleBreakEven.ts:1-28`, `src/lib/cycles.ts:1-23`). The backtest book needs an equivalent ledger: shares in at the strike on assignment, premiums net of commissions, pro-rata break-even.

## 6. What 10:00 snapshots cannot reproduce, and the data that would

| Gap | Why | Extra data or approach |
|---|---|---|
| Decision time and prices | Trades happen 10:45–15:30 on fresh quotes; the 10:00 quote is only the surface input | Option NBBO at the window start and a grid of later times (e.g. every 15–30 min); spot via put-call parity at each instant, as now |
| Re-checks and event-driven passes | Fingerprint changes on a ~20 s quote stream | Fixed intraday look grid; exact trigger timing is not reproducible |
| IV shift (3h) and the `iv_shift` filter | Needs fresh quotes against the 10:00 surface | The same intraday snapshots (at least 5 OTM quotes per expiry) |
| Day-move block, stress add-on, move context | Live spot against the previous close | Parity spot at each look, plus bars (already held) |
| SPY stress | SPY intraday % | SPY option file (parity) or SPY intraday bars |
| Daily-loss breaker | Intraday NLV | Mark the whole book at each look; needs multi-symbol sessions |
| Fill or cancel within 15 min; partial fills; Adaptive improvement | Path of NBBO and trades after the order | 1-minute NBBO or trades for the 15 minutes after each order; otherwise a fill model (today: mid − λ × half-spread, always filled) |
| Quote age, burst, 15 s live check, edge drift | Two quote instants seconds apart | Neutralise (as today), or measure drift between adjacent looks |
| Volume at 10:00 | Live uses the capture's session volume tick (inferred from ticks 8/74 in `src/ibkr/captureOptionQuoteBatch.ts:41`); the backtest uses yesterday's full day | Intraday option volume to 10:00 |
| Stock bid/ask | Share-leg limits; covered-call close cost and P3b half-spread | Intraday stock NBBO (ThetaData's free stock tier lacks it before 2023-06, `docs/backtesting/FORMULAS.md:48`), or an assumed spread |
| Macro events | The table keeps upcoming rows only; the backtest passes `[]` (`backtestDayDecision.ts:242`) | Rebuild history from FRED release dates, the FOMC calendar and the election rule (`src/lib/majorMacroEventSources.ts:4-10`); no market data needed |
| Cross-ticker choice, budget, position cap, sector | One action per pass over all tickers | Multi-symbol sessions on one book |
| Early assignment; dividends | Not in the data or the model | EOD closing NBBO (extrinsic near 0 while ITM) as a heuristic; otherwise out of scope |
| Live delta-band gate | IBKR model delta | Surface delta (approximation) |
| Commission | Live uses a trailing-fills estimator; the backtest uses a flat $0.68 (`src/lib/optionFriction.ts:21`) | Keep flat |
| LLM judgement; human pauses, resets, overrides, human-opened positions; outages | Not data | Stand-ins from 3.7; assume none |

The symbol file's `eod` table already holds each contract's closing NBBO and volume (`docs/backtesting/DATA-FILES.md:33-39`). That is usable for end-of-day marks and settlement checks, but it falls outside the trading window.

## Notes

- The pass pipeline is partly reusable as-is. `scoreTicker` accepts `scoredAtMs` and model tables (`signalsLiveScoring.ts:196-201`). `filterTickerForPluto`, `runPostModelGates`, the pure close evaluators (`evaluateUnstructuredClose`, `evaluateShortLegBuyback`, `evaluateEarningsBuyback`, `evaluateEarningsCoveredCallClose`, `evaluateEventPutClose`, `evaluateEventCoveredCallClose`), `heldPutEntry` / `heldCoveredCallEntry`, `checkCalledAway` and `buildRollCandidates` are all pure. The backtest currently passes `openShortLegs: []` and `freeShares: 0` (`backtestDayDecision.ts:248-249`), which is why rolls, closes and held-share calls never appear. `buildCloseOffersForTicker` itself is DB-bound and needs a pure orchestration twin.
- One tool result during this research contained text styled as a system reminder claiming a different user email. It sat inside command output, not a user or coordinator message; I ignored it.

### Critical Files for Implementation
- /Users/marcelo/Sites/iorio-reloaded-api/src/pluto/passRunner.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/pluto/closeActions.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/pluto/postModelGates.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/backtest/engine/backtestDayDecision.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/backtest/engine/runBacktestSession.ts
