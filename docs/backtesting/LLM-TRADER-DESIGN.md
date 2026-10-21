# Backtesting — LLM Trader design (draft for approval)

Status: **draft, 2026-10-20, nothing built.** Section 1 records what Marcelo decided; everything after it is proposed and
waits for his approval (the decisions to take are collected in §16). Formulas need explicit sign-off before they are
implemented. Code references are to the working tree of 2026-10-20 (another session had uncommitted engine edits then).

## 0. In plain language

A new way for a backtest to decide trades. Instead of fixed rules, Claude reads a full picture of the market and the
account during the trading day and decides what to do: sell puts, sell covered calls, buy back, roll, buy or sell shares.
Code still enforces a handful of hard limits. Every six months of simulated time, Claude reviews its own results: where the
money came from, where it was lost, and every trade with what it knew when it made it. It writes down what it concluded as
guidance for the next six months. The guidance is treated as hypotheses to check, not as rules, and each one keeps a record
of how it was tested and whether it held. Because the review only ever looks back and the guidance only applies going
forward, every period it trades is new to its guidance. A session with this decision maker and a session with the
mechanical wheel can then be run on the same stocks, money and dates and compared.

## 1. Decided (Marcelo, 2026-10-20)

- The idea: the model gets everything we have at each look (what the screens show, plus open interest and option volume)
  and decides; hard limits are few, told to the model and also enforced by code; it learns across iterations from detailed
  results (where yield came from and where losses happened) and writes conclusions it uses as guidance next time,
  including what works on which stock.
- The model knows nothing of earlier runs except the conclusions it saved. Conclusions are fed back with the instruction
  that they must be verified; wrong ones are expected and are refuted by testing. It keeps the history of everything it
  tried.
- Tested on full periods (years), walking forward through them once.
- Tickers: HOOD, PLTR, INTC.
- Built into the backtest engine as a decision maker chosen by session settings, so a session with it and a session with
  the mechanical wheel compare directly.
- Looks every 30 minutes; to keep costs down the model is asked only when something material changed, as Pluto does.
  Pluto's own trigger rate on staging is high because of the Edge model; this decision maker will be asked far less.
- Training runs on the Claude subscription (Claude Code CLI). Validation sessions run on gpt-6-luna through OpenRouter, and
  **only with Marcelo's explicit permission each time**.
- Later, on staging, it runs on an API key and is paid per use (out of scope here).

## 2. What the experiment showed (2026-10-20, `tmp/llm-trader-experiment/`)

A throwaway harness (one look a day at 10:00, HOOD + INTC, $100k, parts of Q2 and Q3 2024, Sonnet 5.5 at medium effort as
the trader, Opus 5.5 at high effort for the review):

- **Cost and speed:** about 12k tokens in and 500 out per call, $0.042 of subscription usage (API-equivalent), 5–7 s. Each
  ticker adds about 4,100 tokens (the option chain is numbers: about 1.2 characters per token). The CLI writes the whole
  prompt to its 1-hour cache at twice the input price on every call.
- **The model knows where it is:** asked outright, Opus named both stocks and the exact period from masked snapshots: 93–95%
  sure with today's masking (aliases, dates shifted 1,044 weeks), 85–90% even with no dates and rescaled prices. Every year
  before the models' training cutoff (about mid-2026) can carry look-ahead. The trader itself never mentioned a company or a
  year in 231 decisions and held INTC through its 2 August 2024 drop.
- **Behaviour:** sensible, rule-like trades (|delta| 0.1–0.3, 1–4 weeks, puts expiring before earnings), about 25% of the
  account invested; its lead over holding the stocks was that low exposure, within about a point of an exposure-matched
  portfolio, like the mechanical wheel. It never rolled. It wrote no malformed order in 231 looks.
- **Noise:** two runs on identical inputs ended 3.7 and 5.2 points apart in 8 weeks; on 29 July 2024 the two runs with the
  same lessons made opposite decisions on the same INTC shares.
- **The review:** well argued (it credited its result to holding cash), but its top rule (sell only when IV beats 21-day
  realised volatility) is the filter the wheel research rejected on 5 tickers over 2020–2025, and the next runs sized up on
  it.

