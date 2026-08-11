# Iorio Reloaded — Progress Tracker

Last updated: 2026-08-11

## Vision
Multi-strategy options trading system. Business user checks in daily, reviews suggested opportunities and open positions, approves/rejects/modifies trades. Trades execute (semi-automated) via IBKR once confirmed. Node.js + React + Postgres, hosted on Heroku.

## Status: Pre-architecture — no code written yet

## Open decisions (blocking further design)
- [ ] Local dev environment: mostly done (see below), but backend/frontend `npm install` + run steps still need adding to SETUP.md once there's actual code to install.
- [ ] Cloudflare + DNS setup for ioriore.com not yet done (add site to Cloudflare, point nameservers, add Heroku custom domains, configure Bot Fight Mode + firewall rules).
- [ ] Telegram notification channel setup (for scheduled job failures + health checks).
- [ ] Screener candidate universe (tickers not yet shortlisted) needs a data source — live IBKR query over a defined universe (e.g. S&P 500) vs. a lightweight "latest values only, no history" cache refreshed daily. Decide when building Screener logic.
- [ ] Whether IBKR's `reqFundamentalData` requires its own paid subscription add-on — not confirmed via research, need to test directly once we have API access.
- [ ] IBKR historical backfill coverage (OHLCV bars, and especially `OPTION_IMPLIED_VOLATILITY` history) needs empirical per-symbol testing once the IBKR interface is working — not guaranteed to have full coverage for every ticker (community reports of "no historical data" errors for some symbols on the IV endpoint specifically).
- [ ] Exact numeric values for strategy risk/sizing settings (delta targets, DTE targets, position sizing %, concentration limits) — candidate fields identified (see strategy_settings table), but actual thresholds are the user's call and count as "formulas" requiring explicit sign-off before implementation.

