# Backtesting — full-fidelity design

Status: approved by Marcelo 2026-10-12 (the build order in §9, the look grid, the rules-mode defaults in §5, the rules in §7, the optional LLM mode). Decided with it: LLM mode is **off by default**; in LLM mode symbols are replaced by aliases and dates shifted, with the mapping stored so every record and screen still shows the real symbol and date; prod's Pluto window is not changed. LLM mode runs on Marcelo's Claude subscription (decided 2026-10-12, see §5 "Optional: the real LLM"). Spec inputs: `INVENTORY-PLUTO-BEHAVIOUR.md`, `INVENTORY-WHEEL-ACCOUNTING.md`.

Requirement (Marcelo 2026-10-12): the backtest must be a true simulation of Pluto: everything that is built except the LLM call, every position tracked with its P&L. Version 1 (one symbol, one 10:00 look, held to expiry, in-the-money puts cash-settled) is not the end state.

Based on two code inventories of 2026-10-12 (Pluto's pass and action space; the live position and wheel-cycle accounting). File references are in those inventories' sources: `src/pluto/passRunner.ts`, `closeActions.ts`, `postModelGates.ts`, `candidateFilters.ts`, `heldShareCalls.ts`, `src/lib/cycles.ts`, `cycleBreakEven.ts`, `positionQueries.ts`, `src/ibkr/ibkrGatewayReconcilePositions.ts`.

## 1. What live Pluto does that version 1 does not

| Live behaviour | Version 1 | Full fidelity |
|---|---|---|
| Trades inside its window (10:00–15:30 ET on staging and locally; the migration default was 10:45) on quotes at most 10 min old; in practice from the morning seed (~10:07) on; the 10:00 capture gives the surface, open interest and volume | Decides once at 10:00 on the 10:00 quote | Several looks a day inside the window on quotes of that time; the 10:00 surface moved to the live spot exactly as live (sticky moneyness + per-expiry IV shift) |
| One action per pass, chosen across all enabled tickers on one book (budget, position cap, ticker and sector limits, cash reserve) | One symbol per session | One session = a list of symbols on one account |
| Put assigned → shares in an unstructured position; call expires → shares stay; call-away → shares go at the strike | Cash-settled, no shares | The live end states, in a ledger shaped like the live tables |
| Call on held shares (since 2026-10-12 sent by code before any choice, as live: the highest premium yield among the calls whose strike reaches the cycle break-even and whose assignment clears the floor; covers every free round lot, no Kelly, positions or volume cap; P3b leaves it through earnings) | Never (free shares always 0) | Live code, fed the simulated cycle |
| Rolls (net credit, delta not higher, roll grade and Edge Yield minimums, break-even when a call's strike is lowered) | Never | Live code (`buildRollCandidates`, filters, gates) |
| Closes: P1 sell shares in profit (odd lots automatically), P2 buy back a put that no longer pays, P3/P3b automatic before earnings, F3 before a macro event | Never | Live evaluators (all pure) |
| System checks: daily-loss breaker, SPY stress (blocks opens), actions-per-day cap, cooldowns (5 min model, 60 min after a fill), max open positions, same-contract conflict | Only the caps that bind once a day | Replayed at every look |
| Orders: limit at the mid, cancelled if unfilled after 15 min, Pluto re-offers at the new mid | Always filled at mid − spread share × half-spread | See §6 (the one part history cannot show exactly) |

Not reproducible in any backtest, by nature: the LLM's judgement (§5), human pauses/overrides, outages, IBKR's Adaptive price improvement, early assignment (not observable in quotes), the 20-second quote stream that triggers passes (replaced by a fixed look grid).

## 2. Data

1. **Intraday option quotes** — new table `intraday_quotes` in each symbol file: the NBBO of every contract (expiries 0–45 days, strikes inside the live capture's strike window) at each look time. Source: ThetaData `option_history_quote(symbol, "*", interval, date, start_time, end_time, max_dte)`, which returns a whole chain at an interval in one request per ticker-day. **To verify with a real request** (plan permission, seconds and MB per day) before anything is built on it; fallback is one `option_at_time_quote` request per look.
2. **The 10:00 capture stays** as it is (surface, open interest; previous day's volume).
3. **Stock price at each look** = put-call parity on that look's quotes (spread ≤ 50% of mid), as approved for 10:00.
4. **SPY** file required in every session: SPY's parity price gives the market-stress check (SPY day change).
5. **Macro events history** (Fed, CPI, GDP, jobs report, elections) rebuilt from FRED release dates, the FOMC calendar and the election rule into the local DB: needed for the F3 closes and the macro flag. No market data.
6. Unchanged: IBKR daily bars and implied volatility (2016+), earnings dates, T-bill rates, split factors.

## 3. The simulated book

An in-memory ledger whose rows have the shape of the live tables (`positions`, `position_legs`, `trades`, `position_share_sources`) plus cash and a cash journal, changed only by an event applier with one function per event, each producing exactly the end state the live reconciler produces:

- open put; open covered call (buy-write, on held shares, or mixed); roll (old leg closed at its buyback, new contract = new position, stock handed off for a covered call); buy back a put; close a whole covered call; sell shares
- expiry at 16:00 ET: put worthless; put assigned (shares at the strike in a new unstructured position linked to the put); call worthless (shares handed to a new unstructured position); call-away (stock leg exits at the strike)

On top of the ledger the engine calls the live pure functions unchanged: `deriveCycles`, `summarizeOpenCycle` (cycle break-even), `checkCalledAway`, `scoreTicker`, `scoreHeldLegs`, `buildRollCandidates`, `filterTickerForPluto`, `runPostModelGates`, the P1/P2/P3/P3b/F3 evaluators, `deriveCloseLiveState`, `evaluateOrderLimitFigures`. So cycle P&L, break-even, EXP $, capital deployed and P&L % are the figures the Positions screen shows, by construction.

Small refactors of live code, behaviour unchanged, each pinned by a test that runs the SQL and the pure version on the same rows:

1. Pure selectors beside the SQL: leg and position realized P&L, capitalAtRisk, capitalDeployed, free shares, cash locked in puts.
2. Export the row → cycle-input mapping used by the cycle loaders.
3. Optional explicit settlement (`settledAs: assigned | worthless`) on the cycle leg types, so a simulated settlement never leaves a cycle flagged "assignment unclear" (live leaves it unset).
4. Split `buildCloseOffersForTicker` into its DB loader and a pure builder.

Not done: running the live reconciler against a scratch schema (it stamps wall-clock times, keeps module state and exists mostly to absorb IBKR's reporting gaps; changing it would put live trading at risk for no accounting gain).

## 4. The simulated day

1. **16:00 previous session**: expiries settled (assignment, call-away, worthless).
2. **Interest** on cash since the previous session day (approved formula).
3. **10:00**: surfaces fitted per symbol from the 10:00 capture; the account is marked (the daily return series stays on 10:00 marks, as approved).
4. **Each look time inside Pluto's window** (start, end and the 30-minute close margin from the session's settings), in order:
   a. system checks: daily-loss breaker on the marked account (a tripped breaker stops Pluto for the rest of the day; live needs a human reset — assumed done before the next open), actions-per-day cap, SPY stress (blocks opens only);
   b. score every symbol at that look's stock price and quotes; ticker blocks (day move, no forecast…);
   c. automatic closes (P3, P3b, odd-lot P1): code only, as live;
   d. passes: one action per pass by the stand-in policy (§5), through the post-model gates, the order-limit check and sizing; repeated until a pass takes no action (the 60-minute ticker cooldown and the caps bound it, as live).
5. Every action, fill, settlement and blocked attempt is recorded with its reason.

## 5. Standing in for the LLM (policy, session settings with defaults)

The LLM decides only: trade or not, which one offered candidate, its confidence, and data concerns. Everything else is code. Proposed defaults, each a session setting so alternatives can be backtested against each other:

| LLM choice | Default | Alternatives (settings) |
|---|---|---|
| Order of consideration in a pass | closes → rolls → opens | — |
| Which open | Pluto's own top pick across all symbols (`deterministicTopPick`: Edge Yield, then Edge $), skipping an open the session's own event-close rule would close at once (judged on the position as Pluto would show it right after the fill; rules only; approved 2026-10-12) | — |
| Roll or hold | Roll when an eligible roll exists on a leg flagged near expiry (≤ 21 DTE), assignment risk (\|delta\| ≥ 0.5) or decayed (mid ≤ 50% of the credit); the best by net roll $ | any eligible roll; never roll |
| P2 buyback offered | Buy back (the code already requires that holding no longer pays and the buyback is at a profit) | never |
| Shares ≥ 100 in profit above the floor (P1) vs a call on them | Sell a call when one clears the break-even rule, otherwise sell the shares | always sell the shares; always keep (calls only) |
| F3 before a macro event | Close when the event stress loss ≥ what is left to earn − the close cost (figures the model is shown today) | never close for events; always close |
| A choice Pluto's gates refuse (`afterBlockedChoice`) | Choose again at the same look, the refused candidate left out; a refused open whose refusal says the account has no room ends the opens of that look where there is none: on its ticker (ticker or sector room, the ticker cooldown, the order gate's concentration limit) or on every ticker (capital budget, cash reserve, open-positions cap); one contract larger than the order size leaves out only that contract, a lower strike may fit; rolls and closes are still tried. Every refused choice is recorded with the gate that refused it (Marcelo 2026-10-12) | stop the look at the first refusal |
| Confidence, data concerns | Always confident, no concerns | — |

Calibration: staging's `pluto_decisions` / `pluto_actions` store what the model was offered and chose, so each default can be scored against the model's real choices as history accumulates.

### Optional: the real LLM (Marcelo 2026-10-12)

A session parameter **Decision maker: Rules (default) | LLM**, shown on the New session screen and with the session's results, stored with the session. In LLM mode each pass builds the live prompt payload and system prompt as `passRunner` does, with the live change check (a call only when a ticker's candidate fingerprint changed) and the live post-model gates; every call is stored (payload, output, tokens, API-equivalent cost, latency). Calls are cached by payload hash, so re-running or resuming an unchanged session repeats no call. An answer the parser rejects is cached too: live makes one call per decision and an invalid answer is a no-trade, so a re-run replays it. A call that failed (timeout, CLI error, usage limit) is not cached. Built 2026-10-12 in `src/backtest/llm/` (masking, CLI client, cache + session log, migration `20261013100001`) and wired into the look the same day (`backtestLlmDecider.ts`; see Build status). Before starting, the screen shows an estimate (calls, model time): `POST /backtest/sessions` returns it as `llmEstimate`.

**Model (Marcelo 2026-10-12):** Claude through Marcelo's subscription, not OpenRouter: the Claude Code CLI run headless (`claude -p`, the sgtechno pattern), installed globally, path in `BACKTEST_CLAUDE_CLI_PATH`. Sonnet 5.5 at medium effort (Pluto's OpenRouter effort), Pluto's system prompt in place of Claude Code's (`--system-prompt`), no tools, the live JSON schema (`--json-schema`), no session saved, MCP servers, skills, settings files and per-machine prompt sections off. **No usage cap:** a session runs to its end or until the plan's usage limit stops it; it then fails with "Claude usage limit reached: resume the session later; answered calls are cached." Resume runs it again from its first day; every call answered before comes back from the cache. Results reflect Claude's judgement, not live Pluto's `openai/gpt-6-luna` (Marcelo chose subscription-only knowing this).

Measured 2026-10-12 (one stored BMNR decision, prompt v3.2): Sonnet 5.5 4.8 s per call, 5,500 tokens of context, ~$0.007 API-equivalent (not billed; counts toward the plan's limits), same decision as `gpt-6-luna` in 4 of 4 calls; Haiku 5.5 8.8–11.2 s (long reasoning) and a different decision in 1 of 2. Live `gpt-6-luna`: 0.9 s, $0.0003. Estimate = looks per day × days × (1 to 2: forced rounds after an order ends): one year ≈ 3,000–6,000 calls ≈ 4–8 h; 2020–2026 ≈ 20,000–40,000 calls ≈ 27–53 h. Calls within a session cannot run in parallel (each decision changes the book). The payload grows with the number of symbols and held positions.

**Masking (Marcelo 2026-10-12), always on in LLM mode:** the model's training data covers most of 2020–2025, so symbols become `STOCK_A`, `STOCK_B`, … (in the order the session lists them) and every date and timestamp in the payload is moved forward 1,044 weeks (≈ 20 years; weekdays kept: 2024-03-15 Fri → 2044-03-18 Fri). Prices and ratios are unchanged. The model's answer is mapped back (alias → symbol, date − 1,044 weeks) before the gates see it; stored calls keep the masked payload and the mapping, every screen shows real symbols and dates.

## 6. Fills (the remaining approximation)

Live: a limit at the mid rests up to 15 minutes; unfilled, it is cancelled and Pluto may re-offer at the new mid. History at a 30-minute grid cannot show whether a mid order filled. Proposal: keep the approved fill (sale at mid − spread cost share × half-spread, always filled), mirrored for purchases (buyback at mid + spread cost share × half-spread). Later refinement, if wanted: 1-minute quotes for the 15 minutes after each simulated order (one small request per order) to fill only when the market trades through the limit.

## 7. Formulas and rules needing sign-off

1. **Assignment at expiry**: in the money by ≥ $0.01 at the expiry close → assigned (the exchange's automatic-exercise rule); at or out of the money → worthless. (Live infers assignment from ≥ $0.05 and sends the $0.00–0.05 band to manual review; a simulation needs one rule.)
2. **Buyback fill**: mid + spread cost share × (ask − bid) ÷ 2, plus $0.68 per contract.
3. **Stock fills**: no historical stock bid/ask in the plan. Buy at the look's parity price + $0.01, sell at − $0.01, commission $0.005 per share (the live estimate).
4. **Early assignment**: not modelled.
5. **Splits while a cycle holds shares**: the whole cycle stays on the price scale of its first day.
6. **Dividends**: still excluded (no dividend history before 2026 in the DB); shares held through an ex-dividend date understate the result by the dividend.
7. **Look grid**: every 30 minutes from the window start to its end (10:00 … 15:30 with the current settings, 12 looks; approved 2026-10-12). The 10:00 look stands for the opening look and uses the 10:00 capture's quotes.
8. **Cycle statistics** (from the live cycle engine's own figures): % of put positions assigned; cycle P&L; recovery time = trading sessions from the assignment to the cycle's close, reported for closed cycles, with open cycles and their age listed apart; P&L and average traded DTE per ticker.

## 8. Storage and screens

New tables replace `backtest_trades` for new sessions: `backtest_positions`, `backtest_position_legs`, `backtest_fills` (option and stock), `backtest_actions` (every Pluto action and blocked attempt with its gate results), `backtest_cycles` (one row per wheel cycle with its statistics). Session results gain: positions and cycles tables, an actions log, and a per-ticker table (P&L, trades, assigned %, average DTE, recovery sessions). Sessions take a list of symbols.

## 9. Build order

1. Probe the intraday request; macro-event history; SPY file. (Data)
2. Ledger, event applier, pure selectors with SQL parity tests, explicit settlement. (Accounting)
3. Wheel in the existing 10:00 single-symbol engine: assignment, calls on held shares, closes, rolls, the stand-in policy. Verified against hand-worked cycles and against a live staging cycle replayed through the ledger.
4. Multi-symbol sessions on one book.
5. Intraday looks inside the window; system checks per look.
6. Storage, screens, statistics.

Each step ends with tests and a real session; nothing in steps 2–6 changes live behaviour beyond the four refactors in §3.

## Build status (2026-10-12, step 5, LLM mode, rule 5, worker threads, cycle shares)

Nothing below is committed. `npx tsc -p tsconfig.json --noEmit` is clean; `npx vitest run src/backtest src/routes/backtest.test.ts` passes (31 files, 315 tests), and so do the live cycle tests (`src/lib/cycle*.test.ts`, `src/lib/closeGate.test.ts`, `src/pluto/postModelGates.test.ts`, `src/pluto/candidateFilters.test.ts`, `src/routes/positionsReadAndLiveRoutes.test.ts`: 11 files, 242 tests).

### Cycle shares that did not reconcile (fixed 2026-10-12)

- **What the stored sessions showed**: HOOD cycle 3 in `2d8dcb5d…` and `1e0541f9…` ("1,900 / 2,000 sh sold that the ledger never acquired", closed with them unaccounted); SMCI cycle 15 in `1e0541f9…` ("500 sh sold … never acquired", "ledger says 2,900 sh held but the open stock legs total 2,400").
- **The book was right.** Replaying the stored stock fills in the ledger's order (`tmp/traceBacktestCycleShares.ts`), the shares held never go below zero and every cycle ends with what its legs hold. HOOD, 2024-09-30: 10:00 sells 2,400, leaving 500 (under a call); 11:00 pass 1 opens a 24-contract buy-write (buy 2,400) and pass 2 closes it whole before the 4 Oct jobs report (sell 2,400); both fills carry the look's instant. SMCI, 2025-06-30 10:00: pass 3 buys 1,300 for a buy-write, pass 4 closes it before the 3 Jul jobs report.
- **Root cause: the platform's cycle derivation** (`src/lib/cycles.ts` `deriveOneCycle`) groups events less than 120 s apart and takes every disposal of a group before its acquisitions. Two fills at the same instant, bought then sold, were read sold-first: the 2,400 sold met a pool of 500, 1,900 were "never acquired" (their proceeds dropped), then the 2,400 bought stayed in the pool for good. The derivation's figures also feed the look's decisions (the close gate's cycle P&L, an event close's "cycle $ after the close cost"), so the session diverged from that day on.
- **Fix** (`cycles.ts`, live code, changes nothing where no flag was raised): a group whose disposals exceed what the pools hold, and that also acquires shares, takes its acquisitions first. Tests: `src/lib/cycles.test.ts` "shares bought and sold within the same moment" (fails on the old code with the same 1,900); `ledgerEvents.test.ts` "a buy-write opened and closed at the same look" through the real ledger.
- **Invariants**: the ledger refuses to sell more shares than a stock leg holds (`sellStockLegShares`) and a call assigned on shares its position does not hold (`settleExpiry`); the run names in the session's notes any cycle whose shares do not reconcile with the book (`isShareReconciliationFlag`), "their P&L is not to be trusted".
- **Re-runs on stable data**: HOOD every look (`60764a55…`, copy of `2d8dcb5d…`): 57 cycles, none flagged, +33.98% (was +32.77%: the decisions after 2024-09-30 read the corrected cycle figures; rule 5 changed nothing on HOOD). HOOD + INTC every look 2021-08-04 → 2026-10-09 (`08c5e9a3…`): 96 cycles, none flagged, +48.26%, CAGR 7.89%, Sortino 1.49, max drawdown −16.34%; buy and hold of SPY +76.41%, of HOOD and INTC +82.22%. SMCI: analysed from the stored rows only (its file is being downloaded again).
- **Churn rule built (Marcelo's ruling 2026-10-12)**: the rules skip an open their own event-close rule would close at once (`backtestPolicy.ts` `openClosedAtOnceByEventRule`; the look judges the open on a copy of the book, as Pluto would show the position right after the fill; rules only). Tests: `backtestPolicy.test.ts` ("skips an open whose position the rule would close at once") and `backtestLook.test.ts` ("an open the event-close rule would close at once": skipped and the next candidate sold; kept when what is left to earn exceeds the stress loss; *never* opens as before). HOOD + INTC every look re-run (`61ad3e1d…` against `08c5e9a3…`): +48.84% (was +48.26%), CAGR 7.97% (7.89%), Sortino 1.52 (1.49), max drawdown −16.34% (same), 850 options sold (848), 92 cycles all closed (96, 95 closed), none flagged; event closes 288 (304), of a position opened less than a day before 185 (205), in the same look 0 (32); covered calls among them 88 (115), within a day 45 (73). The day summaries name at least 61 skipped opens. What remains within a day is mostly puts (140 of 185): a put cannot be offered an event buyback at once (the ask locks no profit right after the sale), so the rule leaves them; they are closed at a later look once the ask locks a profit.
- **Before the ruling**: the open → event-close churn behind it. Pluto's top pick opens a contract whose expiry spans a heavy macro release, and the event-close rule (stress ≥ what is left to earn − the close cost) closes it at the next pass or look: of 120 event closes in the HOOD every-look session, 92 close a position opened less than a day before, 11 in the same look (SMCI + HOOD: 104 and 15 of 141). Options: leave it (live, the model chooses and would not undo its own open), or have the rules skip an open the event-close rule would close at once. A new rule: needs your decision.

### Rule 5 (done)

An open refused because one contract is larger than the order size leaves out only that candidate (`backtestOpenRefusal.ts`); tests in `backtestOpenRefusal.test.ts` and `backtestLook.test.ts` ("an open larger than the order size": 15 contracts refused at a $9,300 order size, then a $96 put sold on the same ticker). FORMULAS.md marks rules 1–4 approved and says edge capture on cycles counts the share gains.

### Scoring in worker threads (done)

- `backtestScoringPool.ts` (session thread) and `backtestScoringWorker.ts`: the two heavy steps of a symbol's look, building the day's Signals inputs (the surface fit, the elevated-volatility flag) and scoring the ticker, run on worker threads, one symbol always on the same worker, which keeps its bars and its inputs of the day; everything that reads or changes the book stays on the session's thread, in the same order. One worker per symbol up to the cores (`os.availableParallelism()`), for rules-mode sessions of two or more symbols; LLM-mode sessions and one-symbol sessions score on one thread. `BacktestRunHooks.scoringWorkers` forces a count (0 = none; tests).
- **Results identical**, compared on every stored table and the session's metrics (`tmp/rerunAndCompareBacktestSession.ts`): HOOD + INTC every look 2025-01-02 → 2025-04-30 (before `59a6c4f3…`, after `1a4c5f79…`) and 2024 (before `85bb6418…`, after `7ec3536b…`); test "a session scored on worker threads" (three symbols, one thread vs three workers).
- **Timing** (2025, HOOD's file under aliases, every look, split caches warm): 1 symbol 72 → 71–79 ms a day (no pool; run-to-run noise), 2 symbols 137 → 116, 10 symbols 618 → 336. Real HOOD + INTC: 98 → 79 (2025 Jan–Apr) and 80 → 64 ms a day (2024). What stays on the session's thread bounds the gain: reading the files, the parity prices, the filters, the close offers, the book and copying the inputs to the workers.

### API additions (2026-10-12)

Session list items (overview, compare, the session detail) carry `pnlBasis` and `wheelCycles` (cycle count, closed and open counts, Σ every cycle's P&L, Σ the open cycles' P&L; null unless the session finished and is measured per cycle). Each position carries `cycleNumber` and `cycleLabel` ("HOOD #3"): the cycle of its symbol running when it opened, the rule option sales already use (`cycleRunningAt`). Route tests cover all three.

### LLM mode (wired 2026-10-12)

- **Request**: `decisionMaker: "llm"` is accepted when `BACKTEST_CLAUDE_CLI_PATH` is set (explicit, no default), refused with a 400 naming the variable otherwise; the rules stay the default. The settings template shows the AI model as unavailable ("BACKTEST_CLAUDE_CLI_PATH is not set in the API's .env") only while it is unset. `POST /backtest/sessions` returns `llmEstimate` (`estimateLlmSession` with a full day's looks in the window) for an LLM session, `null` otherwise. A run whose CLI path is missing fails with the same message.
- **Session** (`runBacktestSession.ts`): the masking from the session's symbols in session order, stored in `backtest_sessions.llm_masking`; the CLI runs in `BACKTEST_DATA_DIR/llm-workdir` (created when missing); one `BacktestLlmSession` per run holds the call sequence, the fingerprint and model-evaluation time per ticker, and the session's last ten decisions with what came of them (`recent_decisions`). `backtest_session_llm_calls` is cleared with the session's other results; `run_statistics.llmCalls` counts the calls asked and those answered from the cache; a session note names the model, the counts and the aliases.
- **Rounds, as the live agent queues them** (`agent.ts`): the day's first look is the opening analysis (forced, every ticker); a fill queues an "order_ended" round over every ticker, ahead of the look's own round (one pending every-ticker round covers any later one); a ticker whose cooldown after a fill ended since the previous look gets a forced "cooldown_ended" round over it alone; then the look's own round over the tickers it re-quoted (live's Day Signals update, relabelled grade_crossing / held_leg by what changed). A "position_closed" round after an expiry or an assignment is the next day's opening analysis (settlement happens before the first look).
- **The pass** (`backtestLook.ts` + `backtestLlmDecider.ts`), only step 3 changes: automatic closes stay code (a fill queues order_ended); then the live change check: nothing offered → no call (fingerprints remembered); otherwise a call only when a ticker's fingerprint (`tickerFingerprint`: eligible opens plus the opens out only on quote age, eligible rolls, close offers with an event close's review step) changed and its model cooldown (`perTickerModelCooldownMinutes`) is over, unless the round is forced. The payload is `buildPlutoUserPayload` and the system prompt `buildPlutoSystemPrompt` (the session's Pluto settings), as `passRunner` builds them, with the move context (1,500 IBKR bars, IV rank over 252 days) and `minutes_to_window_end` from the day's window end; timeout `callTimeoutSeconds`. The answer: a trade maps its candidate id to the round's close, roll or open offer and goes through the same gates with the model's decision (its confidence against the floor, a ticker or the whole message flagged in the same answer refused); `chosen_because` is the model's first reason. No trade, an abstention, an unreadable answer or a failed call is no action; one decision per round: a refused choice ends the round (the queued forced rounds still run, as live). The plan's usage limit throws `BacktestLlmUsageLimitError` and the session stops.
- **Resume**: a resumed backtest job runs the session again from its first day (`resumeBacktestJob` → `clearSessionResult`); the questions asked before are byte-identical, so they are answered from `backtest_llm_calls` and only the rest reach Claude. Tested.
- **Tests**: `runBacktestSessionLooks.db.test.ts`, "a session with the AI model as decision maker" (5 tests, Claude replaced by a fake through `BacktestRunHooks.callModel`): the forced rounds (opening, after a fill, when a cooldown ends) and the trade mapped to the offer with the model's reason; the masking, system prompt, timeout and working folder; the change check (no call inside the model cooldown, none when nothing changed since the last call, the fill's round before the look's own); the confidence floor refusing a trade and the next call seeing the refusal in `recent_decisions`; an unreadable answer and a no-trade; the usage-limit stop and the resume from the cache. Request, template and route tests updated. Rules mode unchanged: HOOD, every look, 2021-08-04 → 2026-10-09 (`2d8dcb5d…`) run again on today's code is identical in every stored table and metric (`tmp/rerunAndCompareBacktestSession.ts`).
- **Live behaviour not replicated**: the quote burst before a call (the look's quotes are its freshest, so an open out only on quote age is counted in the change check, as live, but never offered); an order resting up to 15 minutes while the round goes on (fills are immediate, the order_ended round follows at the same look); a cooldown_ended round at the minute the cooldown ends (here at the first look at or after it, and only for a ticker the look re-quoted); rounds after a settings change or by hand; the consecutive-model-failures breaker and the daily cost ceiling (a failed call is no action; no usage cap by decision); concern alerts.
- Not run: a real LLM session (Marcelo runs a short one first).

Facts to build on:
- **Fix #14 in `src/pluto/postModelGates.ts`**: `open_positions_cap` lets a covered call on shares already held through (`book.freeShares >= 100`, not a roll). `backtestOpenRefusal.ts` classifies an `open_positions_cap` refusal as book-wide, which holds for every open the gate still refuses (a put, a call that buys its shares). Tested in `backtestLook.test.ts` ("does not count a call on shares already held against the open-positions cap").
- **New backtest migrations are numbered 20261013000001–20261013099999**; `20261013100001_backtest_llm_calls.ts` (LLM-mode cache and call log) belongs to the LLM-mode work, as do `src/backtest/llm/*`.
- **SMCI's file is being downloaded again (intraday quotes) since the step-5 runs**: an SMCI session run now differs from the results below for that reason; compare SMCI sessions only with runs on the same file.
- Step-5 migrations (applied to the local dev and test DBs): `20261012800001_backtest_looks_inside_the_window.ts` (session `notes`, `run_statistics`; day `looks_run`, `actions_taken`; action `look_time`) and `20261012900002_backtest_cycle_pnl_and_spy_baseline.ts` (session `pnl_basis` — 'option' for older sessions, 'wheel_cycle' for new runs — and `spy_baseline_metrics`; day `spy_baseline_value`, `spy_baseline_daily_return`; trade `position_id`, `position_status`, `position_pnl_dollars`, `cycle_number`, `cycle_status`, `cycle_total_dollars`).

### Done and tested

- **Incomplete files refused**: `readBacktestDataFilePeriodContents` (`dataFileSummary.ts`) + `validateCreateBacktestSessionRequest`: "INTC's file has 828 weekdays missing between … and …: finish its download or shorten the period"; holidays and `unavailable_days` are not gaps; days without intraday quotes come back as `warnings` in `CreateBacktestSessionResponse`.
- **Looks inside the window**: `lookTimesInWindow` (`runBacktestSession.ts`), `BacktestSymbolFile.loadIntradayDays/loadIntradayQuotes`, per-look scoring in `backtestLook.ts` (10:00 surface, look quotes as "day" quotes, sticky moneyness, per-expiry IV shift, scoring instant = the look); fills at the look's quotes; `maxIvShiftVp` editable.
- **System checks per look**: daily-loss breaker vs the previous close's mark, actions cap over the day, SPY market stress from IBKR 30-minute bars (backfilled 2020-01-02 → 2026-10-09 by `npm run backtest:backfill-market-stress-bars`), ticker cooldown on real instants.
- **Macro-event history** (`macroEventHistory.ts`, `macro-events.json`), F3 closes, `policy.eventClose` editable.
- **try_next with the account-level refinement** (default): `backtestOpenRefusal.ts`, one comment per gate; "no further opens on SMCI: no ticker room" once a day.
- **Wheel-cycle P&L as the headline**: `sessionAnalytics.ts` (win rate, averages, edge capture over closed cycles; accuracy bands by the first sale's margin), each option sold carries its position's P&L and its cycle (`buildOptionTrades`), `pnlBasis` in the detail. FORMULAS.md rewritten ("Trades and wheel cycles").
- **Baselines, comparison only**: equal-dollar buy and hold of the symbols, and buy and hold of SPY (`spyBuyAndHold.ts`: whole shares at SPY's 10:00 price — close of the 09:30 bar, else the day's IBKR open — rest in cash at the session's interest, no dividends). Stored per day with metrics; the detail returns both with labels; the comparison returns "spy:<id>" curves. FORMULAS.md "Baselines (comparison only)".
- **Earnings known 30 days ahead**: `earningsDateKnownCalendarDaysAhead` + `earningsKnownOn` (`backtestTickerInputs.ts`) feed Signals' exclusion, the next-earnings date and Pluto's closes before earnings; read-only template row "Earnings dates known 30 days ahead". Test: 30 days out seen, 31 not.
- **Rolls**: unchanged, Pluto's own flags only.
- **Tests (a)–(h)**: `runBacktestSessionLooks.db.test.ts` (9 tests incl. the SPY baseline) and "a look after 10:00" in `backtestLook.test.ts`.

### Signed off by Marcelo (2026-10-12; formulas or conventions decided while building)

1. Return on capital in use, on cycles: Σ every cycle's total ÷ Σ over the session days of (EXP $ held that day × calendar days to the next session day) × 365 (the per-option definition no longer exists). Approved.
2. The daily-loss breaker's reference: the account at the previous session's close = cash + shares × IBKR close − short options × their closing-quote mids (intrinsic value for an option expiring that day); the first day's reference is the starting value. Approved.
3. SPY's day change for market stress: the close of the 30-minute bar ending at the look ÷ the close of the previous session's last bar − 1. Approved.
4. SPY's 10:00 price for its baseline: the close of the 09:30–10:00 bar, else the day's IBKR open, else the last price. Approved.
5. Changed: an open refused because one contract is larger than the order size leaves out only that candidate; the rules try the next one (a lower strike on the same ticker may fit). Built in `backtestOpenRefusal.ts`, tested in `backtestOpenRefusal.test.ts` and `backtestLook.test.ts` ("an open larger than the order size").
6. Edge capture on cycles keeps the share gains in a cycle's total, on purpose; FORMULAS.md says so.

### Performance

Profile of ten symbols (HOOD's file under ten aliases), March–May 2025, every look: 614 ms a day with the split inference each alias pays once (7 s of 39 s, absent from real sessions once the split cache exists); about 490 ms a day without it. Where the time goes: `scoreTicker` 41% (mid-IV inversion 15%, the valuation model 18%, `computeExpiryIvShifts` 8%), the day's surface fit 15% (once a symbol-day), the elevated-volatility flag 5%, reading the intraday quotes 5%, `expirySpansMacroEvent`'s `easternInstant` per quote 4%. Small safe win taken: the intraday quotes are read as arrays without sizes and the look indexes its quotes only when a held leg needs one (1 symbol, 2025: 96 → 73 ms a day). Structural options: score the symbols of a look in worker threads (built, see above); compute each quote's mid IV once per look (live `signalCandidates.ts` computes it twice: candidates and IV shift); skip scoring a symbol that can do nothing at a look (no position and opens barred).

Benchmark after the small win (one year, 2025, HOOD's file under aliases, every look, split inference included): 1 symbol 73 ms a day, 2 symbols 140, 10 symbols 622 (was 96 / 160 / 696). A 6-year, 10-symbol session: about 1,512 days × 0.6 s ≈ 15 minutes, at the limit, not well under it; the structural options above are what would bring it down.

### Results at the end of step 5 (dev DB: cycle-basis metrics, both baselines, grade cut points 20/10/0, earnings known 30 days ahead), 2021-08-04 → 2026-10-09; before the cycle-shares fix, re-runs above

| Session | Return | CAGR | Sortino | Max DD | Options sold | Cycles (closed) | Cycle P&L | Refused | SPY buy and hold | Symbols buy and hold |
|---|---|---|---|---|---|---|---|---|---|---|
| HOOD, one look, step-4 rules `0fea936e…` | +33.70% | 5.76% | 1.61 | −12.52% | 138 | 26 (26) | 147,166 | 131 | +76.41% | +67.10% |
| HOOD, every look, defaults `2d8dcb5d…` | +32.77% | 5.62% | 1.71 | −12.54% | 359 | 52 (52) | 135,547 | 1,925 | +76.41% | +67.10% |
| SMCI + HOOD, one look, step-4 rules `f206dc07…` | +51.81% | 8.39% | 1.79 | −12.52% | 268 | 51 (50) | 324,945 | 276 | +76.41% | +532.14% |
| SMCI + HOOD, every look, defaults `1e0541f9…` | +42.49% | 7.07% | 1.41 | −12.54% | 504 | 69 (68) | 232,229 | 2,134 | +76.41% | +532.14% |

"Step-4 rules" = one look at 10:00, stop at the first refusal, no closes before macro events. Every closed cycle made money in all four (cycle win rate 100%): the platform's own close rules only close shares in profit above the floor, calls that clear the break-even, buybacks and event closes at a profit, so a losing cycle stays open. Edge capture on cycles is 2.7–6.0 because a cycle's total includes what its shares made, which the options' Edge $ never predicted (counted on purpose: Marcelo 2026-10-12). Between the two SMCI + HOOD rows: the every-look run closed 55 whole covered-call positions (shares sold) and bought back 86 puts before macro releases (HOOD 45 and 77, SMCI 10 and 9), and 18 legs before earnings (now that a report's date becomes known only 30 days ahead, an option sold earlier can span it); SMCI's cycle P&L fell from 169,652 to 93,312 while HOOD, looked at 12 times a day, took more of the shared budget (SMCI has no intraday quotes yet). Taken one change at a time in the earlier step-5 runs (older grade cut points), adding the closes before macro events cost about 13 points of return on SMCI + HOOD, choosing again after a refusal about 0, and the looks after 10:00 added about 3.