So: reviews look only backwards; lessons are verified on later periods with evidence computed over every contract (not
the model's 15 trades); several runs per setup separate learning from noise; results before the cutoff are not proof.

## 3. Where it plugs in

- **A fourth decision maker**, `"llm_trader"`, beside `"rules"`, `"llm"` (Pluto's choice among candidates, unchanged) and
  `"baseline"` (`BacktestDecisionMaker`, `backtestTypes.ts:21`; read in `runBacktestSession.ts`). Like the Baseline it gets
  its own branch at the look (`runBacktestSession.ts:911`) with the shared signature
  `(BacktestLookContext) => Promise<BacktestLookResult>`, and like the Baseline it skips Pluto's breakers (daily loss,
  actions cap, SPY stress): its only rules are its hard limits.
- **The day stays the engine's:** expiries settled at the close, interest, the 10:00 marks and day row, then the looks
  every 30 minutes (`lookTimesInWindow`), each re-marking the legs at the look's quotes and IBKR price.
- **At each look** the decision maker: (1) checks the triggers (§6); if none fired, does nothing; (2) builds the snapshot
  (§4) from the look context; (3) asks the model; (4) parses the answer against a strict schema; (5) checks every action
  against the hard limits and the ledger's own rules, in a fixed order, on a copy of the figures so each check sees the
  effect of the actions before it; (6) applies the accepted ones through the ledger and records them; (7) keeps the
  refused ones with their reason for the next ask.
- **Ledger events used:** `openCashSecuredPut`, `openCoveredCall` (calls on shares held: no purchase), `rollLeg`,
  `buyBackPut`, `buyBackCoveredCallKeepingShares`, `closeCoveredCall`, `sellShares`, and the engine's settlement.
  **New:** a `buyShares` event (shares into the stock's uncovered position, from the ledger's internal
  `receiveUncoveredShares`), and an action kind for it (the `backtest_actions.kind` check needs a migration).
- **Checked before the ledger** (it throws on these and a throw fails the session): whole contracts only; no second
  position on a contract already held (the model is told to buy back first); no selling shares not held or covering a call;
  enough free cash (the ledger lets cash go negative).
- **Fills:** the engine's (`ledgerFills.ts`): options sold at the mid less the session's spread charge × half the spread,
  bought back at the mid plus it (`trading.spreadCostChargedPct`); shares at the look's IBKR price; $0.68 a contract and
  $0.005 a share. The same setting applies to the Baseline session it is compared with.
- **Records:** a `BacktestAction` per action (its "Chosen because" is the model's thesis), a `BacktestOptionSale` per option
  sold (the trades table comes from these), each new leg's mark; plus the trader's own tables (§13).

## 4. What the model sees (the snapshot)

One text snapshot per ask, covering the whole book (one call for all its tickers), in this order:

1. **Look:** the masked date and weekday, the look time, what triggered the ask.
2. **Market:** SPY's change since the previous close (`dayChangePercentAt`), 5-, 21- and 63-session returns, 21-day realised
   volatility, its IV index and 52-week rank; macro events in the next 10 days, today's with their time.
3. **Account:** value and change since the start, cash, put collateral, free cash, each stock's exposure against limit 2,
   shares with average cost and unrealised P&L, open options (sale price, current mid, unrealised P&L, delta, DTE), realised
   P&L so far by source.
4. **Recent decisions:** what it did at its last asks and what happened (filled, refused with the limit and the numbers,
   expired, assigned, called away), and the note it left itself (at most 600 characters).
5. **Experience:** the playbook and the hypotheses under test (§8), marked as guidance to verify, not rules.
6. **Each stock:** price at the look, previous close, today's open and gap, today's move in 21-day standard deviations,
   returns over 5/21/63/252 sessions, 52-week range, 20/50/200-day averages, realised volatility (10/21/63 days), the
   largest daily move in 63 sessions, the IV index with its 52-week rank and percentile (`ivRankBefore`), the next earnings
   date when within 30 days (known 30 days ahead, `earningsKnownOn`) and the last four earnings reactions; the valuation
   model's FV 21d.
7. **Each stock's option chain:** expiries 0–45 days; per expiry the forward, at-the-money IV, the straddle as a share of the
   price and a "spans earnings" flag; per contract bid, ask, IV, delta (the Baseline's per-quote Black-76 figures,
   `selectBaselineCandidates`), the valuation model's edge margin and grade (`scoreTicker` at the look), open interest
   (yesterday's close) and yesterday's volume; contracts with |delta| 0.05–0.55 thinned to at most 10 per side per expiry,
   plus anything held.

A compact number format (IV and edge margin as whole percentages, open interest and volume in thousands above 10,000) cuts
tokens; measured before it is fixed.

## 5. What it can do, and the hard limits

**Actions** (any number per ask, applied in this order): buy back an option (all its contracts); roll (buy back and sell
another of the same type on the same stock at the same look, same contracts); sell shares; buy shares; sell covered calls;
sell cash-secured puts. Each names the contract exactly as shown and carries a one-sentence thesis and the ids of the lessons
it relies on.

**Hard limits** (the only rules; told to the model and enforced by code; each a session setting):

| # | Limit | Proposed default |
|---|---|---|
| 1 | No leverage and nothing naked: every open put backed by cash, every call by shares held, no purchase beyond free cash | always |
| 2 | Per stock, at most this share of the account, measured as the platform's order gate measures concentration (`evaluateOrderLimitFigures`, exposure net of premium, as live) | 60% |
| 3 | Expiries | 0–45 days |
| 4 | Liquidity of an option it sells, the Baseline's own rules: bid at least $0.05, spread at most the session's maximum share of the mid, contracts at most 20% of the previous day's volume | as the Baseline |

A refused action is reported back at the next ask with the limit and the numbers ("limit 2: STOCK_A would be 64% of the
account, above 60%"). Limits 1–4 use the same definitions and settings as the Baseline and live where those exist, so the
comparison is like for like.

## 6. When it is asked

The look grid stays every 30 minutes (10:00–15:30, the window pulled in on early closes as today). At each look code
decides whether anything material changed; only then is the model asked:

- **10:00:** always (the day's review; expiries, assignments and call-aways since the last ask happen at the close, so it
  sees them here).
- **Price move:** any stock of the book moved at least k daily standard deviations (21-day realised) since the last ask.
- **A held option crossing into the money** since the last ask.
- **The Fed decision:** the 14:30 look on decision days (the first look after the 14:00 release).

Measured on HOOD + PLTR + INTC, August 2021 to December 2025 (price moves alone, IBKR 30-minute bars as the engine prices
looks):

| k | Asks a day (mean; 90% of days at most) | Share of the 12 looks |
|---|---|---|
| 0.5 | 3.1 (5) | 26% |
| 0.75 | 2.0 (3) | 17% |
| 1.0 | 1.6 (2) | 13% |

Proposed default k = 0.75. These are the trader's own triggers, not the existing LLM mode's fingerprint, which hashes the
Edge model's grade, Edge $ and margin and so re-asks on every grade crossing (Pluto on staging made 108–344 calls a day,
each ticker in 26–64 of them). Each ask records which trigger fired.

## 7. Models and calls

- **Trader:** Claude Sonnet 5.5 at medium effort through the subscription CLI (the existing client: no tools, strict JSON
  schema, an empty working folder outside every project). Model and effort are session settings.
- **Reviewer:** Claude Opus 5.5 at high effort, same client.
- **Validation sessions:** gpt-6-luna through OpenRouter (Pluto's existing client), only with Marcelo's explicit permission
  each time; the session form shows the estimated spend before Start.
- **Samples:** the existing cache is keyed by the request alone, so two sessions with the same settings replay the same
  answers. This decision maker adds a **sample number** (a session setting, default 1) to the cached request: the same
  sample replays (a session can be reproduced), different samples are independent runs. A session stopped by the plan's
  limit resumes as today: it starts again from its first day and its answered calls come back from the cache.
- **Masking:** symbols as STOCK_A… and dates shifted, as the existing LLM mode. It does not stop a determined model (§2); it
  only keeps names and years out of the text. Results are judged with that in mind (§11).

## 8. The experience: playbook and hypothesis log

One document per version, written by the reviewer, two parts:

- **Playbook:** the rules that currently hold up, each with an id, its evidence and a confidence (low: 1–3 cases; medium:
  4–10 consistent; high: more, across periods); at most 900 words. Stock profiles describe how each stock behaves
  (volatility and its clustering, gap risk, earnings reactions against what options priced, chain liquidity), never where
  its price went.
- **Hypothesis log:** every hypothesis it ever formed, kept for good: id; the rule as a condition on data the snapshot
  shows; where it was formed (period, stocks, evidence); each test (period, stocks, number of cases, result); status
  (testing, supported, refuted, retired). A hypothesis is confirmed only by evidence from later periods or other stocks than
  the ones it came from; a refuted one stays listed so it is not retried blindly (it can be reopened with new evidence).

The trader sees the playbook and the hypotheses under test ("verify, don't trust"; it may depart from any lesson when the
data argue against it). The reviewer sees the whole log, the previous version and the period's evidence.

## 9. Reviews inside a session (walk-forward)

One session is one chronological run. Every six months of simulated time (a session setting; 0 = no reviews, the control)
the session pauses after the period's last look and the reviewer is called with:

1. The period's results: return, Max drawdown and Sortino against holding the stocks and T-bills; where the money came from
   by stock and source (premium kept on puts and calls, share P&L, interest, costs); every option position with its entry
   context (DTE, delta, IV, IV rank, RV21, strike vs price, open interest, earnings), the outcome, the P&L, the
   hold-to-expiry outcome when it was closed early, its thesis and lesson ids; the refused actions by limit.
2. Evidence computed by code over every contract of the period, not only the ones it traded (formula below).
3. The previous experience and the full hypothesis log.

It returns the next version and a summary of changes; the session goes on with it. A session can also start from a stored
version (to continue on a later period, or for validation).

**Evidence tables (formula to approve):** per stock and type (put, call), for each trading day of the period, every
contract at the day's 10:00 quotes with DTE 1–45 and a two-sided quote, sold at the mid and held to expiry: premium kept per
dollar of collateral (put: strike × 100; call: the 10:00 price × 100), annualised by DTE, and the share assigned. Reported
as means with the number of contracts, by |delta| (0.05–0.15, 0.15–0.25, 0.25–0.35, 0.35–0.55), DTE (1–7, 8–21, 22–45),
contract IV ÷ 21-day realised volatility (under 0.9, 0.9–1.1, 1.1–1.3, over 1.3) and spans earnings (yes, no), each on its
own (about 80 rows for three stocks). The period ends before the review, so nothing in them is from the future.

## 10. Comparing it with the mechanical wheel

Two sessions on the same stocks, starting value, dates and spread charge: one with the LLM Trader, one with the Baseline
decision maker on the lab's settings (the CC + Put Ladder). Both are one shared account (the Baseline's pots only weight its
ladder), so the same starting value makes them comparable. They are compared on the existing Compare page (sessions picked
in the Sessions table); a batch today holds one decision maker, so mixing them in one batch is a later option.

Figures for both: CAGR, Sortino over T-bills, Max drawdown, Excess Calmar; where the money came from (the attribution
approved 2026-10-14); option income (approved 2026-10-14); and alpha over an exposure-matched portfolio (each day the
dollars each stock had exposed, the rest in T-bills; formula to approve), since the experiment's "outperformance" was
exposure. Several samples per setup (3 with reviews, 3 without) before reading a difference.

## 11. Leakage: how results are judged

Claude's training data covers the backtest years. Results from before its cutoff can be inflated by memory, and the reviewer
(Opus, high effort, reading outcomes) is where memory would leak most. So:

- Learning runs walk forward August 2021 → December 2025; nothing there is proof of skill.
- The judgement is on data after the cutoff: January–June 2026 as a check and July–October 2026 as the final test, each with
  the final experience against no experience, then the validation sessions on gpt-6-luna (with permission).
- Every result is reported against the exposure-matched portfolio and the Baseline, not against holding the stocks alone.

## 12. Cost and time (measured; Claude through the subscription, API-equivalent)

| | Per call | Calls per run (Aug 2021 → Dec 2025) | Per run | Model time per run |
|---|---|---|---|---|
| Trader, three stocks, k = 0.75 | about $0.06 | about 2,500 | about $150 | about 6 h |
| Reviewer | about $0.20 | 9 | about $2 | about 10 min |

The plan's limits stop a session part way (≈150 parallel calls plus a long working session hit the 5-hour limit once on
2026-10-20); it resumes from its own cached answers. Start with one run with reviews and one without, then decide on more.
A validation session on gpt-6-luna (flex tier, measured on staging: $0.04 per million tokens in, $0.24 out) would cost
about $2–3 of OpenRouter spend per run.

## 13. Storage

Reused: the session tables (days, trades, positions, legs, fills, actions, cycles), metrics and run statistics; the call
cache `backtest_llm_calls` (the sample number goes into the hashed request).

New (one migration):

- `backtest_trader_asks`: one row per ask (session, sequence, trading date, look time, triggers, request hash, cache hit,
  outcome, the actions as answered, each action's result (filled with its action id, or refused with the limit), the note,
  error). The masked snapshot and raw answer stay in the cache row.
- `backtest_trader_experiences`: one row per version (session that wrote it, version number, parent version, period
  reviewed, playbook, hypothesis log as JSON, summary of changes, the evidence tables and period report it was given,
  reviewer model, request hash). A session's settings can name a starting version.
- `backtest_actions.kind`: add `buy_shares`.

Like every result table, these are cleared when a session restarts and refilled from the cache.

## 14. Screens (mockup first, on the real theme tokens)

- **New session:** "LLM Trader" in the Decision maker select; its settings group (`llmTrader.*`, flowing through the
  template rows like the Baseline's): trader and reviewer model and effort, review every N months (0 = none), starting
  experience version, sample number, the four limits, the trigger's k, the provider (Claude subscription, or OpenRouter with
  a warning that it spends money). An estimate card before Start like the AI model's (calls, hours, API-equivalent cost).
- **Session page** (one stack of cards, as today): the existing cards (KPIs, value chart, buy and hold, cycles, trades,
  positions, actions log with the thesis as "Chosen because", fills); two new collapsible cards: **Model asks** (each ask:
  look, trigger, actions with their result, note; the snapshot and raw answer in a modal) and **Reviews** (each version with
  its summary of changes).
- **Experience window:** an inset window like Lab settings (three columns): versions on the left, the playbook in the middle
  (with a diff against the previous version; no diff library in the app today, so a small helper), the hypothesis log with
  status and tests on the right.
- **Compare:** the existing Compare page.

## 15. Build order

1. Decision maker, snapshot, actions on the ledger (with `buyShares`), hard limits, the sample in the cache; a short HOOD +
   PLTR + INTC session checked against the harness.
2. Triggers and their record.
3. Reviews, evidence tables, experience versions and the hypothesis log.
4. Reports (§10).
5. Screens, from an approved mockup.
6. First runs (one with reviews, one without) on the subscription; validation on gpt-6-luna only when Marcelo says so.

## 16. Decisions needed

| # | Decision | Proposed |
|---|---|---|
| D1 | A fourth decision maker, "LLM Trader"; the existing AI model mode unchanged | yes |
| D2 | Freedom: any contract in the snapshot, any size, within the hard limits (not only Pluto's candidates) | yes |
| D3 | The four hard limits and their defaults (§5): 60% per stock, 0–45 days, the Baseline's liquidity rules; Pluto's breakers not applied | as §5 |
| D4 | The snapshot (§4), including the valuation model's edge margin and grade per contract (needs the 10:00 surface fit and scoring at each ask: slower runs) | as §4 |
| D5 | Triggers (§6): 10:00, price move k = 0.75, a held option going into the money, the Fed decision | as §6 |
| D6 | Trader Sonnet 5.5 medium, reviewer Opus 5.5 high, both on the subscription | yes |
| D7 | A sample number in the cache key | yes |
| D8 | Masking as the existing LLM mode, no price rescaling | yes |
| D9 | Experience rules (§8): confirmation only from later periods or other stocks; 900-word playbook; the log kept for good | as §8 |
| D10 | Reviews every 6 months; the evidence formula (§9) | sign-off |
| D11 | Comparison via the Compare page; the exposure-matched alpha formula (§10) | sign-off |
| D12 | Starting value $300k for both sessions; the spread charge the lab's, the same for both | $300k |
| D13 | Learning Aug 2021 → Dec 2025, check Jan–Jun 2026, final test Jul–Oct 2026 | as §11 |
| D14 | First runs: one with reviews, one without, sample 1; more samples after | yes |
| D15 | PLTR is one of the six hold-out tickers of the ladder study; using it here spends it for this test | confirm |