## Decisions made
- Stack: Node.js backend, React frontend, PostgreSQL via Heroku Postgres Essential-1, Heroku hosting.
- **UI template: Tabler**, consistent with the existing menaris-admin-app (React + Bootstrap 5 + Tabler + ApexCharts) and the Tabler-specific UI/UX rules already in global CLAUDE.md. Consume via `@tabler/core` + `@tabler/icons-react` (official, actively maintained) — NOT the `tabler-react` community wrapper package (abandoned, no releases in 12+ months).
- **Charting: confirmed.** ApexCharts for general/aggregate charts (P&L over time, dashboard stats) + TradingView's lightweight-charts for OHLC/candlestick underlying price charts. Both free for this use case (ApexCharts Community License, org revenue < $2M/yr; lightweight-charts requires visible TradingView attribution on pages using it). Payoff diagrams (covered call/CSP risk-reward "hockey stick") will be custom-built as a computed line/area series in ApexCharts, not a built-in feature. Will build one shared reusable wrapper component per library (no official React bindings for lightweight-charts).
- Two users initially, same access level, no per-role permissions needed.
- **Local dev environment set up on Marcelo's Mac** (2026-08-11): nvm installed with Node 24 pinned per-project via `.nvmrc` (auto-switches on `cd`, doesn't touch the existing system Node 26 used by other projects like menaris-admin-api). Postgres.app installed running PostgreSQL 17 (matches Heroku Postgres's default), with `iorio_reloaded_development` and `iorio_reloaded_test` databases created. `.env` / `.env.example` added to iorio-reloaded-api. Heroku CLI already present. Full steps documented in `SETUP.md` in iorio-reloaded-api — written so the user's developer friend (who also uses Claude Code) can hand his Claude Code the file and replicate the setup.
- Personalization (e.g. table column visibility) stored client-side in localStorage only.
- Strategies implemented in code, not via UI; schema/platform must support multiple strategies running in parallel.
- **v1 strategy scope: covered calls + cash-secured puts**, both from day one.
- **Historical options data / deep backtesting: shelved for now.** 10 years of full-detail options data doesn't fit a 10GB Postgres budget, and most vendors' ToS block the "subscribe a month, bulk-export, cancel" approach. Revisit as a Phase 2+ idea once core platform is proven.
- **All market data (screening + pricing) sourced directly from IBKR — no separate third-party market-data vendor.** Real-time US stocks + OPRA options data requires IBKR's "US Securities Snapshot and Futures Value Bundle" (~$10/month, waived if ~$30/month in commissions generated — likely not waived given low trading frequency, so budget for ~$10/month).
- **Realized/unrealized P&L must be sourced live from IBKR directly** (source of truth), not computed from our own stored records + third-party marks.
- **IBKR connectivity architecture: dedicated VPS, not Heroku, not the user's Mac.**
  - Reasoning: Heroku dynos (all tiers, including Basic) are forcibly restarted roughly every 24h with an ephemeral filesystem wiped on each restart — this is a platform-level behavior, not an Eco-tier limitation. IB Gateway needs a stable, persistent process to avoid repeated 2FA challenges. Verified via web research: no examples found of anyone running Gateway/TWS directly on Heroku; the one real-world Heroku+IBKR project found (ozdemirozcelik/pairs-api-v3) explicitly separates the IBKR connection into a non-Heroku component.
  - Mac-hosted option was ruled out once live P&L (not just execution) needed IBKR connectivity — that requires near-continuous uptime during market hours, which a laptop can't reliably guarantee, unlike a VPS.
  - **Docker image: `gnzsnz/ib-gateway-docker`** (github.com/gnzsnz/ib-gateway-docker) — most established/maintained option (1.1k stars, 233 forks). Has `AUTO_RESTART_TIME` config that restarts Gateway daily without requiring 2FA re-validation.
  - **Node.js client library: `@stoqey/ib`** (npmjs.com/package/@stoqey/ib) — actively maintained TypeScript port of IBKR's official Java client, used by the Node backend to talk to Gateway over its socket API.
  - **VPS provider: Hetzner**, ~€8/month for 2 vCPU/4GB RAM (2GB minimum recommended; Gateway's default Java heap is ~768MB). EU-based; latency to IBKR's US servers is irrelevant for a low-frequency options strategy.
  - Division of labor: user creates the Hetzner account/billing (Claude cannot create billing accounts); Claude configures everything on the box once given SSH access.
- **Domain: ioriore.com** (already owned by user). Likely subdomain split: `app.ioriore.com` (frontend), `api.ioriore.com` (backend) — to confirm when we do the Cloudflare/DNS setup.
- **Heroku topology: two separate Heroku apps** (matches the existing `iorio-reloaded-api` / `iorio-reloaded-app` repo split), both on Eco dynos.
  - Eco hours are pooled per account: 1,000 hrs/month for $5/mo flat. One always-on dyno alone uses ~720 hrs/month; sleeping dynos consume ~0. Given daily-check-in usage, both apps sleeping between visits should fit comfortably in the pool.
  - **Both apps proxied through Cloudflare's free plan** (Bot Fight Mode + custom firewall rules) to stop scanner/bot traffic from waking sleeping dynos and burning hours. Requires a custom domain (Cloudflare can't proxy Heroku's default `*.herokuapp.com`).
  - Note: this protects against *bot-driven* wake-ups, not the user's own daily cold start — opening the app after a dyno's been asleep will still take several seconds to ~30s to respond. Not solved yet; revisit if it proves annoying in practice.
- **Database schema (conceptual, finalized) — see below.** Design principle: positions are legs-based (a covered call = 2 legs, CSP = 1 leg) so future multi-leg strategies don't need a schema rewrite. All IBKR-facing field names were checked against actual TWS API docs, not assumed from general domain knowledge — this caught several real gaps (see corrections noted per table).
- **Strategy breakdown visualization**: a colored strategy badge (e.g. "CC"/"CSP") on every row in mixed lists (Positions, Blotter, Opportunities) + a strategy filter dropdown (All / Covered Calls / Cash-Secured Puts) at the top of those screens. Dashboard P&L shows a grand total row, then per-strategy subtotal rows underneath.
- **Backtesting: lightweight forward simulation only, no purchased historical data.** Once `daily_price_bars`/`market_data_snapshots` accumulate going forward, build a "what if I'd entered this trade N days ago" tool using only self-accumulated data. Starts limited, grows over time. Full historical backtesting with purchased data remains shelved (see below).
- **Ticker detail modal**: fundamental data (company overview/financials/ownership/analyst estimates) via IBKR's `reqFundamentalData` API (XML; report types ReportSnapshot, ReportsFinSummary, ReportsOwnership, ReportsFinStatements, RESC) — subscription cost not yet confirmed, needs testing. Price chart uses **our own lightweight-charts component** (not a TradingView embedded widget) — reasoning: TradingView's free widget renders TradingView's own data (could mismatch IBKR-sourced P&L figures) and doesn't support overlaying our own position/strike/entry markers, which the modal needs.
- **Manual trade entry**: already supported by the schema as-is — a `position` doesn't require a linked `trade_suggestion` (that link is optional). Just needs a "+ New Position" UI entry point with a manual form; no schema change required.
- **Authentication: password-based, Argon2id hashing, no Passport.js.** `argon2` npm package (OWASP's 2026 top recommendation over bcrypt; salt is handled internally by the library, not managed manually). Passport rejected as unnecessary indirection — we have exactly one auth strategy (local password) for 2 known users, no OAuth/social login planned, so plain Express login/logout routes are simpler and more transparent. Sessions via `express-session` backed by **Postgres** (`connect-pg-simple`), not Redis — avoids adding infra for 2 users' worth of session data.
  - **No self-service password reset/recovery.** User creation and password changes handled via a CLI script in `scripts/` (per global CLAUDE.md convention — reusable admin script, gets an `npm run` entry), run manually and rarely. No transactional email infra needed.
- **IV Rank display: option (b) — show a rank based on whatever history we actually have, clearly labeled with the window size** (e.g. "IV Rank (45d)"), growing toward the standard trailing-252-trading-day window over time, rather than hiding it entirely until a full year accumulates.
- **IBKR historical backfill strategy confirmed**: try an IBKR historical backfill first for anything IBKR might provide (`reqHistoricalData` — OHLCV bars have no meaningful lookback limit for daily bars; `whatToShow=OPTION_IMPLIED_VOLATILITY` against the underlying likely provides historical IV too, though per-symbol coverage needs empirical verification), falling back to daily accumulation going forward only for whatever turns out to have no reliable historical endpoint. Distinct from, and does not reopen, the shelved decision about purchasing full historical options *chain* data from a third-party vendor — this is about backfilling one underlying's own price/IV history from IBKR at no extra cost, not buying strike-by-strike chain snapshots across years. **To be tested once the IBKR interface is working**, not before.

## Database schema (conceptual — not yet migrated)

- **users** — `id, email, display_name, password_hash, created_at`. `password_hash` via Argon2id (`argon2` package). No password-reset table/flow — created and changed via a CLI script in `scripts/`. Sessions stored separately via `connect-pg-simple`'s own auto-created table, not on this table.
- **tickers** — `id, symbol, company_name, sector, created_at`.
- **shortlist_entries** — `id, ticker_id, strategy_key, added_by_user_id, added_at, removed_at, notes`. `removed_at` is a soft-delete to preserve history of what was shortlisted when.
- **positions** — `id, strategy_key, ticker_id, status (open/closed), ibkr_account_id, opened_at, closed_at, notes`. Strategy-agnostic shell.
- **position_legs** — `id, position_id, leg_type (stock/option), side (long/short), quantity, option_type (call/put, nullable), strike_price (nullable), expiry_date (nullable), multiplier, ibkr_contract_id, entry_price, entry_at, exit_price, exit_at`.
  - `multiplier` added after checking IBKR's Contract fields — not always 100 (adjusted contracts after splits/special dividends can differ); omitting it would silently corrupt P&L math.
  - `ibkr_contract_id` maps to IBKR's `conId`. `expiry_date`/`option_type` are parsed at ingestion from IBKR's raw `lastTradeDateOrContractMonth` (string, YYYYMM/YYYYMMDD) and `right` ('P'/'PUT'/'C'/'CALL') fields — not clean to store as-is.
- **trades** — `id, position_leg_id, ibkr_order_id, ibkr_exec_id (unique), side, quantity, price, commission, realized_pnl, executed_at, raw_ibkr_payload (jsonb)`. The execution blotter.
  - `realized_pnl` added after checking IBKR's API — `CommissionReport.realizedPNL` gives per-execution realized P&L directly from IBKR; we should use that rather than computing it ourselves from entry/exit deltas.
  - Caveat found (community-reported, unverified by us yet): account-level `reqPnLSingle.realizedPnL` has been reported to return implausible values in some cases. Treat `CommissionReport.realizedPNL` (per-trade) as the more trustworthy source; verify against real paper-account data before trusting account-level P&L numbers.
- **trade_suggestions** — `id, strategy_key, ticker_id, suggested_structure (jsonb), rationale, status (pending/approved/rejected/modified/expired), reviewed_by_user_id, reviewed_at, resulting_position_id`.
- **account_pnl_snapshots** — `id, snapshot_date, daily_pnl, realized_pnl, unrealized_pnl, net_liquidation_value, captured_at`. One row/day, account-level, feeds daily/weekly/monthly/yearly dashboard views.
  - `daily_pnl` added — IBKR's `reqPnL` provides this as its own native concept (change since start of trading day), separate from cumulative realized/unrealized.
  - `net_liquidation_value` comes from a different IBKR call (account summary) than the P&L fields (`reqPnL`) — stored together in one row, but the daily job needs to call both endpoints.
- **position_pnl_snapshots** — `id, position_id, snapshot_date, realized_pnl, unrealized_pnl, market_value, captured_at`. One row/day per open position.
- **daily_price_bars** — `id, ticker_id, trading_date, open_price, high_price, low_price, close_price, volume, captured_at`. OHLCV data feeding the lightweight-charts candlestick charts. Scoped to **any ticker ever held in a position**, not just the current shortlist — so historical charts keep working for closed positions after a ticker drops off the shortlist. Field names verified against IBKR's `reqHistoricalData` Bar object (`date, open, high, low, close, volume, WAP, barCount, hasGaps`).
- **market_data_snapshots** — `id, ticker_id, snapshot_date, implied_volatility, avg_option_volume, captured_at`. Screening-specific data, scoped to the **current shortlist only**.
  - Correction: IV Rank is **not** an IBKR field — IBKR only provides raw implied volatility as a live value. IV Rank is computed by us from accumulated/backfilled `implied_volatility` history, not stored as a captured value directly. Displayed with a labeled lookback window that grows toward 252 trading days over time (see IV Rank display decision above) — not hidden until a full year exists.
- **job_runs** — `id, job_name, started_at, finished_at, status (running/success/failure), error_message, details (jsonb)`. Backs the System Health screen and Telegram failure alerts; will be expanded when we design item 7.
- **strategy_settings** — `id, strategy_key, delta_target_min, delta_target_max, dte_target_min, dte_target_max, max_position_pct_of_portfolio, max_aggregate_collateral_pct, max_concentration_per_ticker_pct, max_concentration_per_sector_pct, min_cash_reserve_pct, updated_at`. Backs the Risk & Limits screen's per-strategy configuration and constrains what Opportunities is allowed to suggest. Candidate fields sourced from cross-checked practitioner guidance (Schwab, options-education sources, CBOE's BXM/PUT systematic index rules) — **actual numeric values are the user's call and require explicit sign-off before implementation**, same as any other formula.

## Built
(nothing yet)

## Screen list (finalized, 7 screens + shared modals)

General (cross-strategy):
1. **Dashboard** — aggregate P&L (day/week/month/year), realized vs unrealized, grand total + per-strategy subtotal breakdown.
2. **Positions** — open (and closed, filterable) positions table, strategy badges + filter dropdown; "+ New Position" for manual entry; row click opens Position Detail modal (chart, payoff diagram, max gain/loss, price targets, close triggers).
3. **Trade Blotter** — execution history, realized P&L, filterable by strategy/ticker/date.
4. **System Health** — job run history, per-module status (FX/prices/option-chain/etc.), mirrors Telegram alerts.
5. **Risk & Limits** — current exposure (buying power used, concentration by ticker/sector, correlated-assignment risk) + per-strategy threshold settings (`strategy_settings`) that constrain what Opportunities can suggest.

Strategy-specific (strategy selectable via tabs within the screen):
6. **Screener & Shortlist** — "Screener" tab (candidates ranked by suitability), "Shortlist" tab (curated/monitored list, add/remove).
7. **Opportunities** (renamed from "Trade Approval Queue") — ranked trade suggestions from the shortlist, full detail, inline approve/reject/modify. No separate approval-queue screen.

Shared modals (not standalone screens):
- **Ticker Detail modal** — fundamental data (via IBKR `reqFundamentalData`) + our own lightweight-charts candlestick chart with position markers, accessible from any screen showing a ticker.
- **Position Detail modal** — chart, payoff diagram, price targets, close triggers.

## Optional / future ideas (not being built unless requested)
- Full historical backtesting engine using purchased historical options data (10 years) — cost/ToS permitting. Lightweight forward-simulation backtesting (self-accumulated data only) is now planned, not optional — see Decisions made.
- IBKR chart embedding for open positions — superseded by the decision to build our own via lightweight-charts.
