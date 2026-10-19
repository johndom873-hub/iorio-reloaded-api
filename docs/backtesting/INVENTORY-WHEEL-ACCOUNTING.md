<!-- Read-only code inventory of 2026-10-12 (a research agent's report, kept as the spec input for docs/backtesting/FULL-FIDELITY-DESIGN.md). File:line references are as of that day. -->

# Live wheel accounting inventory and simulated-book spec (read-only research)

Repo: `/Users/marcelo/Sites/iorio-reloaded-api`. Nothing was edited. All paths below are relative to that root unless absolute.

One thing to flag first: a tool result (the read of `src/lib/orderGates.ts` / `src/lib/deltaBandGate.ts`) came back with a block appended that was styled as a system reminder, saying the session context had been re-read and giving a different user email. It was not from the user or you, so I ignored it and changed nothing.

## 0. Headline findings

- **The cycle and break-even maths are already pure.** `deriveCycles`, `summarizeOpenCycle`, `checkCalledAway`, `runPostModelGates`, `filterTickerForPluto`, `deriveCloseLiveState` and the P1/P2/P3/P3b/F3 evaluators take plain objects. The backtest can call them today.
- **What is SQL-bound is the position-level figures and the state machine.** `capitalAtRisk`, `capitalDeployed`, realized P&L, free shares, cash locked in puts, and the whole reconciler exist only as SQL or as DB-writing code.
- **The live reconciler cannot be replayed on history as it stands.** It stamps `entry_at` / `exit_at` / `closed_at` with `now()` and uses wall-clock windows (30 min, 10 min, 5 min). The cycle engine groups events within 120 seconds, so a replay would collapse years into one group.
- **Recommendation: an in-memory ledger mirroring the live rows, plus small pure selectors that mirror the SQL, pinned by parity tests against the real SQL.** Details in section 5.
- **The backtest currently hard-codes the wheel off.** `freeShares: 0`, `openShortLegs: []`, no `cycleBreakEven`, `macroEvents: []` (`src/backtest/engine/backtestDayDecision.ts:242,248-249,293,327`), and cash-settles everything (`src/backtest/engine/backtestBook.ts:170-179`).
- **Recovery Path is not used by Pluto.** Its only caller is the positions route (`src/routes/positions.ts:1710-1719`).
- **Several decisions need Marcelo's formula sign-off** before implementation (assignment rule, buyback/stock fill prices, stock quotes, splits across a held cycle). Listed in section 6.

---

## 1. Live data model

### 1.1 Tables

| Table | Key columns | Source |
|---|---|---|
| `positions` | `strategy_key` (`covered_call`, `cash_secured_put`, `unstructured`, `hedge`), `status` open/closed, `opened_at`, `closed_at`, `close_reason`, `unstructured_reason` | `src/db/migrations/20260812000004_create_positions.ts`, `20260828000001_add_close_and_unstructured_reasons.ts` |
| `position_legs` | `leg_type` stock/option, `side`, `quantity`, `option_type`, `strike_price`, `expiry_date`, `multiplier` (default 100, stock stored as 1), `ibkr_contract_id`, `entry_price`, `entry_at`, `exit_price`, `exit_at`, `parent_leg_id`, `settlement_audit_acknowledged_at` | `20260812000005_create_position_legs.ts`, `20261006100010_add_parent_leg_id_to_position_legs.ts`, `20261001000001_add_settlement_audit_acknowledged_at_to_position_legs.ts` |
| `trades` | `position_leg_id`, `side` buy/sell, `quantity`, `price`, `commission`, `executed_at`, `is_closing_trade`, `ibkr_exec_id` (unique), `source_order_request_id` | `20260812000006_create_trades.ts`, `20260820000003_...`, `20260901131134_...` |
| `order_requests` | `request_type` (`open_covered_call`, `open_cash_secured_put`, `roll_leg`, `close_position`), `payload` (legs with `role`, `action`, `quantity`, `unitPrice`, `strike`, `expiry`, `right`, `positionLegId`), `status`, `related_position_id`, `pluto_action_id` | `20260824052057_create_order_requests.ts`, `src/ibkr/ibkrGatewayOrderPayload.ts:11-40` |
| `position_share_sources` | `(position_id, source_position_id)`: where a position's shares came from | `20261006100009_create_position_share_sources.ts` |
| `position_pnl_snapshots` | nightly `unrealized_pnl`, `premium_pnl`, `stock_pnl`, `market_value` per open position | `20260812000009_...`, `20260908000002_...`, written by `scripts/run-daily-pnl-snapshot-job.ts:301-342` |
| `pluto_actions` | `kind` (open_covered_call, open_cash_secured_put, roll, close_shares, close_leg, close_position, no_trade), `outcome`, `order_request_id` | `20261006100001_create_pluto_tables.ts` |
| Cycles | **No table.** Derived at read time from legs, stock trades and daily bars | `src/lib/cycles.ts:1-24`, `src/lib/cycleBreakEven.ts:1-28` |

Structural rules:
- One position per distinct option contract. A covered call is exactly one short call leg plus one stock leg of `contracts × 100` shares (`src/ibkr/ibkrGatewayReconcilePositions.ts:306-343`).
- `strategy_key` is fixed at creation. A structure change is a close plus a new position, never a relabel (`:335-342`).
- Only the worker writes positions, legs and trades. The web side only writes `order_requests`.

### 1.2 Price conventions that the simulation must copy

- **Option leg `entry_price`** = IBKR average cost ÷ multiplier, which is already net of the opening commission (`ibkrGatewayReconcilePositions.ts:667`, `src/lib/legRealizedPnlSql.ts:1-9`). For a short: fill − commission per contract ÷ 100.
- **Stock leg `entry_price`** = IBKR average cost per share, commission included. For assigned shares IBKR reports strike − put premium; the worker corrects it to the strike when its FIFO ledger reproduces IBKR's numbers (`:618-633`, `src/lib/stockCostBasisLedger.ts:129-136`).
- **`exit_price`** = raw weighted-average closing fill (`src/lib/partialCloseSlice.ts:21-25,54-58`). Closing commissions live on `trades.commission`.
- **Expiry or assignment** leaves no trade row on the option, so no commission; `exit_price = 0` (`ibkrGatewayReconcilePositions.ts:461`).
- **A handoff** (shares moving between positions) closes the stock leg at `exit_price = entry_price`, zero P&L, and re-creates it on the successor at the same price (`:289-304`).

### 1.3 How trades are recorded

`src/ibkr/ibkrGatewayOrderTracking.ts:339-396`:
- A fill is closing when it is a buy on a short leg or a sell on a long leg (`:368`).
- A closing fill only inserts a trade. It never closes the leg; reconciliation does that when IBKR's holding reaches zero (`:378-381`).
- A fill with no open leg yet is buffered and written as an opening trade when reconciliation creates the leg (`:356-366`, `:399-406`).
- Commissions arrive separately and update the trade row (`:296-314`).

### 1.4 The reconciliation pass

`reconcileHeldPositions` (`ibkrGatewayReconcilePositions.ts:344-394`) runs three steps, then the expiry audit:
1. `closeLegsNoLongerHeld` (`:413-474`): closes every open leg IBKR no longer holds. Exit price is the closing-fill average; else 0 for an option past its expiry with no trade; else the entry price for covered-call stock whose sibling option expired; else null (`:461`).
2. `syncHeldStructures` (`:476-550`): long options become `hedge` positions, each short put its own `cash_secured_put`, each short call paired with `contracts × 100` shares as a `covered_call`, everything else `unstructured`.
3. `closeOrphanedOpenPositions` (`:562-571`).
4. `correctExpirySettlementsNow` (`:52-66`) runs the expiry audit when anything closed.

A position closes in exactly one place, `finalizeClosedPosition` (`:210-226`), which sets `close_reason` from `determineCloseReason` (`:138-199`): `assigned`, `closed_via_app`, `closed_via_external_trade`, `expired_worthless`, `unknown`, or the override `stock_rolled_into_covered_call` (`:24`).

### 1.5 Lifecycle events, as they end up in the tables

| Event | Resulting rows |
|---|---|
| **Open cash-secured put** | New `cash_secured_put` position, one short put leg with `entry_price` = fill net of commission, one opening trade (`:986-1043`). Cycle opens if the symbol was flat. |
| **Open covered call as a Covered Call entry** | Order has a stock BUY leg for the shortfall and a call SELL leg (`src/routes/positions.ts:1020-1075`). New `covered_call` position with call leg and stock leg (`:841-976`). |
| **Open covered call on held shares** | Order has no stock leg (`routes/positions.ts:1027-1043`). New `covered_call` position; the unstructured position's stock leg is handed off at entry and that position closes with `stock_rolled_into_covered_call`; a share-source link is recorded (`:934-975`). Shares beyond the calls stay in an unstructured position (`:1084-1143`). |
| **Put expires out of the money** | Put leg `exit_price = 0`, position closes `expired_worthless`. Cycle closes if nothing else is open. |
| **Put assigned** | Put leg `exit_price = 0`; position `close_reason = assigned` (`:158-178`, or by the audit `src/lib/expirySettlementAudit.ts:141-150`). IBKR reports a stock buy at the strike, recorded as an opening trade on a new `unstructured` position with `unstructured_reason = csp_assigned_stock` (`:92-126`, `:759-833`); share source linked to the put (`:275-287`). Stock entry ends at the strike once verified or corrected (`expirySettlementAudit.ts:256-351`). Cycle stays open. |
| **Call expires out of the money** | Call leg `exit_price = 0`. Stock leg handed off at entry to a new `unstructured` position (`cc_expired_leftover_stock`); the covered-call position closes `expired_worthless` (`:776-802`). Cycle stays open. |
| **Call-away** | Call leg `exit_price = 0`; stock leg exits at the strike (from a real fill, or set by the audit `expirySettlementAudit.ts:152-188`); `close_reason = assigned`. Cycle closes if flat. |
| **Roll (one combo order)** | `roll_leg` buys back the old leg and sells the new one (`routes/positions.ts:1548-1706`). Old leg closes at its buyback fill; old position closes `closed_via_app`. The new contract becomes a **new position**. For a covered call the stock is handed off to the new position (`:934-975`). |
| **Buyback of a put** | Leg closes at the fill, commission on the closing trade, position `closed_via_app`. Buying back only the call of a covered call is not allowed (`src/pluto/closeActions.ts:25-28`). |
| **Whole covered-call close** | `close_position` combo: call bought back and shares sold (`routes/positions.ts:1774+`); both legs exit at fills. |
| **Stock sale** | Stock leg closes at the fill average. A partial sale carves the sold shares into their own closed leg with `parent_leg_id`, and moves the closing trades onto it (`src/lib/partialCloseSlice.ts:70-105`). |
| **Cycle closes** | When the symbol is flat: no shares held and no open option leg (`src/lib/cycles.ts:187-221`, `src/lib/cycleBreakEven.ts:161-178`). |

Timing detail that matters for a replay: both cycle modules group events within `groupingWindowMs = 120_000` (`cycles.ts:123`, `cycleBreakEven.ts:75`). A roll's close and open must fall in one group or the cycle splits in two.

---

## 2. Formulas Pluto's decisions depend on

### 2.1 Free shares
- Sum of open long stock legs on open `unstructured` positions of the ticker (`src/lib/positionQueries.ts:231-239`).
- Loaded into scoring at `src/lib/signalsStore.ts:280`; reaches the gates as `scored.freeShares` (`src/pluto/passRunner.ts:567`).
- Only round lots count: `floor(freeShares / 100)` (`src/pluto/candidateFilters.ts:247`).
- Shares under an open covered call are not free. In-flight orders are subtracted only when the order is built (`routes/positions.ts:1027`).

### 2.2 Free cash
- `freeCash = max(0, totalCashValue − cashLockedInCsps)` (`signalsStore.ts:39-41`).
- `cashLockedInCsps` = Σ over open `cash_secured_put` positions of `strike × multiplier × quantity` of the open leg, else the latest leg (`src/lib/positionExposure.ts:43-56`). Full strike, not net of premium.
- The order gate also subtracts in-flight notional (`src/lib/orderLimits.ts:215`).
- The backtest already mirrors this (`backtestBook.ts:145-151`).

### 2.3 Exposure: two different figures
**EXP $ at entry, `capitalAtRisk`** (`positionQueries.ts:144-160`), net of premium since 2026-10-12:
- Hedge: Σ `entry_price × multiplier × quantity` of its option legs.
- Open stock leg present: `stock entry_price × quantity` − Σ open short call `entry_price × multiplier × quantity` (`:43-47`).
- Otherwise: `(strike − premium) × multiplier × quantity` of the open option leg, else the latest (`:15-21`).
- Pluto's `committedDollars` is the sum of this over open positions on enabled tickers, hedges excluded (`src/pluto/book.ts:69-96`).

**Marked exposure** (`positionExposure.ts:125-150`):
- Per leg `price × quantity × multiplier × (short ? −1 : 1)`, falling back to `entry_price` when no price.
- A put on a `cash_secured_put` position adds `strike × multiplier × quantity`.
- Used for `existingTickerExposure` and `existingSectorExposure` (`passRunner.ts:548,565-566`) and the order gate's concentration limit.

### 2.4 capitalDeployed, the P&L % base
`positionQueries.ts:167-182`:
- Hedge: as above.
- Position ever held stock: Σ `entry_price × quantity` over **all** its stock legs, open or closed, less the premium of every slice of the chosen short call contract (`:51-64`).
- Otherwise: Σ `(strike − premium) × multiplier × quantity` over every slice of the chosen contract (`:26-40`).
- P&L % = total P&L ÷ `capitalDeployed` × 100 (frontend `/Users/marcelo/Sites/iorio-reloaded-app/src/lib/positionPnl.ts:138-147`; expiry message `ibkrGatewayReconcilePositions.ts:585-588`).

### 2.5 Order notional and the three limits
- `computeOrderNotional` (`orderLimits.ts:96-105`):
  - Put: `max(0, strike − premium) × 100 × quantity`.
  - Covered call: `max(0, quantity × 100 − freeShares) × max(0, spot − premium)`.
  - Put roll: `max(0, newStrike − oldStrike − (newPremium − buyback)) × 100 × quantity`.
  - Covered-call roll: 0.
- `evaluateOrderLimitFigures` (`:213-254`): max order size, ticker concentration after the order, cash reserve after the order.

### 2.6 Pluto sizing
`src/pluto/postModelGates.ts`:
- `computeSizingRoom` (`:126-135`): budget, order cap, ticker, sector and cash room.
- Put: `unitNotional = (strike − limit) × 100`; contracts = min(room, volume share, stress cap, Kelly cap) (`:266-273`).
- Call on held shares: `min(floor(freeShares / 100), volume cap)`, zero notional, no Kelly cap, then the break-even gate (`:274-292`).
- Covered Call entry: free-share contracts first, then `(spot − limit) × 100` per extra contract (`:293-314`).
- Roll: keeps the held quantity; a put roll's notional is `max(0, dollarRiskChange)` (`:260-265`).
- Stress cap `:178-195`; Kelly cap `:214-227`; limit price is the mid clamped inside the market (`:113-115`).

### 2.7 Cycle break-even (the Positions column and Pluto's input)
`summarizeOpenCycle` (`cycleBreakEven.ts:91-211`):
- `acquisitionCost` = Σ stock buys `quantity × price + commission`, plus assigned puts at `shares × strike` (`:102`, `:147-151`).
- `netPremium` = Σ over the cycle's option legs of `sign × entry × shares − sign × exit × shares − closingCommission`; an open short counts at its credit (`:186-193`).
- `breakEvenPerShare = (acquisitionCost − netPremium) ÷ sharesAcquired` when shares are held (`:206`). Pro-rata over every share ever acquired in the cycle.
- Put-only cycle: `own strike − netPremium ÷ total open put shares` (`:214-221`).
- Refuses, returning null with a reason, when: no expiry-date bar; a leg expired within $0.05 of the strike; ledger shares differ from open stock legs (`:135-141`, `:200-202`).
- The live loader passes **short legs only** (`src/lib/cycleBreakEvenQueries.ts:48`).

### 2.8 The held-shares call rule and its floor (2026-10-12)
`src/pluto/heldShareCalls.ts`:
- `breakEvenAfter = breakEven − cashPerShareCovered × 100 × contracts ÷ sharesAcquired` (`:46`).
- `profitIfCalledAway = (strike − breakEvenAfter) × 100 × contracts` (`:47`).
- `floor = max(unstructuredCloseMinPct% × (acquisitionCost ÷ sharesAcquired) × 100 × contracts, unstructuredCloseMinDollars)` (`:29-32`).
- Passes when `profitIfCalledAway ≥ floor`. No cycle or no break-even blocks the call (`:43-44`).
- `cashPerShareCovered`: an open uses mid − commission per contract ÷ 100 (`candidateFilters.ts:254`); the post-model gate re-checks at the limit price (`postModelGates.ts:283`); a roll uses net credit − 2 × commission per share (`candidateFilters.ts:306`).
- On held shares the grade, Edge Yield and premium-yield minimums are replaced by Edge $ > 0 (`candidateFilters.ts:178-180`). Only the best passing call by Edge Yield is offered (`:267-273`).
- A covered-call roll is checked only when it lowers the strike (`:302-311`).
- The cycle is fetched only when `freeShares ≥ 100` or a covered-call roll exists (`passRunner.ts:173-175`).

### 2.9 Realized and unrealized P&L
- **Leg realized**: `(exit − entry) × quantity × multiplier × (short ? −1 : 1) − Σ closing-trade commission` (`legRealizedPnlSql.ts:14-19`).
- **Position realized**: sum over legs with `exit_price IS NOT NULL`, split into premium and stock (`positionQueries.ts:103-132`).
- **Unrealized**: `(price − entry) × quantity × multiplier × sign` per open leg; null if any leg lacks a price (`src/lib/positionOrderRules.ts:76-112`).
- **Position total**: realized + unrealized when open, realized when closed (frontend `positionPnl.ts:85-95`).
- **Pluto action realized P&L**: legs the action's order opened, including carved slices, else legs it only closed (`src/pluto/actionRealizedPnl.ts:19-74`).

### 2.10 Cycle P&L
`deriveOneCycle` (`cycles.ts:234-467`):
- Four buckets: `csp`, `unstructured`, `cc`, `hedge` (`:26`). Shares live in two pools with a reference price each.
- Stock buy enters the unstructured pool at `(quantity × price + commission) ÷ quantity`; a sell leaves at price net of commission (`:247`).
- Assigned put: the CSP bucket is charged `shares × (expiry close − strike)`, and the shares enter the unstructured pool at the expiry close (`:327-330`).
- Disposals take covered shares first (`:300-320`).
- Rebalance when the open-call share count changes: newly bought shares move at cost, others at that day's close (`:363-377`).
- Capital: put `strike × shares`; pools by value at entry (`:352`, `:385-388`).
- Open marks: shares at `lastPrice`; open options at `snapshotPremiumPnl − credit`; a short with no mark stays at credit (`:392-426`).
- Its own break-even at `:438-453`, excluding hedge rows and open-option mark rows.
- Data flags at `:255-258`, `:319`, `:395`, `:407`, `:430-431`.

**Live cycle P&L for closes** (`src/lib/closeLiveState.ts:83-131`): re-derives the cycle with shares at the live stock last, and the position's option P&L at `(mid − entry) × quantity × multiplier × sign` (`:111-121`). Blocks when the market is closed, a quote is not two-sided, no open cycle is found, or the cycle carries flags.

### 2.11 Close rules that read the book
`src/pluto/closeActions.ts`:
- **P1, sell unstructured shares** (`:161-191`): needs `cycleTotal ≥ max(entry_price × shares × pct, dollars)`, a position older than one full session (`:165`), and a two-sided stock quote. Odd lots under 100 shares close automatically.
- **P2, buy back a put** (`:205-241`): single-leg position, hold value − close cost < 0, no roll with an edge margin of 10% or more, DTE ≥ `buybackMinDte`, and `(entryPremium − ask) × quantity × 100 > 0`.
- **P3, earnings buyback** (`:297-330`) and **P3b, whole covered call before earnings** (`:354-392`): `cycleTotal − (callAsk − callMid) × 100 × contracts − (stockMid − stockBid) × shares > 0`.
- **F3, before a macro event** (`:437-469`, `:493-528`).
- Note the two floors differ: P1's base is the stock leg's `entry_price`; the held-shares rule uses the cycle's average acquisition cost.
- Held-position figures shown to the model: `src/pluto/heldPositionMetrics.ts:102-133`, `:150-189`.

### 2.12 Recovery Path
- Candidate ranking: `annualizedYield = premium ÷ (spot − premium) × (365 ÷ dte)`; premium is the mid, else last. Calls above spot within 40%, two nearest expiries in the DTE window, delta inside the band, no earnings or ex-dividend on or before expiry (`src/ibkr/scanRecoveryPathCoveredCallCandidates.ts:36-38,136-173`).
- Recovery measure (`src/ibkr/evaluateRecoveryPathForPosition.ts:28-34`):
  - `unrealizedLoss = max(0, costBasis − price) × shares`
  - `monthlyPremium = premium × 100 × floor(shares / 100) × (30 ÷ dte)`
  - `monthsToRecover = ceil(unrealizedLoss ÷ monthlyPremium)`
- Cost basis is the cycle break-even, else the average entry price (`:39-41`).
- Applies to open `unstructured` positions only. Screen-only; no Pluto path calls it.

---

## 3. Pure versus SQL-bound, and the minimal refactors

### 3.1 Pure today, callable with a simulated book
| Function | File |
|---|---|
| `deriveCycles`, `deriveOneCycle` | `src/lib/cycles.ts:184,234` |
| `summarizeOpenCycle`, `breakEvenForPosition` | `src/lib/cycleBreakEven.ts:91,214` |
| `computeOpenCycleMarks` | `src/lib/cycleLiveMarks.ts:22` |
| `truncateCycleInputAsOf`, `openMarkTotal` | `src/lib/cyclePeriodPnl.ts:77,118` |
| `checkCalledAway`, `heldSharesProfitFloor` | `src/pluto/heldShareCalls.ts` |
| `filterTickerForPluto`, `coveredCallRollBreakEvenFailure` | `src/pluto/candidateFilters.ts:236,302` |
| `runPostModelGates`, `computeSizingRoom`, `computeStressCap`, `computeKellyCap` | `src/pluto/postModelGates.ts` |
| `computeOrderNotional`, `computeInFlightOrderNotional`, `evaluateOrderLimitFigures` | `src/lib/orderLimits.ts:96,113,213` |
| `computeExposureRows` | `src/lib/positionExposure.ts:125` |
| `computeUnrealizedPnlByPosition` | `src/lib/positionOrderRules.ts:76` |
| `deriveCloseLiveState`, `closeGateVerdictFromState` | `src/lib/closeLiveState.ts:83`, `src/lib/closeGate.ts:116` |
| P1/P2/P3/P3b/F3 evaluators, `orderedEntryPremium`, `countSessionsLeftBeforeEarnings` | `src/pluto/closeActions.ts` |
| `heldPutEntry`, `heldCoveredCallEntry` | `src/pluto/heldPositionMetrics.ts` |
| `scoreTicker`, `scoreHeldLegs`, `buildRollCandidates` | `src/lib/signalsLiveScoring.ts:204`, `src/lib/rollSignalCandidates.ts:180,336` |
| `buildFifoLedger`, `verifyLedgerAgainstIbkr`, `soldSharesEntryPrice` | `src/lib/stockCostBasisLedger.ts` |
| `weightedAverageFillPrice`, `chooseFillsForPartialClose` | `src/lib/partialCloseSlice.ts:21,33` |
| `isOptionPastExpiry(expiry, now)`, `classifyOptionLegRetirement(legs, now)` | `src/lib/optionExpiryClock.ts:12`, `src/lib/optionLegRetirement.ts:18` |
| `computeRecoveryProjection`, `chooseRecoveryCostBasis` | `src/ibkr/evaluateRecoveryPathForPosition.ts:28,39` |

### 3.2 SQL-bound or DB-writing
| Logic | Where | Why it cannot be called |
|---|---|---|
| `realizedPnl`, `capitalAtRisk`, `capitalDeployed` | `positionQueries.ts:66-185`, `legRealizedPnlSql.ts` | SQL only |
| Free shares | `positionQueries.ts:231` | knex query |
| Cash locked in puts | `positionExposure.ts:43` | raw SQL |
| Cycle inputs and open-cycle summary loaders | `cycleQueries.ts:30-97`, `cycleBreakEvenQueries.ts:32-80` | SQL loaders around pure cores |
| Pluto book, occupied contracts, in-flight notional | `src/pluto/book.ts:69,107,139` | SQL |
| Open short legs | `signalsStore.ts:252-268` | SQL |
| Close offers per ticker | `closeActions.ts:570-669` | mixes six DB reads and the live close gate with the pure evaluators |
| Close gate loaders | `closeGate.ts:48-103,126-202` | DB, quote pool, market session |
| Reconciler | `ibkrGatewayReconcilePositions.ts` | global `db`, module-level state (`:33-46`), `now()` stamps (`:214,293,462,734,1115`), wall-clock windows (`:31,115,175,254`) |
| Expiry audit | `expirySettlementAudit.ts` | takes a Knex, but `now()` in its selector (`:132`) |
| Execution recorder | `ibkrGatewayOrderTracking.ts:339-396` | DB |
| Recovery ranking | `scanRecoveryPathCoveredCallCandidates.ts:136` | not exported; `new Date()` at `:45,143` |

### 3.3 Minimal refactors, in priority order
1. **Pure position selectors beside the SQL**: `legRealizedPnl`, `positionRealizedPnl`, `positionCapitalAtRisk`, `positionCapitalDeployed`, `availableUncoveredShares`, `cashLockedInCsps`. Each mirrors its CASE branch; a db test seeds the same rows and asserts the SQL and the pure version agree.
2. **Extract the row-to-input mapping** from `cycleQueries.ts:75-94` and `cycleBreakEvenQueries.ts:68-78` into exported builders, so the simulated ledger feeds `CycleInput` and `summarizeOpenCycle` through the same code.
3. **An explicit settlement outcome on the cycle leg types**: an optional `settledAs?: "assigned" | "worthless"` on both `CycleOptionLeg` types, used instead of the bar inference when present. Live leaves it unset. Without it, an early assignment or a finish within $0.05 flags the cycle and freezes Pluto on it (`cycles.ts:254-262`, `cycleBreakEven.ts:135-141`).
4. **Split `buildCloseOffersForTicker`** into a loader and a pure builder that takes share positions, open legs by position, opening trades, earnings, sessions left, and a gate callback. The backtest's callback would call `deriveCloseLiveState` with `marketState: "open"` and `waitedMs = settleGraceMs`.
5. **Feed the wheel state into the backtest decision**: `freeShares`, `openShortLegs`, `cycleBreakEven`, earnings for closes. Append held-leg quotes that fall outside the capture window; live does this with `appendMissingContractQuotes` (`signalsLiveScoring.ts:285-287`), but the backtest filters quotes to the capture window first (`backtestDayDecision.ts:196,216`), so a deep in-the-money held leg would be unscored.
6. **Only if Recovery Path is wanted in reports**: export `rankCoveredCallCandidates` with a `today` parameter.

No refactor of the reconciler is recommended (see 5.3).

---

## 4. Edge cases

| Case | What live does | Consequence for the simulation |
|---|---|---|
| **Out-of-the-money expiry** | Option `exit_price = 0`; covered-call shares handed to a new unstructured position (`ibkrGatewayReconcilePositions.ts:461,776-802`) | Copy exactly, including the new stock leg's `entry_at` at the handoff, because P1 waits a full session from it |
| **In the money by ≥ $0.05 at the expiry close** | Treated as assigned by both cycle modules and by the audit (`expirySettlementAudit.ts:385-392`) | Natural assignment rule |
| **Pin: in the money by less than $0.05** | Audit emits `marginal_call` for manual review (`:387-389`); cycle flagged "assignment unclear"; break-even null; close gate blocks | Simulation needs a deterministic rule plus refactor 3, or the cycle stays frozen |
| **Close exactly at the strike** | Counts as worthless (`distanceInTheMoney <= 0`, `:386`; `src/lib/expiredOptionWorthlessPrice.ts:31-32`) | Copy |
| **Expiry date with no daily bar (holiday, missing data)** | The join is on the exact date (`cycleQueries.ts:44`), so `expiryClose` is null: "no expiry-date price bar" flag, audit skips and retries (`expirySettlementAudit.ts:380-384`). Handoff valuation does fall back to the previous close (`cycles.ts:226-232,280-283`) | Backtest already has a closing-quotes fallback (`runBacktestSession.ts:174-182`); the same settlement close must be supplied as `expiryClose` |
| **Expiry clock** | Fixed at 16:00 Eastern on the expiry date (`src/lib/optionExpiryClock.ts:5-16`); early-close days are not special-cased | Stamp settlements at 16:00 Eastern |
| **Early assignment** | No dedicated path. The option vanishes before expiry with no trade, so `exit_price` is null and its premium drops out of realized P&L until the audit sets it to 0 after the expiry date (`:411-412,461`; `expirySettlementAudit.ts:370-379`). The cycle is flagged until an expiry-date bar exists | Daily quotes cannot observe early exercise. Recommend not modelling it in version 1 and saying so |
| **Partial assignment** | Not handled. An open leg's quantity is overwritten to IBKR's holding (`:700-702`); slices are carved only when closing fills explain the drop (`partialCloseSlice.ts:76-80`), so the assigned contracts' premium disappears. At expiry the ledger infers assignment of every contract and mismatches the stock legs | Simulate all-or-nothing per leg |
| **Call-away mixed with other shares** | Audit corrects only when the uncorrected stock legs equal the called shares exactly, else manual review (`expirySettlementAudit.ts:171-174`) | Cannot arise if one stock leg belongs to each covered call |
| **Double counting of assignment fills** | `cycles.ts` drops only stock **buys** matching an inferred put assignment (`:163-182`); `cycleBreakEven.ts` matches both sides but only when `close_reason = assigned` and within 120 s (`:116-126,144-145`) | A simulated stock **sell** trade on call-away would be counted twice by `deriveCycles`. Do not write one; set the stock leg's `exit_price` to the strike |
| **Assigned-put premium counted twice** | IBKR cost is strike − premium; corrected to the strike by the FIFO check or the audit (`stockCostBasisLedger.ts:4-15`, `expirySettlementAudit.ts:27-36`) | Enter assigned shares at the strike directly |
| **Roll** | Old leg closed by fill, new contract is a new position, stock handed off; a 10-minute grace stops a mid-roll covered call being treated as bare stock (`:26-31,250-257`) | Apply atomically at one instant; no grace needed |
| **Partial close** | Carved slice with `parent_leg_id`; `capitalDeployed` counts slices (`positionQueries.ts:23-40`) | Mirror only if partial fills are simulated |
| **Commissions** | Option open: inside `entry_price`. Option close: `trades.commission`. Expiry and assignment: none. Stock buy: inside `entry_price` and added to cycle cost; stock sell: subtracted. Estimates: $0.68 per contract (`src/lib/optionFriction.ts:21`), $0.005 per share (`src/lib/commissionEstimate.ts:125`) | Use the same placement so every formula above works unchanged |
| **Ex-dividend** | The Recovery scan and `findCalendarConflict` exclude covered calls open across an ex-dividend date (`src/ibkr/calendarConflict.ts:52-64`). Dividends enter the surface forward. No dividend cash in cycles or break-even | I did not confirm whether Signals itself excludes ex-dividend expiries; backtest formula sheet says no dividends in version 1 (`docs/backtesting/FORMULAS.md:63`) |
| **Splits** | Stored daily bars are re-fetched split-adjusted (`src/ibkr/dailyBarSplitCheck.ts:3-10`). Legs keep as-traded strikes and entries; the cycle engine compares strikes with the adjusted closes; no rescaling exists. `multiplier` is stored per leg but Pluto's formulas hard-code 100 | Live has no split handling for a held cycle. The backtest keeps each position on its opening scale (`backtestBook.ts:16-17,124-126`); extend that to the whole cycle |
| **Hedges** | Separate `hedge` positions, outside Pluto's book and break-even (`book.ts:55`, `cycleBreakEvenQueries.ts:20`) | Not needed |
| **Combo fill split** | IBKR splits a combo's net price between legs arbitrarily; Pluto corrects the entry premium with `orderedEntryPremium` (`closeActions.ts:93-98`) | Not needed: simulated legs fill at their own prices |

---

## 5. Recommended design

### 5.1 Recommendation
An in-memory ledger whose rows have the same shape as the live tables, a deterministic event applier, and the pure functions of section 3 on top. Parity tests against the real SQL keep the two from drifting.

### 5.2 Components

**Ledger state**, per session:
- `positions`: id, strategyKey, status, openedAt, closedAt, closeReason, unstructuredReason.
- `legs`: the `PositionLegRow` fields (`positionQueries.ts:187-201`) plus positionId, parentLegId, and an explicit `settledAs`.
- `trades`: legId, side, quantity, price, commission, executedAt, isClosingTrade, actionId.
- `shareSources`.
- `cash`, plus a cash journal (premium, commission, share purchase, assignment, call-away, buyback, sale, interest).
- `splitFactorAtCycleStart` per open cycle.

**Event applier**, one function per event, producing exactly the end states of table 1.5:
- `openCashSecuredPut`, `openCoveredCall` (Covered Call entry, held shares, or mixed), `rollLeg`, `buyBackPut`, `closeCoveredCall`, `sellShares`.
- `settleExpiry` with four outcomes: put worthless, put assigned, call worthless, call-away.
- Timestamps: fills at the decision instant (10:00 Eastern); settlements at 16:00 Eastern on the expiry date. Everything belonging to one event shares one timestamp, so the 120-second grouping holds.
- Put assignment: put leg exit 0, `close_reason = assigned`, new unstructured position with a stock leg at the strike, cash − strike × shares, share source linked.
- Call-away: call leg exit 0, stock leg `exit_price = strike`, no stock sell trade, cash + strike × shares.

**Selectors** (pure, from refactors 1 and 2): free shares, cash locked, free cash, `capitalAtRisk`, `capitalDeployed`, realized and unrealized P&L, exposure rows, `CycleInput`, open-cycle summary, occupied contracts, open short legs.

**Decision loop** (extends `runBacktestSession.ts:247-402`):
1. Settle expiries through the applier.
2. Credit interest.
3. Mark the account.
4. Build the book view from selectors, including `freeShares`, `openShortLegs`, `cycleBreakEven`.
5. Run close offers (P1, P2, P3, P3b; F3 only if macro events are replayed), then opens and rolls through the existing filter and gate chain.
6. Apply the resulting events.

**Persistence**: the current `backtest_trades` row is one put or call held to expiry. A wheel needs positions, legs and stock trades. That is a schema change to raise with Marcelo.

### 5.3 Why not a scratch Postgres schema running the real reconciler
| | In-memory ledger (recommended) | Scratch schema with the live reconciler |
|---|---|---|
| Reuse of cycle, break-even and Pluto gates | Full, already pure | Full, through SQL loaders |
| Reuse of `positionSelect` SQL | Via parity-tested selectors | Direct |
| Reuse of the reconciler | None; its end states are re-stated | Direct, in principle |
| Historical timestamps | Exact | Broken: `now()` everywhere, and module state is global |
| Refactor needed | Six small extractions | Clock and connection injection through about 1,100 lines of the most delicate live code |
| Speed | Microseconds per day | Hundreds of queries per pass, thousands of days |
| Isolation | Trivial | Test runs are already serialised because the pass sweeps every open leg (`vitest.config.ts`) |
| Risk to live trading | None | Real: the worker's reconciler would be changed |
| Faithfulness to live quirks | Models the correct end state, not IBKR report gaps | Bug-for-bug, but those quirks exist only because IBKR's reports lag |

Most of the reconciler's complexity handles IBKR reporting gaps and timing, which a simulation does not have. Its accounting outcomes are few, and table 1.5 lists them all.

A middle path worth keeping as a test only: export a finished session's ledger into the test database and run `positionSelect`, `fetchOpenCycleSummaryByTickerId` and `fetchCyclesForTickers` over it. This is the parity test, run in CI rather than in the simulation loop.

### 5.4 Sequencing
1. Refactors 1 and 2 with parity tests (no behaviour change).
2. Ledger and applier with unit tests, one scenario per row of table 1.5; assert `deriveCycles` returns no data flags and bucket totals sum to the cash journal.
3. Refactor 3 (explicit settlement).
4. Wire free shares, held legs and the cycle into the decision; enable calls on held shares.
5. Refactor 4 and the close rules.
6. Rolls.
7. Persistence and screen.

Likely difficulties:
- No historical stock bid/ask: the 10:00 price is derived from option parity (`backtestBook.ts:56-79`), but P1, P3b and the close gate need a two-sided stock quote with a last (`closeLiveState.ts:71-75`).
- Held legs outside the capture window have no surface slice, so they are unscored and P2 and rolls skip them (`rollSignalCandidates.ts:188`). Live has the same limit.
- One look per day means the ticker cooldown and "older than one full session" behave more coarsely than live.

---

## 6. Decisions that need sign-off before implementation

1. **Assignment rule at expiry**: in the money by ≥ $0.05 as live infers, or any amount in the money; and what a finish inside $0.05 does.
2. **Buyback fill price**: suggested mirror of the sale rule, mid + spread cost share × half-spread, plus the buy commission.
3. **Stock fills and quotes**: Covered Call entry and share-sale price, the stock commission ($0.005 per share flat), and what stands in for stock bid/ask.
4. **Early assignment**: propose not modelled in version 1.
5. **Splits while a cycle holds shares**: propose keeping the whole cycle on its starting scale.
6. **Dividends**: currently excluded; held shares make this matter more than before.
7. **Macro-event closes (F3) and intraday market stress**: not replayable today.
8. **Persistence schema** for simulated positions, legs and stock trades.

### Critical Files for Implementation
- /Users/marcelo/Sites/iorio-reloaded-api/src/backtest/engine/backtestBook.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/backtest/engine/backtestDayDecision.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/lib/cycleBreakEven.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/lib/positionQueries.ts
- /Users/marcelo/Sites/iorio-reloaded-api/src/pluto/closeActions.ts

Also central as reference, not to be modified: `/Users/marcelo/Sites/iorio-reloaded-api/src/lib/cycles.ts`, `/Users/marcelo/Sites/iorio-reloaded-api/src/ibkr/ibkrGatewayReconcilePositions.ts`, `/Users/marcelo/Sites/iorio-reloaded-api/src/lib/expirySettlementAudit.ts`, `/Users/marcelo/Sites/iorio-reloaded-api/src/pluto/heldShareCalls.ts`, `/Users/marcelo/Sites/iorio-reloaded-api/src/backtest/engine/runBacktestSession.ts`.
